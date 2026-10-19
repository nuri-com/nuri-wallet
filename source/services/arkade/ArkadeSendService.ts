// Prod-tier service: outgoing Bitcoin onchain sends from the arkade wallet.
// The flow is a native Ark collaborative exit — `Ramps.offboard` hands the
// recipient address to the Ark server, which settles the VTXOs into an onchain
// output inside its batch. No swap provider is involved, and the onchain fee is
// deducted from the offboarded amount, so the user needs no onchain balance.
//
// Cross-cutting helpers (emitTrace, truncateForLog, getOrCreateWallet,
// withTimeout, etc.) are imported back from the legacy debug service during the
// prod/debug migration.

import { ArkAddress, DustChangeError, Ramps, SettlementEventType } from "@arkade-os/sdk";
import { bytesToHex } from "../../lib/crypto";
import { errMsg } from "../../lib/errorMessage";
import { shortTime } from "../../lib/logShared";
import { withOutgoingBrowserApproval } from "./internal/browserApproval";
import {
  clearPendingBatchCommitmentTx,
  setPendingBatchCommitmentTx,
} from "./internal/batchCommitment";
import { emitTrace, logArkadeWalletSignTrace } from "./internal/logging";
import { ArkadeMaxSendAmountError } from "./internal/maxSendAmount";
import { fetchArkNodeInfoWithRetry } from "./internal/network";
import { assertArkadeRecoveryCsvCompatible } from "./internal/recovery";
import {
  ArkadeVtxoTooFreshError,
  latestVtxoExpiryMs,
  parseSettlementMinExpiryGapMs,
} from "./internal/settlementExpiryGap";
import {
  getSettlementMinExpiryGapMs,
  partitionVtxosBySettleability,
  rememberSettlementMinExpiryGapMs,
} from "./internal/vtxoSettleability";
import { grossUpOffboardSats } from "./internal/offboardGrossUp";
import {
  assertMeetsVtxoMinimum,
  requireVtxoMinimumSats,
  vtxoMinimumSatsOrNull,
} from "./internal/sendMinimums";
import { createArkadeServerSwapIntent } from "./internal/swapIntents";
import { truncateForLog } from "./internal/utils";
import { getOrCreateWallet } from "./internal/walletCache";
import { ensureSettlementMinExpiryGapMs } from "./ArkadeApiService";
import { arkadeServerConfigService } from "./ArkadeServerConfigService";
import { loadArkadeWalletSummary } from "./ArkadeWalletService";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function spendableVtxoBalance(vtxosRaw: unknown): number {
  if (!Array.isArray(vtxosRaw)) return Number.NaN;
  return vtxosRaw.reduce((sum, coin) => {
    if (!isRecord(coin) || coin.isSpent === true) return sum;
    const value = Number(coin.value);
    return Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);
}

// Server-declared onchain-output floor. An offboard creates a real onchain UTXO,
// so the Ark server rejects anything below `utxoMinAmount` (330 sats on mainnet
// today; it was 3,000 and the server moves it). Read live rather than hardcoded.
const ARKADE_OFFBOARD_FALLBACK_MIN_SATS = 3000;

/**
 * The smallest offboard the server will accept, read live.
 *
 * The floor applies to the RECEIVER's output, and `grossUpOffboardSats` already
 * adds the onchain output fee on top of it, so this is `utxoMinAmount` alone.
 * A UI that states a hardcoded figure goes stale the moment the server moves —
 * it moved from 3000 to 330 without anything here changing.
 */
export async function getArkadeOnchainSendMinimumSats(): Promise<number> {
  const info = await fetchArkNodeInfoWithRetry(
    arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, ""),
  ).catch((): null => null);
  const serverMinSats = toSatsNumber(info?.utxoMinAmount);
  return Number.isFinite(serverMinSats) && serverMinSats > 0
    ? Math.trunc(serverMinSats)
    : ARKADE_OFFBOARD_FALLBACK_MIN_SATS;
}

/**
 * The smallest ark-to-ark send the node accepts (its `vtxoMinAmount`), read
 * live, or null when the node cannot be read. The send itself re-reads it and
 * fails closed, so null only means the screen has no figure to state.
 */
export async function getArkadeArkSendMinimumSats(): Promise<number | null> {
  const info = await fetchArkNodeInfoWithRetry(
    arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, ""),
  ).catch((): null => null);
  return vtxoMinimumSatsOrNull(info);
}

/**
 * `Ramps.offboard()` settles every VTXO `wallet.getVtxos()` reports, and one
 * too-fresh VTXO makes the server refuse the entire settlement. There is no way
 * to hand it a subset, so the wallet it reads is wrapped: same object, same
 * `settle`/`getAddress`, but `getVtxos` answers with the settleable ones only.
 * All fee, change and dust logic stays in the SDK.
 */
function settleableWalletFacade<T extends { getVtxos: (...args: unknown[]) => Promise<unknown> }>(
  wallet: T,
): T {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop !== "getVtxos") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const vtxos = await target.getVtxos(...args);
        const { settleable } = partitionVtxosBySettleability(
          vtxos as ReadonlyArray<Record<string, unknown>>,
        );
        return settleable;
      };
    },
  }) as T;
}

function toSatsNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export type ArkadeOnchainSendResult = {
  txid: string;
  /** What the offboard actually debits from the arkade balance: the receiver
   * amount grossed up with the on-chain output fee. Callers that anchor the
   * outgoing balance must use this, not the receiver amount. */
  offboardSats: number;
};

export async function sendArkadeBitcoinOnchain(params: {
  address: string;
  amountSats: number;
  /** Fires after preflight and approval, immediately before the offboard is
   * submitted — the irreversible boundary (see sendArkadeToArk). */
  onBeforeBroadcast?: () => void | Promise<void>;
}): Promise<ArkadeOnchainSendResult> {
  const address = String(params.address || "").trim();
  const amountSats = Number(params.amountSats);

  if (!address) {
    throw new Error("recipient address required");
  }
  // No floor of our own: the Ark server states dust and the offboard's output
  // fee, and it refuses what it cannot accept with those exact numbers. A
  // second figure here would only ever disagree with it.
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new Error("amount_sats must be positive");
  }

  const startedAtMs = Date.now();
  const sats = Math.trunc(amountSats);
  logArkadeWalletSignTrace("send_bitcoin_onchain_entry", {
    sats,
    recipient: truncateForLog(address, 90),
    expected_next: "collaborative_exit_offboard",
  });
  emitTrace({
    atMs: startedAtMs,
    op: "send_bitcoin_onchain",
    status: "attempt",
    detail: `sats=${sats} recipient=${truncateForLog(address, 90)}`,
  });
  let stage = "init";
  try {
    const wallet = await getOrCreateWallet();
    await assertArkadeRecoveryCsvCompatible(wallet, "send_bitcoin_onchain");

    stage = "read_server_info";
    const providerInfo = await fetchArkNodeInfoWithRetry(
      arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, ""),
    ).catch((): null => null);
    const feeInfo = providerInfo?.fees;
    if (!feeInfo) {
      throw new Error("arkade_offboard_missing_fee_info");
    }
    const serverMinSats = toSatsNumber(providerInfo?.utxoMinAmount);
    const minReceiveSats =
      Number.isFinite(serverMinSats) && serverMinSats > 0
        ? Math.trunc(serverMinSats)
        : ARKADE_OFFBOARD_FALLBACK_MIN_SATS;
    logArkadeWalletSignTrace("send_bitcoin_onchain_minimum_check", {
      status: "ok",
      sats,
      min_receive_sats: minReceiveSats,
      min_source: Number.isFinite(serverMinSats) && serverMinSats > 0 ? "server" : "fallback",
      expected_next: sats >= minReceiveSats ? "check_available_balance" : "surface_minimum_error",
    });
    if (sats < minReceiveSats) {
      throw new Error(
        `ark_to_btc_amount_below_minimum requested=${sats} min_receive_sats=${minReceiveSats}`,
      );
    }

    stage = "check_balance";
    // The onchain fee is deducted from the offboard amount, so the wallet only
    // has to hold the requested sats — no separate funding amount as with the
    // former chain swap.
    // `wallet.getBalance()` also waits for boarding UTXOs and pending-recovery
    // storage. Neither can fund an offboard, and either can block this preflight.
    // Match `Ramps.offboard()` instead: only unspent VTXOs are spendable here.
    await ensureSettlementMinExpiryGapMs();
    const allVtxos = await wallet.getVtxos();
    // A VTXO the server would refuse as too fresh cannot fund this send, so it
    // must not count towards the maximum offered either — otherwise the user is
    // shown an amount that fails at settlement.
    const { settleable, tooFresh, tooFreshSats } = partitionVtxosBySettleability(allVtxos);
    if (tooFresh.length > 0) {
      logArkadeWalletSignTrace("send_bitcoin_onchain_vtxo_filter", {
        status: "ok",
        vtxos_total: Array.isArray(allVtxos) ? allVtxos.length : 0,
        vtxos_settleable: settleable.length,
        vtxos_too_fresh: tooFresh.length,
        too_fresh_sats: tooFreshSats,
        min_expiry_gap_ms: getSettlementMinExpiryGapMs() ?? "unknown",
        expected_next: "offboard_settleable_only",
      });
    }
    const availableSats = spendableVtxoBalance(settleable);
    if (Number.isFinite(availableSats) && availableSats < sats) {
      const maxAmountSats = Math.max(0, Math.trunc(availableSats));
      logArkadeWalletSignTrace("send_bitcoin_onchain_max_amount_hint", {
        status: "available",
        requested_sats: sats,
        available_sats: maxAmountSats,
        max_amount_sats: maxAmountSats,
        expected_next: "ui_sets_max_amount_before_passkey",
      });
      throw new ArkadeMaxSendAmountError(maxAmountSats);
    }

    // No pre-created intent. `settle()` signs a register-intent proof whose
    // outputs include this destination, so the approval flow derives the intent
    // from that PSBT — real script, real amount, matching the output the server
    // validates. Pre-building one here can only guess the amount.
    // What must ARRIVE is `sats`; the offboard has to spend that plus its own
    // output fee (see grossUpOffboardSats).
    const offboardSats = grossUpOffboardSats(sats, address, feeInfo);
    if (offboardSats > sats) {
      logArkadeWalletSignTrace("send_bitcoin_onchain_gross_up", {
        status: "ok",
        receiver_sats: sats,
        offboard_sats: offboardSats,
        output_fee_sats: offboardSats - sats,
        expected_next: "check_available_covers_gross_amount",
      });
    }
    if (Number.isFinite(availableSats) && availableSats < offboardSats) {
      // The fee pushed the send past the balance: offer the largest amount that
      // still arrives in full rather than letting the settle fail.
      const maxReceiverSats = Math.max(0, Math.trunc(availableSats - (offboardSats - sats)));
      logArkadeWalletSignTrace("send_bitcoin_onchain_max_amount_hint", {
        status: "available",
        requested_sats: sats,
        available_sats: Math.trunc(availableSats),
        max_amount_sats: maxReceiverSats,
        reason: "output_fee_exceeds_balance",
        expected_next: "ui_sets_max_amount_before_passkey",
      });
      throw new ArkadeMaxSendAmountError(maxReceiverSats);
    }

    stage = "offboard";
    logArkadeWalletSignTrace("send_bitcoin_onchain_wallet_ready", {
      sats,
      expected_next: "settle_vtxos_into_onchain_output",
    });
    const offboardStartedAtMs = Date.now();
    const txid = String(
      await withOutgoingBrowserApproval(
        {
          kind: "bitcoin_offboard",
          title: "Approve Bitcoin Send",
          recipient: address,
          amountSats: sats,
          finalAmountSats: sats,
          note: `Exits ${sats} sats to a Bitcoin address.`,
          source: "arkade",
          approvalScope: "direct_send_session",
        },
        async () => {
          await params.onBeforeBroadcast?.();
          return new Ramps(settleableWalletFacade(wallet)).offboard(
            address,
            feeInfo,
            BigInt(offboardSats),
            (event) => {
              // The batch's commitment transaction, straight from the Ark server.
              // The cosigner re-derives every tree message from it and refuses to
              // sign unless it pays this exact destination, so the tree round
              // cannot be steered — but it only ever reaches us here, in the
              // settle event stream.
              if (event?.type === SettlementEventType.TreeSigningStarted) {
                setPendingBatchCommitmentTx(String(event.unsignedCommitmentTx || ""));
              }
            },
          );
        },
        {
          detail: `flow=arkade.offboard kind=bitcoin_offboard requested=${sats} recipient=${truncateForLog(address, 90)}`,
        },
      ),
    );

    console.log(
      `🔐 [${shortTime()} ArkadeSendService.sendBitcoinOnchain] amount=${sats} txid=${txid ? `${txid.slice(0, 16)}...` : "n/a"} durMs=${Date.now() - startedAtMs}`,
    );
    logArkadeWalletSignTrace("send_bitcoin_onchain_result", {
      status: "ok",
      sats,
      txid: txid || "n/a",
      offboard_dur_ms: Date.now() - offboardStartedAtMs,
      dur_ms: Date.now() - startedAtMs,
      expected_next: "refresh_wallet_summary",
    });
    emitTrace({
      atMs: Date.now(),
      op: "send_bitcoin_onchain",
      status: "ok",
      id: txid || undefined,
      detail: `sats=${sats} txid=${txid || "n/a"} durMs=${Date.now() - startedAtMs}`,
    });
    await loadArkadeWalletSummary({
      scheduleAutoClaim: false,
      scheduleAutoSettle: false,
    })
      .then((summary) => {
        logArkadeWalletSignTrace("send_bitcoin_onchain_balance_refreshed", {
          status: "ok",
          txid: txid || "n/a",
          available: summary.balanceAvailableSats,
          total: summary.balanceTotalSats,
          expected_next: "ui_reads_new_summary",
        });
      })
      .catch((error: unknown) => {
        logArkadeWalletSignTrace("send_bitcoin_onchain_balance_refreshed", {
          status: "failed",
          txid: txid || "n/a",
          err: truncateForLog(errMsg(error, "unknown"), 160),
          expected_next: "ui_can_manual_refresh",
        });
      });

    return { txid, offboardSats };
  } catch (error: unknown) {
    // A dust-sized change VTXO is the one offboard rejection the caller can act
    // on: exiting the full balance leaves no change. Re-thrown as a typed max
    // hint so the UI offers that amount instead of a bare failure.
    if (error instanceof DustChangeError) {
      const availableSats = await getOrCreateWallet()
        .then((wallet) => wallet.getVtxos())
        .then(spendableVtxoBalance)
        .catch((): null => null);
      const maxAmountSats = Number.isFinite(availableSats)
        ? Math.max(0, Math.trunc(availableSats))
        : 0;
      logArkadeWalletSignTrace("send_bitcoin_onchain_result", {
        status: "failed",
        sats,
        stage,
        reason: "dust_change",
        change: String(error.change),
        dust_amount: String(error.dustAmount),
        max_amount_sats: maxAmountSats,
        dur_ms: Date.now() - startedAtMs,
        expected_next: "ui_offers_full_balance_exit",
      });
      emitTrace({
        atMs: Date.now(),
        op: "send_bitcoin_onchain",
        status: "failed",
        detail: `dust_change stage=${stage} sats=${sats} change=${error.change} dust=${error.dustAmount} maxAmountSats=${maxAmountSats}`,
      });
      throw new ArkadeMaxSendAmountError(maxAmountSats);
    }
    // The server rejects VTXOs that are still too far from expiry to settle.
    // Re-thrown as a typed error carrying when the offboard becomes possible, so
    // the UI can name the wait instead of showing the raw rejection.
    const minExpiryGapMs = parseSettlementMinExpiryGapMs(errMsg(error, ""));
    if (minExpiryGapMs !== null) {
      // The only place the gap is ever published. Persist it so the next send
      // and the balance can classify VTXOs BEFORE the server refuses one.
      await rememberSettlementMinExpiryGapMs(minExpiryGapMs);
      const expiryMs = await getOrCreateWallet()
        .then((wallet) => wallet.getVtxos())
        .then(latestVtxoExpiryMs)
        .catch((): null => null);
      const availableAtMs = expiryMs !== null ? Math.max(0, expiryMs - minExpiryGapMs) : 0;
      logArkadeWalletSignTrace("send_bitcoin_onchain_result", {
        status: "failed",
        sats,
        stage,
        reason: "vtxo_too_fresh_for_settlement",
        min_expiry_gap_ms: minExpiryGapMs,
        latest_vtxo_expiry_ms: expiryMs ?? "n/a",
        available_at_ms: availableAtMs,
        dur_ms: Date.now() - startedAtMs,
        expected_next: "ui_shows_retry_after_hint",
      });
      emitTrace({
        atMs: Date.now(),
        op: "send_bitcoin_onchain",
        status: "failed",
        detail: `vtxo_too_fresh stage=${stage} sats=${sats} gapMs=${minExpiryGapMs} availableAtMs=${availableAtMs}`,
      });
      throw new ArkadeVtxoTooFreshError(availableAtMs);
    }
    const failureDetail = truncateForLog(errMsg(error, "unknown"), 220);
    logArkadeWalletSignTrace("send_bitcoin_onchain_result", {
      status: "failed",
      sats,
      stage,
      dur_ms: Date.now() - startedAtMs,
      err: failureDetail,
      expected_next: "ui_shows_error",
    });
    emitTrace({
      atMs: Date.now(),
      op: "send_bitcoin_onchain",
      status: "failed",
      detail: `stage=${stage} sats=${sats} durMs=${Date.now() - startedAtMs} err=${failureDetail}`,
    });
    throw error;
  } finally {
    // Belongs to this batch only. A commitment left behind would be offered as
    // the next send's batch material, where the server would reject it — after
    // the user had already approved.
    clearPendingBatchCommitmentTx();
  }
}

// Prod-tier ark → ark offchain send. The recipient already holds an Ark
// address, so there is no swap: we arm a browser approval and hand the send to
// the offchain wallet directly. Lifted verbatim from the legacy debug
// `send_ark` flow so debug and prod share one implementation.
export async function sendArkadeToArk(params: {
  address: string;
  amountSats: number;
  /** Fires AFTER every preflight and AFTER the user approves, immediately
   * before `wallet.send` — the irreversible boundary. A failed preflight or a
   * cancelled approval never reaches it, so a caller recording "may have sent"
   * here is never stranded by a refusal that moved nothing. */
  onBeforeBroadcast?: () => void | Promise<void>;
  /** Fires once the send's transaction is signed (after the passkey), before
   * the SDK submits it. See ArmSpendApprovalSummary.onSigned. */
  onSigned?: (txid: string) => void | Promise<void>;
}): Promise<string> {
  const address = String(params.address || "").trim();
  const amountSats = Number(params.amountSats);

  if (!address) {
    throw new Error("recipient address required");
  }
  // No floor of our own: the Ark server states dust and the offboard's output
  // fee, and it refuses what it cannot accept with those exact numbers. A
  // second figure here would only ever disagree with it.
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new Error("amount_sats must be positive");
  }

  const startedAtMs = Date.now();
  const sats = Math.trunc(amountSats);
  logArkadeWalletSignTrace("send_ark_entry", {
    sats,
    recipient: truncateForLog(address, 90),
    expected_next: "get_wallet_then_browser_approval",
  });
  emitTrace({
    atMs: startedAtMs,
    op: "send_ark",
    status: "attempt",
    detail: `sats=${sats} recipient=${truncateForLog(address, 90)}`,
  });
  try {
    const wallet = await getOrCreateWallet();
    logArkadeWalletSignTrace("send_ark_wallet_ready", {
      sats,
      expected_next: "wallet_send_requests_signatures",
    });
    const decoded = ArkAddress.decode(address);
    if (decoded.hrp !== wallet.network.hrp) {
      throw new Error(
        `ark address network mismatch: expected ${wallet.network.hrp}, got ${decoded.hrp}`,
      );
    }
    await assertArkadeRecoveryCsvCompatible(wallet, "send_ark");
    // The node's own floor, checked BEFORE an intent exists and before the user
    // is asked to approve anything. `wallet.send` would refuse the same amount
    // moments later, but by then the approval has been armed and a passkey
    // prompt has been spent on a send that could never go out. Fail closed when
    // the node cannot be read: an unknown floor is not a floor of zero, and the
    // offboard path already refuses on the same missing information.
    const nodeInfo = await fetchArkNodeInfoWithRetry(
      arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, ""),
    ).catch((): null => null);
    const minVtxoSats = requireVtxoMinimumSats(nodeInfo);
    logArkadeWalletSignTrace("send_ark_minimum_check", {
      status: "ok",
      sats,
      min_vtxo_sats: minVtxoSats,
      expected_next: sats >= minVtxoSats ? "create_swap_intent" : "surface_minimum_error",
    });
    assertMeetsVtxoMinimum(sats, minVtxoSats);
    const swapIntentId = await createArkadeServerSwapIntent({
      kind: "ark_send",
      finalRecipient: address,
      finalAmountSats: sats,
      fundingAddress: address,
      fundingAmountSats: sats,
      op: "send_ark",
    });
    const txid = String(
      await withOutgoingBrowserApproval(
        {
          kind: "bitcoin_send",
          title: "Approve Ark Send",
          recipient: address,
          amountSats: sats,
          finalAmountSats: sats,
          note: "Browser approval required for outgoing Ark spends.",
          source: "arkade",
          approvalScope: "direct_send_session",
          swapIntentId,
          ...(params.onSigned ? { onSigned: params.onSigned } : {}),
        },
        async () => {
          await params.onBeforeBroadcast?.();
          return wallet.send({
            address,
            amount: sats,
          });
        },
      ),
    );

    console.log(
      `🔐 [${shortTime()} ArkadeSendService.sendArk] amount=${sats} txid=${txid ? `${txid.slice(0, 16)}...` : "n/a"} durMs=${Date.now() - startedAtMs}`,
    );
    logArkadeWalletSignTrace("send_ark_result", {
      status: "ok",
      sats,
      txid: txid || "n/a",
      dur_ms: Date.now() - startedAtMs,
      expected_next: "refresh_wallet_summary",
    });
    emitTrace({
      atMs: Date.now(),
      op: "send_ark",
      status: "ok",
      id: txid || undefined,
      detail: `sats=${sats} txid=${txid || "n/a"} durMs=${Date.now() - startedAtMs}`,
    });
    await loadArkadeWalletSummary({
      scheduleAutoClaim: false,
      scheduleAutoSettle: false,
    })
      .then((summary) => {
        logArkadeWalletSignTrace("send_ark_balance_refreshed", {
          status: "ok",
          txid: txid || "n/a",
          available: summary.balanceAvailableSats,
          total: summary.balanceTotalSats,
          expected_next: "ui_reads_new_summary",
        });
      })
      .catch((error: unknown) => {
        logArkadeWalletSignTrace("send_ark_balance_refreshed", {
          status: "failed",
          txid: txid || "n/a",
          err: truncateForLog(errMsg(error, "unknown"), 160),
          expected_next: "ui_can_manual_refresh",
        });
      });

    return txid;
  } catch (error: unknown) {
    logArkadeWalletSignTrace("send_ark_result", {
      status: "failed",
      sats,
      dur_ms: Date.now() - startedAtMs,
      err: truncateForLog(errMsg(error, "unknown"), 180),
      expected_next: "ui_shows_error",
    });
    emitTrace({
      atMs: Date.now(),
      op: "send_ark",
      status: "failed",
      detail: `sats=${sats} durMs=${Date.now() - startedAtMs} err=${truncateForLog(errMsg(error, "unknown"), 180)}`,
    });
    throw error;
  }
}

/**
 * Fund an Arkade Intents covenant lockup and return the EXACT created VTXO
 * outpoint {txid, vout}. The v2 `arkade_intents_fund` action requires the exact
 * outpoint, not just the txid: the server verifies it against the Arkade
 * indexer (the funding VTXO's script must rebuild the covenant lockup and its
 * amount must equal the covenant amount), so guessing vout:0 would strand the
 * funds. We send to the lockup address, then resolve the created VTXO by
 * querying the indexer for the lockup's own script and matching the funding
 * txid — the vout is whatever index the send actually produced.
 */
export async function fundArkadeIntentsOutpoint(params: {
  lockupAddress: string;
  amountSats: number;
  fundingTxid?: string;
  reconcileOnly?: boolean;
  /** Forwarded to sendArkadeToArk: fires after its preflight and approval,
   * immediately before the covenant is funded. Never fires on reconcileOnly. */
  onBeforeBroadcast?: () => void | Promise<void>;
}): Promise<{ arkTxid: string; outpoint: { txid: string; vout: number } }> {
  const lockupAddress = String(params.lockupAddress || "").trim();
  if (!lockupAddress) throw new Error("arkade_intents_fund lockup address is required");
  const amountSats = Math.trunc(Number(params.amountSats));
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error("arkade_intents_fund amountSats must be a positive integer");
  }

  const arkTxid =
    params.fundingTxid ||
    (params.reconcileOnly
      ? ""
      : await sendArkadeToArk({
          address: lockupAddress,
          amountSats,
          onBeforeBroadcast: params.onBeforeBroadcast,
        }));
  if (arkTxid && !/^[0-9a-f]{64}$/.test(arkTxid)) {
    throw new Error(`arkade_intents_fund produced a non-canonical txid: ${arkTxid}`);
  }

  // Resolve the exact created outpoint from the indexer by the lockup's own
  // script. The wallet exposes the same indexerProvider the recovery probe uses.
  const wallet = (await getOrCreateWallet()) as unknown as {
    indexerProvider?: {
      getVtxos: (opts: { scripts: string[] }) => Promise<{
        // The indexer normalizes VTXOs to TOP-LEVEL txid / vout / value — the
        // same shape SwapKitArkadeVhtlcService and arkade/internal/vtxoFormat
        // consume. (NOT the nested `outpoint`/`amount` PSBT-input shape.)
        vtxos?: Array<{ txid?: string; vout?: number; value?: string | number }>;
      }>;
    };
  };
  const indexer = wallet.indexerProvider;
  if (!indexer || typeof indexer.getVtxos !== "function") {
    throw new Error("arkade_intents_fund cannot resolve its outpoint: indexer unavailable");
  }
  const lockupScriptHex = bytesToHex(ArkAddress.decode(lockupAddress).pkScript);
  const res = await indexer.getVtxos({ scripts: [lockupScriptHex] });
  const candidates = (res.vtxos ?? []).filter(
    (v) => (!arkTxid || String(v.txid || "") === arkTxid) && Number(v.value) === amountSats,
  );
  const created = candidates.length === 1 ? candidates[0] : null;
  if (!created || !Number.isSafeInteger(Number(created.vout))) {
    throw new Error(
      "arkade_intents_fund could not confirm the created outpoint at the lockup script",
    );
  }
  return {
    arkTxid: String(created.txid),
    outpoint: { txid: String(created.txid), vout: Number(created.vout) },
  };
}
