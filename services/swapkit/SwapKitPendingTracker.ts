import { BASE_EURC, BASE_USDC } from "../../config/network";
import { isValidBitcoinAddressMainnet } from "../../lib/bitcoin/address";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import {
  getBaseMainnetErc20Balance,
  getBaseTransactionOutcome,
  sendTokenOnBase,
  signCowOrderOnBase,
  signAndBroadcastBaseMainnetTx,
} from "../base/BaseTokenTransferService";
import { getErc20BalanceUnits } from "../balance/MultiCurrencyBalanceService";
import { EventBus } from "../events/AppEventBusService";
import { PendingPurchasesStore } from "../app/PendingPurchasesStore";
import { PendingWalletTransfersStore } from "../balance/PendingWalletTransfersStore";
import type { PendingWalletTransfer } from "../../types/wallet";
import { restoreSwapKitRecoverySnapshotFromNostr } from "../nostr/NostrBackupService";
import { handleSwapKitHtlcAction } from "./SwapKitHtlcActionService";
import { handleSwapKitArkadeAction } from "./SwapKitArkadeActionService";
import { isUnfundedSweepIntent, SwapKitOrderStore, type SwapKitOrder } from "./SwapKitOrderStore";
import { hasRecordedSignedDeposit, settleRecordedDeposit } from "./SwapKitRecordedDeposit";
import { blockchainService } from "../bitcoin/BlockchainService";
import { signAndBroadcastSwapKitEvmTx, SWAPKIT_SWEEP_CHAIN_IDS } from "./SwapKitEvmSigner";
import {
  claimSwapLoop,
  describeSwapKitPhase,
  getPendingBtcPayoutConfirmation,
  isTerminal,
  listSwapKitSwaps,
  releaseSwapLoop,
  runSwapKitSwapLoop,
  SWAPKIT_INPUT_DRIFT_MULTIPLIER,
  trackSwapKitSwap,
  type ParsedSwapActionTx,
  type SwapKitTrackResponse,
} from "./SwapKitService";
import { assertCowLegBelongsToRoute } from "./SwapKitCowLeg";
import { DIRECT_SWAP_SETTLED_EVENT, resumeDirectEvmSwaps } from "./SwapKitDirectEvmSwapService";
import { SwapKitDirectSwapStore, listAbandonedSwapOrders } from "./SwapKitDirectSwapStore";
import { recoverStrandedUsdc } from "./SwapKitUsdcRecoveryService";
import {
  acceptedRecoveryQuote,
  hasRecoveryConsent,
  isCurrentRateRecoveryRoute,
  recoveryPayoutProven,
} from "./SwapKitRecoveryService";
import type { ParsedSwapTypedDataAction } from "./SwapKitService";

async function signRecoveryCow(order: SwapKitOrder, parsed: ParsedSwapTypedDataAction) {
  const quote = await acceptedRecoveryQuote(order);
  if (!quote) throw new Error("Recovery requires explicit acceptance.");
  return signCowOrderOnBase(
    parsed,
    {
      sellToken: BASE_USDC.address,
      buyToken: BASE_EURC.address,
      receiver: evmAddress(quote.recipient, "accepted receiver"),
      maxSellAmount: BigInt(quote.maximumSellUsdcUnits),
      minBuyAmount: BigInt(quote.minimumReceiveUnits),
    },
    quote.owner,
  );
}

// Durable, self-healing tracker for EURC→BTC SwapKit swaps. Each order runs one
// poll loop that DEREGISTERS itself from the shared claim registry on exit
// (terminal, exhausted poll budget, or thrown error). A provider-paid BTC payout
// that is still awaiting its first confirmation verifies that the durable wallet
// row exists, then re-arms after the normal poll interval. Structural/action
// errors keep their loop retry limits. The registry lives in SwapKitService and
// is shared with the foreground topup loop so one order can never run two signers.

export function emitSwapRefresh(): void {
  for (const event of ["wallet:refresh", "transactions:refresh", "bitcoin:refresh"] as const) {
    try {
      EventBus.emit(event);
    } catch {}
  }
}

// Last honest server statement per live order ("where is the money right
// now?"), for the pending row's subtitle. In-memory only — the server resends
// funds/trackError on every swap_track, so nothing needs persisting.
const statusMessages = new Map<string, string>();
// Full last track response per live order — the swap detail sheet renders
// legs/funds from it without a second network path.
const lastStatuses = new Map<string, SwapKitTrackResponse>();

export function getSwapKitLastStatus(orderId: string): SwapKitTrackResponse | null {
  return lastStatuses.get(orderId) ?? null;
}

// Clears BOTH pending-row surfaces for a topup order: the Bitcoin-origin row
// (PendingPurchasesStore) and the euro-destination row (wallet pending list).
// Both are no-ops when the order never wrote that surface. Only call once the
// order is COMPLETED or recovery has proven it settled — never before, or the
// user loses the only live status for funds still in flight.
/**
 * A Bitcoin → card order is over: announce its outcome the way a direct swap does, so the credit the
 * card showed is kept (delivered) or taken back (nothing arrived) at once rather than at its expiry.
 * Wallet orders owe the card nothing; a missing destination is a legacy card row.
 */
function announceCardSettlement(
  order: { txId: string; destination?: "card" | "wallet" },
  ok: boolean,
): void {
  if (order.destination === "wallet") return;
  try {
    EventBus.emit(DIRECT_SWAP_SETTLED_EVENT, { txId: order.txId, destination: "card", ok });
  } catch {}
}

async function clearSwapKitPendingRow(order: {
  txId: string;
  destination?: "card" | "wallet";
}): Promise<void> {
  // Await the persisted removal so the order is never considered "cleared" while
  // the TTL-exempt Bitcoin row's write is still in flight — a crash in that
  // window (after the durable order is gone) would orphan the row forever.
  await PendingPurchasesStore.remove(order.txId).catch(() => {});
  try {
    EventBus.emit("wallet:clearPendingTransfer", { txHash: null, orderId: order.txId });
  } catch {}
  // A card top-up settles EURC into the Wirex account — refresh the displayed
  // card balance now that funds have arrived. emitSwapRefresh covers
  // wallet/bitcoin/transactions but not the card, and the only card refresh so
  // far fired at handoff, before background settlement completed. A missing
  // destination means a legacy row, which SwapKitOrder documents as "card".
  if (order.destination !== "wallet") {
    try {
      EventBus.emit("card:refreshBalance");
    } catch {}
  }
}

export function noteStatusMessage(orderId: string, status: SwapKitTrackResponse): void {
  lastStatuses.set(orderId, status);
  // Eligibility can change while the human-readable message stays identical.
  EventBus.emit("swapkit:trackUpdated");
  // Live phase first (T5/T6), then the server's honest funds statement; a
  // track refresh failure is appended, never shown alone as a scary "failed".
  const message = [describeSwapKitPhase(status) ?? status.funds?.userMessage, status.trackError]
    .filter(Boolean)
    .join(" · ");
  if (!message || statusMessages.get(orderId) === message) return;
  statusMessages.set(orderId, message);
  try {
    EventBus.emit("transactions:refresh");
  } catch {}
}

const evmAddress = (value: unknown, field: string): `0x${string}` => {
  const address = String(value || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`SwapKit is missing ${field}.`);
  return address as `0x${string}`;
};

const tokenUnits = (amount: number, rounding: "ceil" | "floor"): bigint => {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("SwapKit amount bound is invalid.");
  const scaled = amount * 10 ** BASE_USDC.decimals;
  return BigInt(rounding === "ceil" ? Math.ceil(scaled) : Math.floor(scaled));
};

export function startSwapKitPendingTracking(
  orderId: string,
  txHash: string | null,
  maxSellEurc?: number,
  confirmationTailKnown = false,
): void {
  // Direct-journal ownership wins at the final synchronous claim boundary.
  if (SwapKitDirectSwapStore.list().some((row) => row.txId === orderId)) return;
  if (!claimSwapLoop(orderId)) return;
  void (async () => {
    let shouldResume = false;
    let confirmationTailObserved = confirmationTailKnown;
    try {
      // Same loop as every other swap: polls to terminal and — should the server
      // ever route this direction through a signable leg — signs the fresh
      // action instead of silently stalling. The deposit hash is re-reported on
      // every poll (this direction has no signable leg) so a transient failure of
      // the initial report can't leave SwapKit without it.
      const result = await runSwapKitSwapLoop(orderId, {
        depositTxHash: txHash,
        onUpdate: (status) => {
          if (getPendingBtcPayoutConfirmation(status)) confirmationTailObserved = true;
          noteStatusMessage(orderId, status);
        },
        handleHtlcAction: handleSwapKitHtlcAction,
        handleArkadeAction: handleSwapKitArkadeAction,
        signAction: (parsed) =>
          signAndBroadcastBaseMainnetTx({
            ...parsed,
            ...(maxSellEurc != null && maxSellEurc > 0
              ? {
                  maxApprovalUnits: tokenUnits(
                    maxSellEurc * SWAPKIT_INPUT_DRIFT_MULTIPLIER,
                    "ceil",
                  ),
                }
              : {}),
          }),
        ...(maxSellEurc != null && maxSellEurc > 0
          ? {
              signTypedData: (parsed, status) => {
                const requiredHubAmount =
                  status.assist?.requiredHubAmount != null
                    ? Number(status.assist.requiredHubAmount)
                    : Number.NaN;
                // Fail closed exactly like the create-time path
                // (StableToBtcSwapService): a missing/zero hub amount is not "no
                // minimum" — it skips the min-USDC floor entirely and would sign
                // a resumed CoW order with no bound on what comes back. Refusing
                // costs a resume that retries next tick; nothing is in flight.
                if (!(Number.isFinite(requiredHubAmount) && requiredHubAmount > 0)) {
                  throw new Error(
                    "SwapKit did not state the minimum hub amount for this resumed CoW order.",
                  );
                }
                return signCowOrderOnBase(parsed, {
                  sellToken: BASE_EURC.address,
                  buyToken: BASE_USDC.address,
                  receiver: evmAddress(status.assist?.providerDeposit, "provider deposit"),
                  maxSellAmount: tokenUnits(maxSellEurc * SWAPKIT_INPUT_DRIFT_MULTIPLIER, "ceil"),
                  minBuyAmount: tokenUnits(requiredHubAmount, "floor"),
                });
              },
            }
          : {}),
      });
      // Clear the pending row + refresh once, when the loop settles at a terminal
      // status. A non-terminal exit (exhausted poll budget) leaves the row for
      // the resumer to restart on its next tick.
      if (isTerminal(result)) {
        console.log(
          `[SwapKitPendingTracker] terminal, clearing pending row order=${orderId} status=${result.status || "?"}`,
        );
        try {
          EventBus.emit("wallet:clearPendingTransfer", { txHash, orderId });
        } catch {}
        // Mirror row on the bitcoin side (PendingPurchasesStore, keyed by
        // orderId) — remove is a no-op when no row exists.
        void PendingPurchasesStore.remove(orderId).catch(() => {});
        emitSwapRefresh();
      } else {
        // Only the read-only L1 confirmation tail may exceed the loop budget.
        // Re-arming any other exhausted path resets its signing retry counters
        // and can repeat a structurally invalid wallet action forever.
        shouldResume = Boolean(getPendingBtcPayoutConfirmation(result));
        console.log(
          `[SwapKitPendingTracker] poll budget exhausted, row kept for resume order=${orderId}`,
        );
      }
    } catch (e) {
      // Five transport failures after we have already entered the read-only BTC
      // confirmation tail are transient tracking loss, not a signing retry. A
      // structural/action failure before that point keeps the loop's retry cap.
      shouldResume = confirmationTailObserved;
      console.log(
        `[SwapKitPendingTracker] tracking error order=${orderId} err=${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      releaseSwapLoop(orderId);
      if (shouldResume) {
        setTimeout(() => {
          void PendingWalletTransfersStore.list()
            .then((rows) => {
              const persisted = rows.find(
                (row) =>
                  String(row.orderId || "") === orderId &&
                  String(row.source || "").startsWith("swapkit"),
              );
              // The user may have cleared the row or logged out while this timer
              // was waiting. Durable visibility is also the authority to resume.
              if (!persisted) return;
              const cap = Number(persisted.maxSellEurc);
              startSwapKitPendingTracking(
                orderId,
                persisted.txHash ?? txHash,
                Number.isFinite(cap) && cap > 0 ? cap : maxSellEurc,
                true,
              );
            })
            .catch(() => {});
        }, 12_000);
      }
    }
  })();
}

export function resumeSwapKitPendingTracking(
  rows: ReadonlyArray<{
    orderId?: string | null;
    txHash?: string | null;
    source?: string | null;
    amount?: number | null;
    maxSellEurc?: number | null;
  }>,
): void {
  for (const row of rows) {
    if (row.source !== "swapkit") continue;
    const orderId = row.orderId ? String(row.orderId).trim() : "";
    if (!orderId) continue;
    // ONLY the quote-time cap may bound a resumed signature. `amount` is what
    // already left — up to quote x 1.05 — and the signing paths apply the drift
    // multiplier themselves, so resuming from it would authorize quote x 1.05^2
    // (21 EURC accepted at 21.213563 would resume at 22.274, past the 22.05
    // ceiling the quote allowed). A row without the cap resumes unbounded-by-
    // amount, exactly as before this field existed, rather than with a wrong one.
    const cap = Number(row.maxSellEurc);
    startSwapKitPendingTracking(
      orderId,
      row.txHash ?? null,
      Number.isFinite(cap) && cap > 0 ? cap : undefined,
    );
  }
}

// A repeatedly-failing USDC→EURC leg is retried up to this many times (SwapKit
// rebuilds the action on each resume); after that the order is escalated to
// direct USDC recovery.
const MAX_SIGNING_ATTEMPTS = 3;

// Same 1% headroom as the CoW binding: a router approval sits marginally above
// the delivered amount; a materially larger one is still refused.
// The server builds LI.FI approvals at depositAmount * 1.02 (its
// providers/lifi.mjs); a client ceiling below that refuses every rebuilt action
// forever — "Sweep approval exceeds the detected balance" — with nothing the
// user can do about it. Match the server exactly.
const APPROVAL_TOLERANCE = 1.02;

/**
 * The allowance ceiling for a sweep action.
 *
 * The claim-time value the user accepted is the HARD MAXIMUM: the calldata the
 * server builds is opaque to this wallet, so it must never be allowed to reach
 * tokens that arrived after the claim and were never shown on the sheet. A live
 * balance read can only NARROW that — it exists so a balance that has since been
 * spent down cannot leave a router approved for more than the wallet holds.
 *
 * Widening requires a fresh claim, which re-scans and re-asks the user.
 * Returns undefined when no accepted ceiling exists, which makes the signer
 * refuse the approval outright.
 */
async function liveApprovalCeiling(
  chainId: number,
  token: `0x${string}`,
  storedUnits: string,
): Promise<bigint | undefined> {
  const accepted = /^\d+$/.test(storedUnits) ? BigInt(storedUnits) : undefined;
  if (accepted == null) return undefined;
  try {
    const owner = await getEthereumAddress();
    if (!owner) return accepted;
    const units = await getErc20BalanceUnits(chainId, token, owner);
    // A read that SUCCEEDS and says zero is the narrowest live bound there is,
    // not a missing answer: approving anything then leaves an allowance standing
    // for tokens that arrive later, on a swap whose estimate is about to fail
    // anyway. Zero means zero — the signer refuses.
    if (units <= 0n) return 0n;
    // Integer math on the raw units — the headroom must not round a bigint
    // through a float. 102/100 is APPROVAL_TOLERANCE, kept as integers here.
    const live = (units * 102n) / 100n;
    return live < accepted ? live : accepted;
  } catch {
    // An RPC outage is not permission to widen, and not a reason to refuse a
    // ceiling the user already accepted.
    return accepted;
  }
}

/**
 * Server-side rejections that no retry can ever fix: the provider order is in
 * a state the wallet cannot influence (duplicate/consumed HTLC material, a
 * funding requirement above what the order ever delivered). Retrying these
 * forever is what filled the logs with red "Swap_wallet_submit failed" lines
 * on orders that hold no money. Recognize them, escalate once (which checks
 * for stranded funds), then drop the row.
 *
 * "refund destination does not match" is ours, not the server's — the local
 * address-binding check in SwapKitArkadeActionService. It is deterministic
 * (the same request fails identically every time) and it is the most serious
 * finding on that path: the server asked to send a refund somewhere other than
 * this order's bound address. Three silent retries followed by an anonymous
 * give-up is the wrong response to that. It belongs here so it escalates once
 * and stops. Issue #882.
 */
const UNRECOVERABLE_ORDER_ERRORS =
  /duplicate material|preimage hash exists already|funding needs [0-9]+ .* wallet has|refund destination does not match/i;

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  // API layers sometimes throw plain objects; String() would yield
  // "[object Object]" and hide the reason.
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
};

const isUnrecoverableOrderError = (error: unknown): boolean =>
  UNRECOVERABLE_ORDER_ERRORS.test(errorText(error));

// USDC this order actually delivered: the EOA's balance now, minus what it held
// before the invoice was paid, clamped to what the hub promised. Never the raw
// balance — a user may hold USDC of their own (a multi-currency balance), and a
// failed topup must not swap it. Returns 0 when nothing was delivered.
async function deliveredUsdc(order: SwapKitOrder): Promise<number> {
  const eoa = await getEthereumAddress();
  if (!eoa) throw new Error("Ethereum wallet address not available.");
  const balanceUnits = await getBaseMainnetErc20Balance(BASE_USDC.address, eoa as `0x${string}`);
  const baselineUnits = BigInt(order.usdcBaseline);
  const gainedUnits = balanceUnits > baselineUnits ? balanceUnits - baselineUnits : 0n;
  const gained = Number(gainedUnits) / 10 ** BASE_USDC.decimals;
  return order.expectedUsdc > 0 ? Math.min(gained, order.expectedUsdc) : gained;
}

// A dead card-topup order left USDC in the EOA. Swap exactly that USDC forward
// to EURC at the original settle target. On success the order is done; on
// failure it stays in the store so the next resume retries.
//
// Re-reads the order's live status first. The caller may be escalating because
// the loop THREW, and a thrown loop cannot distinguish a doomed signing leg from
// a transient swap_track outage. Moving USDC while the original order is still
// live would spend it twice. Recovery is therefore allowed only when the server
// says the order is dead, or when it is explicitly waiting on our signature —
// which is the server confirming the hub already delivered the USDC.
/**
 * Returns true when the order is SETTLED — recovered, completed, or proven to
 * hold nothing — i.e. its row may be dropped. Returns false when recovery did
 * not finish (transient track/swap failure): the row must survive so the next
 * hydrate can retry with the user-accepted bounds still intact.
 */
/**
 * Which stable the user accepted for this order. Legacy rows carry none and are
 * EURC by construction — that was the only target when they were written.
 */
function orderStable(order: SwapKitOrder): "EURC_BASE" | "USDC_BASE" {
  return order.stable === "USDC_BASE" ? "USDC_BASE" : "EURC_BASE";
}

/**
 * Put the delivered USDC where the accepted order said it would go.
 *
 * The hub always delivers to the EOA. For an order that settles THERE that is
 * the delivery and there is nothing to do — but a card order's accepted target
 * is the Wirex smart account, and retiring it at the EOA would leave the dollars
 * on the wallet with the card never funded and the pending row gone, which is
 * also the only path back.
 *
 * Returns false when the forward did not confirm: the order stays, and the next
 * hydrate re-measures. Re-measuring is what makes the retry safe — the figure is
 * the balance GAINED over the order's baseline, so a forward that did land
 * leaves nothing to send a second time.
 */
async function forwardDeliveredUsdc(order: SwapKitOrder, usdcAmount: number): Promise<boolean> {
  const target = String(order.settleTarget || "").trim();
  if (!target) return false;
  const eoa = await getEthereumAddress();
  if (!eoa) return false;
  if (target.toLowerCase() === eoa.toLowerCase()) return true;

  // A forward this order already sent. Until it has a receipt the EOA still
  // holds the dollars, so the balance says "nothing forwarded" and a second
  // broadcast would send the same money twice. The hash is the only thing that
  // knows better, which is why it is persisted the moment it exists.
  const inFlight = String(order.recovery?.forwardTxHash || "").trim();
  if (inFlight) {
    const outcome = await getBaseTransactionOutcome(inFlight as `0x${string}`);
    if (outcome === "pending") {
      console.log(
        `[SwapKitPendingTracker] usdc forward still pending order=${order.txId} tx=${inFlight}`,
      );
      return false;
    }
    if (outcome === "success") return true;
    // Reverted: the dollars never left, so this order may forward again. The
    // record goes first — a retry recorded under a dead hash would be read as
    // that hash's outcome.
    await SwapKitOrderStore.add({
      ...order,
      recovery: { ...(order.recovery ?? {}), forwardTxHash: undefined },
    });
  }

  if (!(usdcAmount > 0)) return true;
  // Floored to the token's own precision: rounding a balance UP asks to send
  // more than is there, and the transfer reverts.
  const sendable = Math.floor(usdcAmount * 10 ** BASE_USDC.decimals) / 10 ** BASE_USDC.decimals;
  if (!(sendable > 0)) return true;
  // Broadcast WITHOUT waiting: the hash has to be persisted before this function
  // can be interrupted, and awaiting a receipt first would leave a transaction
  // in flight that nothing has recorded.
  const { hash } = await sendTokenOnBase({
    toAddress: target as `0x${string}`,
    amount: sendable.toFixed(BASE_USDC.decimals),
    tokenAddress: BASE_USDC.address,
    tokenDecimals: BASE_USDC.decimals,
    awaitReceipt: false,
  });
  await SwapKitOrderStore.add({
    ...order,
    recovery: { ...(order.recovery ?? {}), forwardTxHash: hash },
  });
  const outcome = await getBaseTransactionOutcome(hash);
  // Anything but a mined success leaves the order standing. The next resume
  // reads the hash above and asks about THAT transaction instead of sending
  // another one.
  return outcome === "success";
}

async function escalateToRecovery(order: SwapKitOrder): Promise<boolean> {
  const short = order.txId;
  try {
    const status = await trackSwapKitSwap(order.txId);
    // Current-rate recovery stays on this order. Never create a replacement
    // swap or proportionally reduce the newly accepted fixed EURC floor.
    if (hasRecoveryConsent(order)) return recoveryPayoutProven(order, status);
    const label = String(status.status || "").toUpperCase();
    if (isTerminal(status)) {
      if (label === "COMPLETED") {
        await SwapKitOrderStore.remove(order.txId);
        announceCardSettlement(order, true);
        emitSwapRefresh();
        return true;
      }
    } else if (label !== "AWAITING_SIGNATURE") {
      console.log(
        `[SwapKitPendingTracker] order still live, skipping recovery order=${short} status=${label || "?"}`,
      );
      return false;
    }
    const usdcAmount = await deliveredUsdc(order);
    // A USDC order's USDC is not stranded — it IS what the user bought. The
    // convert-forward below exists because a EURC order that dies mid-route
    // leaves the user holding the hop's token; running it here would sell the
    // very asset the accepted contract delivered.
    if (orderStable(order) === "USDC_BASE") {
      // …but only once it HAS been delivered. `AWAITING_SIGNATURE` reaches here
      // too, and dropping the row then would retire an order whose dollars have
      // not arrived: nothing would resume it, and the pending row the user is
      // watching would disappear with it.
      if (usdcAmount <= 0 && !isTerminal(status)) {
        console.log(
          `[SwapKitPendingTracker] usdc order not delivered yet, keeping row order=${short} status=${label || "?"}`,
        );
        return false;
      }
      // Delivered to the EOA, which is only the ACCEPTED destination for a
      // wallet order. A card order is not settled until the dollars are on the
      // card, so the row survives until they are.
      if (!(await forwardDeliveredUsdc(order, usdcAmount))) {
        console.log(
          `[SwapKitPendingTracker] usdc forward to settle target unconfirmed, keeping row order=${short}`,
        );
        return false;
      }
      console.log(
        `[SwapKitPendingTracker] usdc order settled in its own token order=${short} usdc=${usdcAmount}`,
      );
      await SwapKitOrderStore.remove(order.txId);
      announceCardSettlement(order, true);
      emitSwapRefresh();
      return true;
    }
    if (usdcAmount <= 0) {
      // The order is dead and the hub delivered nothing, so there is nothing to
      // recover and nothing to retry. The BTC side refunds per SwapKit policy.
      console.log(`[SwapKitPendingTracker] dead order delivered no USDC order=${short}`);
      await SwapKitOrderStore.remove(order.txId);
      // Nothing reached the settle target: the credit the card showed is taken back now.
      announceCardSettlement(order, false);
      return true;
    }
    if (!(order.expectedUsdc > 0) || !(order.minEurc != null && order.minEurc > 0)) {
      throw new Error("USDC recovery is missing the accepted amount bounds.");
    }
    await recoverStrandedUsdc({
      settleTarget: order.settleTarget,
      usdcAmount,
      minEurc: order.minEurc * (usdcAmount / order.expectedUsdc),
    });
    await SwapKitOrderStore.remove(order.txId);
    announceCardSettlement(order, true);
    emitSwapRefresh();
    return true;
  } catch (e) {
    console.log(
      `[SwapKitPendingTracker] recovery failed, row kept order=${short} err=${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

// Durable tracker for a BTC→EURC card-topup order. Shares the app-wide claim
// registry so a txId can never run two loops, and deregisters itself in
// `finally` so a periodic resume re-arms it. A COMPLETED order clears the
// persisted row; a dead or exhausted-retry order escalates to USDC recovery;
// anything else is left for the next resume to retry.
export function startSwapKitOrderTracking(order: SwapKitOrder): void {
  // A foreground direct route can appear after hydration's earlier snapshot.
  // This final synchronous check and claim cannot be interleaved by another JS task.
  if (SwapKitDirectSwapStore.list().some((row) => row.txId === order.txId)) return;
  // A funding intent is not a startable order: its deposit is moved outside the
  // tracker, so running the loop against it would poll an order that may never
  // have been funded — and `send_asset` is a no-op here, so the loop could not
  // fund it either. It stays in the store as the record that the outcome of that
  // transfer is unknown.
  if (isUnfundedSweepIntent(order)) {
    console.log(`[SwapKitPendingTracker] skipping unfunded sweep intent order=${order.txId}`);
    return;
  }
  if (!claimSwapLoop(order.txId)) return;
  void (async () => {
    let attempts = order.attempts;
    try {
      if (order.kind === "discovered") {
        // Read-only. A discovered row exists only because the server listed a
        // live order this device has no accepted bounds for, so there is no
        // expectedUsdc/minEurc to bind an EVM leg to. Passing no `signAction`
        // and no `signTypedData` makes the loop poll to terminal without ever
        // reaching the key: an unbounded approval or an unchecked sell amount
        // is exactly what those bounds exist to prevent. The BTC-side handlers
        // stay wired — they are bounded by their own action validation and
        // journaled per actionId, and abandoning a live HTLC strands funds.
        // EXCEPTION to read-only: sweep rows THIS device armed from an
        // explicit user claim (recovery.provider === "sweep"). Their converts
        // execute on the SOURCE chain with payout+refund pinned to the own
        // EOA at create time, and parseSwapActionTx enforces the per-chain
        // approval allow-list — so signing them is bounded. Rows discovered
        // from the server stay read-only exactly as the review demanded.
        const sweepChainId = Number(order.recovery?.chainId);
        const sweepApprovalToken = String(order.recovery?.approvalToken || "").trim();
        const isSweepClaim =
          order.recovery?.provider === "sweep" &&
          SWAPKIT_SWEEP_CHAIN_IDS.includes(sweepChainId) &&
          /^0x[0-9a-fA-F]{40}$/.test(sweepApprovalToken);
        // The claim-time ceiling the user accepted, narrowed by a balance read
        // taken INSIDE signAction — the action can arrive many polls later (or
        // after a not-ready backoff), and a read taken here would already be
        // stale by the time the approval is signed.
        const storedMaxUnits = String(order.recovery?.approvalMaxUnits || "").trim();
        // Replay the deposit hash the funding step recorded. Reporting it there
        // is best effort, and the loop only ever re-reports a lost deposit
        // through this option — so without it a restart polls an order the
        // server still believes is unfunded, while the money has long left the
        // wallet.
        const depositTxHash = String(order.recovery?.depositTxHash || "").trim();
        const options: Parameters<typeof runSwapKitSwapLoop>[1] = {
          onUpdate: (status) => {
            noteStatusMessage(order.txId, status);
            if (hasRecoveryConsent(order))
              options.signTypedData = (parsed) => signRecoveryCow(order, parsed);
          },
          ...(depositTxHash ? { depositTxHash } : {}),
          ...(isSweepClaim
            ? {
                allowedActionChains: [sweepChainId],
                allowedApprovalTokens: [sweepApprovalToken],
                signAction: async (parsed: ParsedSwapActionTx) =>
                  signAndBroadcastSwapKitEvmTx(parsed, {
                    requireApprovalBound: true,
                    maxApprovalUnits: await liveApprovalCeiling(
                      sweepChainId,
                      sweepApprovalToken as `0x${string}`,
                      storedMaxUnits,
                    ),
                  }),
                // Sweep claims are the one flow with an out-of-band funder
                // (fundSweepConvert), so a deposit-style `send_asset` is not
                // fatal here. Everywhere else it still fails closed.
                externallyFundedDeposit: true,
              }
            : {}),
          handleHtlcAction: handleSwapKitHtlcAction,
          handleArkadeAction: handleSwapKitArkadeAction,
        };
        if (hasRecoveryConsent(order))
          options.signTypedData = (parsed) => signRecoveryCow(order, parsed);
        const result = await runSwapKitSwapLoop(order.txId, options);
        if (isTerminal(result)) {
          if (hasRecoveryConsent(order) && !(await recoveryPayoutProven(order, result))) return;
          // Clear the row FIRST (awaited/persisted), then drop the durable
          // order — same order as the topup path, so a crash between the two
          // leaves an order that hydration re-resumes and re-clears rather than
          // a pending row with nothing behind it. A sweep claim emits this row,
          // so without the clear it survives until some later reconcile.
          await clearSwapKitPendingRow(order);
          await SwapKitOrderStore.remove(order.txId);
          emitSwapRefresh();
        }
        return;
      }
      attempts = await SwapKitOrderStore.bumpAttempts(order.txId);
      const depositTo = String(order.recovery?.depositTo || "").trim();
      const externallyFundedTopup =
        order.kind === "card_topup" &&
        order.recovery?.externallyFundedDeposit === true &&
        isValidBitcoinAddressMainnet(depositTo) &&
        Number(order.recovery?.depositAmount) === order.sats;
      const depositTxHash = String(order.recovery?.depositTxHash || "").trim();
      const result = await runSwapKitSwapLoop(order.txId, {
        onUpdate: (status) => noteStatusMessage(order.txId, status),
        ...(externallyFundedTopup ? { externallyFundedDeposit: true } : {}),
        ...(externallyFundedTopup && depositTxHash ? { depositTxHash } : {}),
        handleHtlcAction: handleSwapKitHtlcAction,
        handleArkadeAction: handleSwapKitArkadeAction,
        signAction: (parsed) => {
          if (hasRecoveryConsent(order))
            throw new Error("Recovery uses the original guarded wallet actions only.");
          return signAndBroadcastBaseMainnetTx({
            ...parsed,
            ...(order.expectedUsdc > 0
              ? { maxApprovalUnits: tokenUnits(order.expectedUsdc * APPROVAL_TOLERANCE, "ceil") }
              : {}),
          });
        },
        signTypedData: (parsed) => {
          if (hasRecoveryConsent(order)) return signRecoveryCow(order, parsed);
          // The token this order settles, used for BOTH the route guard and the
          // order's own buy side. Binding a resumed USDC order against EURC
          // would cap it on a token the accepted contract never named.
          const buyToken =
            orderStable(order) === "USDC_BASE" ? BASE_USDC.address : BASE_EURC.address;
          // Same guard as the in-session loop, through the same helper.
          assertCowLegBelongsToRoute(buyToken);
          if (!(order.expectedUsdc > 0) || !(order.minEurc != null && order.minEurc > 0)) {
            throw new Error("Persisted CoW order is missing accepted amount bounds.");
          }
          return signCowOrderOnBase(parsed, {
            sellToken: BASE_USDC.address,
            buyToken,
            receiver: evmAddress(order.settleTarget, "accepted receiver"),
            maxSellAmount: tokenUnits(order.expectedUsdc, "ceil"),
            minBuyAmount: tokenUnits(order.minEurc, "floor"),
          });
        },
      });
      if (isTerminal(result)) {
        if (String(result.status || "").toUpperCase() === "COMPLETED") {
          if (hasRecoveryConsent(order) && !(await recoveryPayoutProven(order, result))) return;
          // Clear the row FIRST (awaited/persisted), then drop the durable
          // order. A crash between the two leaves the order — which hydration
          // re-resumes and re-clears — never a rowless orphan.
          await clearSwapKitPendingRow(order);
          await SwapKitOrderStore.remove(order.txId);
          announceCardSettlement(order, true);
          emitSwapRefresh();
        } else {
          // FAILED/EXPIRED/REFUNDED — re-polling can never complete it. The hub
          // already delivered USDC, so recover it forward to EURC. Keep the
          // pending row (the user's only live status) until recovery proves the
          // order settled; escalateToRecovery returns false on a transient
          // failure and keeps the durable order for the next hydrate.
          const settled = await escalateToRecovery(order);
          if (settled) await clearSwapKitPendingRow(order);
        }
      } else if (isUnrecoverableOrderError(result.walletActionError)) {
        // The server reports blocking errors as a FIELD on the track response,
        // not as a thrown error — so the catch below never sees them and the
        // row used to stay immortal (#898). Deliberately checked only AFTER the
        // poll budget is exhausted: the same text can be transient mid-flight
        // (seen live 2026-07-20: "funding needs X, wallet has Y" during a CCTP
        // bridge, self-resolved after 9 min). 30 minutes later with the error
        // still standing, it is dead — escalate once, then drop.
        const settled = await escalateToRecovery(order);
        console.log(
          `[SwapKitPendingTracker] unrecoverable walletActionError order=${order.txId} settled=${settled}`,
        );
        if (settled) {
          await clearSwapKitPendingRow(order);
          await SwapKitOrderStore.remove(order.txId);
        }
      } else {
        console.log(
          `[SwapKitPendingTracker] order poll budget exhausted, row kept order=${order.txId}`,
        );
      }
    } catch (e) {
      // The reverted-tx case: signAndBroadcastBaseMainnetTx throws when
      // estimateGas reverts. After MAX_SIGNING_ATTEMPTS, stop re-signing the
      // same doomed action and recover the stranded USDC directly.
      console.log(
        `[SwapKitPendingTracker] order tracking error order=${order.txId} attempts=${attempts} err=${e instanceof Error ? e.message : String(e)}`,
      );
      if (isUnrecoverableOrderError(e)) {
        // Dead beyond retry. escalateToRecovery still runs first — it re-reads
        // the live status and sweeps any USDC the order actually delivered —
        // and then the row goes, so the app stops resurrecting it on every
        // start.
        // Recovery may still hold funds: only drop the row once escalation
        // reports the order settled. A transient recovery failure keeps the row
        // (with its user-accepted bounds) for the next hydrate — dropping it
        // would strand delivered USDC without a bounded recovery path.
        const settled = await escalateToRecovery(order);
        console.log(`[SwapKitPendingTracker] unrecoverable order=${order.txId} settled=${settled}`);
        if (settled) {
          await clearSwapKitPendingRow(order);
          await SwapKitOrderStore.remove(order.txId);
        }
        return;
      }
      if (attempts >= MAX_SIGNING_ATTEMPTS) {
        const settled = await escalateToRecovery(order);
        if (settled) await clearSwapKitPendingRow(order);
      }
    } finally {
      releaseSwapLoop(order.txId);
    }
  })();
}

/**
 * How long an order may sit at AWAITING_SIGNATURE before this app stops
 * treating that signature as one that might still arrive.
 *
 * AWAITING_SIGNATURE is the server saying "your wallet advertised that it would
 * sign this and hasn't yet". For an order this app cannot sign — a bounds-less
 * discovered row, or one whose run created it, failed and walked away — that is
 * a permanent state: the run that could have signed it has ended, and the
 * calldata it would have signed was stale. Polling it forever adds nothing but
 * traffic and a red status the user cannot act on.
 *
 * The window is generous because a live order legitimately passes through this
 * status while a signing loop works, and an order this app CAN sign is never
 * subject to the rule at all.
 */
const ABANDONED_SIGNATURE_TTL_MS = 60 * 60 * 1000;

/** An order that is waiting for a signature that will never come. */
function isStrandedAwaitingSignature(
  summary: { txId?: string; status?: string; createdAt?: string } | undefined,
  abandoned: ReadonlySet<string>,
): boolean {
  if (!summary) return false;
  if (String(summary.status || "").toUpperCase() !== "AWAITING_SIGNATURE") return false;
  // This app created it and then failed before broadcasting: known dead, no
  // waiting period needed.
  if (summary.txId && abandoned.has(summary.txId)) return true;
  const createdAt = summary.createdAt ? Date.parse(summary.createdAt) : Number.NaN;
  return Number.isFinite(createdAt) && Date.now() - createdAt > ABANDONED_SIGNATURE_TTL_MS;
}

/**
 * Whether this device could still produce the signature the order is waiting
 * for. Card-topup rows carry the accepted bounds their legs are signed under,
 * and a sweep claim the user armed signs its own converts — both are legitimate
 * mid-flight orders and are never dropped by the rule above. A discovered row is
 * deliberately read-only (no accepted bounds exist for it), so it can never be
 * the one to sign.
 */
function canSignOrder(order: SwapKitOrder): boolean {
  return (
    order.kind !== "discovered" || order.recovery?.provider === "sweep" || hasRecoveryConsent(order)
  );
}

// Restart tracking for every persisted order. Safe to call repeatedly — the
// `active` dedupe makes it idempotent. This is what lets a user leave mid-swap
// and have it finish (or recover) on a later app start.
export async function hydrateAndResumeSwapKitOrders(): Promise<void> {
  await SwapKitOrderStore.hydrate();
  await SwapKitDirectSwapStore.hydrate();
  const directOrderIds = new Set(SwapKitDirectSwapStore.list().map((row) => row.txId));
  // The direct journal owns these orders and is the only store with their
  // accepted signing bounds. Remove any read-only discovery row left by an
  // older startup before generic tracking can claim the shared loop.
  for (const order of SwapKitOrderStore.list()) {
    if (directOrderIds.has(order.txId)) await SwapKitOrderStore.remove(order.txId);
  }
  // Which wallet swap rows existed BEFORE owner discovery reads the server's
  // live set, below. A route that writes its row after that read is missing
  // from the answer for a reason that has nothing to do with being settled —
  // reconciling it would delete the row of a swap whose funds are still moving.
  // Only rows the snapshot could have covered are judged by it.
  const persistedWalletRows = await PendingWalletTransfersStore.list().catch(
    (): PendingWalletTransfer[] => [],
  );
  const rowsBeforeDiscovery = new Set(
    persistedWalletRows.map((entry) => String(entry.orderId || "")).filter(Boolean),
  );
  // Only true once the server swap_list has been obtained and reconciled — the
  // gate for orphan cleanup below.
  let ownerDiscoveryOk = false;
  try {
    const fromAddress = await getEthereumAddress();
    if (fromAddress) {
      const listed = await listSwapKitSwaps({ fromAddress, includeTerminal: false, limit: 100 });
      const localOrders = SwapKitOrderStore.list();
      const localIds = new Set(localOrders.map((order) => order.txId));
      const unknown = (listed.transactions || []).filter(
        (summary) =>
          summary.txId && !localIds.has(summary.txId) && !directOrderIds.has(summary.txId),
      );
      // Local storage may have been wiped (logout/reinstall) while orders are
      // still live. The encrypted Nostr snapshot carries the USER-ACCEPTED
      // bounds (expectedUsdc/minEurc/usdcBaseline) — restoring from it lets the
      // tracker sign CoW legs and run bounded recovery again. Only rows the
      // snapshot doesn't know fall back to the bounds-less discovered kind
      // (which deliberately never signs). Caps are never inferred from the
      // server.
      // Orders this app created and abandoned before signing (a requoted direct
      // swap whose transaction never broadcast). They are AWAITING_SIGNATURE on
      // the server and always will be.
      const abandoned = await listAbandonedSwapOrders();
      const snapshot = unknown.length > 0 ? await restoreSwapKitRecoverySnapshotFromNostr() : null;
      const restorable = new Map(
        (snapshot ?? [])
          .filter(
            (row) =>
              typeof row?.txId === "string" &&
              typeof row.settleTarget === "string" &&
              Number.isFinite(row.expectedUsdc) &&
              typeof row.usdcBaseline === "string" &&
              /^\d+$/.test(row.usdcBaseline),
          )
          .map((row) => [row.txId, row]),
      );
      for (const summary of unknown) {
        const restored = summary.txId ? restorable.get(summary.txId) : undefined;
        if (restored && summary.txId) {
          await SwapKitOrderStore.add({ ...restored, kind: restored.kind ?? "card_topup" });
          localIds.add(summary.txId);
          console.log(
            `[SwapKitPendingTracker] restored order bounds from backup order=${summary.txId}`,
          );
          continue;
        }
        if (!summary.txId) continue;
        // A discovered row never signs, so adopting one that is stuck waiting
        // for a signature buys a poll loop that can only ever re-read the same
        // status. Leave it unadopted; the server expires it on its own schedule.
        if (
          isStrandedAwaitingSignature(summary, abandoned) &&
          !isCurrentRateRecoveryRoute(summary)
        ) {
          console.log(
            `[SwapKitPendingTracker] not adopting an order awaiting a signature nobody will give order=${summary.txId}`,
          );
          continue;
        }
        const createdAt = summary.createdAt ? Date.parse(summary.createdAt) : Date.now();
        const providers = summary.route?.providers || [];
        await SwapKitOrderStore.add({
          kind: "discovered",
          txId: summary.txId,
          settleTarget: String(summary.settleTarget || ""),
          expectedUsdc: 0,
          usdcBaseline: "0",
          sats: 0,
          createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
          attempts: 0,
          recovery: {
            provider: String(providers[0] || summary.assist?.provider || "") || undefined,
            status: summary.status,
          },
        });
        localIds.add(summary.txId);
      }
      // A funding intent the server already reports past funding WAS funded:
      // fundSweepConvert can throw after the node accepted the transfer, and the
      // intent deliberately survives that uncertainty. Left alone the row would
      // be a black hole — owner discovery skips it because the txId is local,
      // and the tracker skips it because it is still FUNDING, so a live order
      // holding the user's funds would never be polled or shown again. The
      // server's own status is the evidence: anything past awaiting-funding
      // means the deposit arrived, so the intent becomes the order it describes.
      const listedById = new Map(
        (listed.transactions || [])
          .filter((summary) => summary.txId)
          .map((summary) => [String(summary.txId), summary]),
      );
      for (const row of localOrders) {
        if (!isUnfundedSweepIntent(row)) continue;
        const status = String(listedById.get(row.txId)?.status || "").toUpperCase();
        // No listing, or still waiting for the deposit: nothing proves the
        // transfer landed, so the row stays what it is — unknown.
        if (!status || status === "AWAITING_FUNDING") continue;
        await SwapKitOrderStore.add({ ...row, recovery: { ...row.recovery, status } });
        console.log(
          `[SwapKitPendingTracker] funding intent confirmed by the server order=${row.txId} status=${status}`,
        );
      }
      // Rows adopted on an earlier start that have since proven to be waiting
      // for a signature this device will never produce. Dropping the row is the
      // whole fix: no row, no poll loop, on this start and every later one.
      // Only rows that cannot sign are eligible, so a live card topup or an
      // armed sweep claim passing through AWAITING_SIGNATURE is untouched.
      for (const row of localOrders) {
        if (canSignOrder(row) || isCurrentRateRecoveryRoute(listedById.get(row.txId))) continue;
        const stranded =
          abandoned.has(row.txId) ||
          isStrandedAwaitingSignature(listedById.get(row.txId), abandoned);
        if (!stranded) continue;
        await SwapKitOrderStore.remove(row.txId);
        console.log(
          `[SwapKitPendingTracker] stopped polling an order awaiting a signature nobody will give order=${row.txId}`,
        );
      }
      // Server list obtained and reconciled — the local order set is now
      // authoritative for the orphan cleanup below.
      ownerDiscoveryOk = true;
    }
  } catch (error) {
    // Owner discovery is additive. Local rows remain authoritative when the
    // network is offline and the next foreground hydration retries swap_list.
    console.log(
      `[SwapKitPendingTracker] owner discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Reconcile orphaned top-up rows: a COMPLETED/recovered order removes its
  // durable SwapKitOrderStore row and then clears the TTL-exempt Bitcoin
  // activity row. A crash between those two persisted writes can leave the row
  // with no order to back it — and it is now exempt from the 24h TTL, so it
  // would linger forever. Any `btc_to_eur` row whose order is gone here is such
  // an orphan; drop it. (Runs after owner-discovery has restored/added every
  // resumable order, so a still-live order's row is never mistaken for an
  // orphan.)
  // A card top-up whose signed Bitcoin deposit was recorded but whose broadcast never answered. The
  // chain decides: known → the order is funded and tracked below; unknown → that same transaction is
  // sent again (it can only ever confirm the one payment); still unknown → the row waits.
  const orders: SwapKitOrder[] = [];
  for (const row of SwapKitOrderStore.list()) {
    if (!hasRecordedSignedDeposit(row)) {
      orders.push(row);
      continue;
    }
    const funded = await settleRecordedDeposit(row, {
      getTransactionStatus: (txid) => blockchainService.getTransactionStatus(txid),
      broadcastTransaction: (rawHex) => blockchainService.broadcastTransaction(rawHex),
      saveOrder: (order) => SwapKitOrderStore.add(order),
      log: (message) => console.log(`[SwapKitPendingTracker] ${message}`),
    }).catch((error: unknown): null => {
      console.log(
        `[SwapKitPendingTracker] recorded deposit check failed order=${row.txId} err=${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    // Funded → tracked below like any order. Still unknown → the row stays in the funding state,
    // which the tracker skips, until a later start can prove the outcome.
    orders.push(funded ?? row);
  }
  // Only reconcile when owner discovery SUCCEEDED. On a swap_list failure the
  // local order set may be incomplete (local storage wiped while the server
  // still holds a live order), so deleting a row missing locally would erase
  // the only visible status for funds still in flight. Skip until a later
  // hydration confirms with the server.
  if (ownerDiscoveryOk) {
    try {
      await PendingPurchasesStore.hydrate();
      const liveOrderIds = new Set(orders.map((order) => order.txId));
      for (const row of PendingPurchasesStore.list()) {
        if (row.direction === "btc_to_eur" && !liveOrderIds.has(row.id)) {
          await PendingPurchasesStore.remove(row.id).catch(() => {});
          try {
            EventBus.emit("wallet:clearPendingTransfer", { txHash: null, orderId: row.id });
          } catch {}
          console.log(`[SwapKitPendingTracker] dropped orphaned top-up row order=${row.id}`);
        }
      }
      // The wallet's own pending list has the same orphan problem, and it shows
      // it to the user: a swap row is cleared when THIS app watches the order
      // reach COMPLETED. An app that was closed at that moment never sees it,
      // so the row stays "Pending broadcast" forever while the detail sheet —
      // which re-reads the order — says the money was delivered. Owner
      // discovery has just told us which orders are still live; a swap row
      // naming none of them is naming one that finished — as long as the row is
      // one that snapshot could have known about (see rowsBeforeDiscovery).
      for (const entry of await PendingWalletTransfersStore.list()) {
        const orderId = String(entry.orderId || "");
        if (!orderId || !String(entry.source || "").startsWith("swapkit")) continue;
        if (!rowsBeforeDiscovery.has(orderId)) continue;
        if (liveOrderIds.has(orderId)) continue;

        // swap_list intentionally excludes server-terminal orders. A provider can
        // nevertheless have only broadcast the final L1 BTC payout, which is not
        // user-terminal until its first confirmation. Re-read that exact order
        // before orphan cleanup and restore its read/poll loop from the durable
        // wallet row. On a track failure retain the row; losing visibility is
        // worse than retrying cleanup on the next foreground hydration.
        try {
          const tracked = await trackSwapKitSwap(orderId);
          noteStatusMessage(orderId, tracked);
          if (getPendingBtcPayoutConfirmation(tracked)) {
            const cap = Number(entry.maxSellEurc);
            startSwapKitPendingTracking(
              orderId,
              entry.txHash ?? null,
              Number.isFinite(cap) && cap > 0 ? cap : undefined,
              true,
            );
            continue;
          }
        } catch (error) {
          console.log(
            `[SwapKitPendingTracker] preserving unresolved swap row order=${orderId} err=${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        await PendingWalletTransfersStore.remove(null, orderId).catch(() => {});
        console.log(`[SwapKitPendingTracker] dropped settled swap row order=${orderId}`);
      }
    } catch (error) {
      console.log(
        `[SwapKitPendingTracker] orphan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const order of orders) startSwapKitOrderTracking(order);
  // Direct stable⇄stable swaps this device broadcast but never saw settle. Poll
  // only — it signs nothing, so it can move no funds; the transaction it waits
  // on is already onchain.
  void resumeDirectEvmSwaps().catch(() => {});
}
