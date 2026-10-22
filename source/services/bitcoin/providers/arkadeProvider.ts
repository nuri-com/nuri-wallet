// Arkade L2 provider.
//
// Wraps the arkade SDK for VTXO ownership, off-chain sends, LN sends, and
// the boarding-address receive flow. Subscribes via the SDK's
// notifyIncomingFunds stream — the actual recovery wiring still lives in
// services/arkade/internal/subscriptions.ts and runs at module load; this
// provider exposes a thin per-call subscribe for callers that want their
// own handler.

import { payArkadeLightningInvoice } from "../../arkade/ArkadeLightningSendService";
import {
  getArkadeWalletSummary,
  getArkadeWalletSummarySnapshot,
} from "../../arkade/ArkadeWalletService";
import {
  getUnifiedTransactionHistory,
  type UnifiedTransaction,
} from "../../arkade/ArkadeTransactionHistoryService";
import { sendArkadeBitcoinOnchain, sendArkadeToArk } from "../../arkade/ArkadeSendService";
import { EventBus } from "../../events/AppEventBusService";
import { logWithId, LOG_EMOJI } from "../../../lib/OperationLogUtils";
import type { BitcoinBalance } from "../balanceShape";
import { balanceFromArkadeSummary } from "../balanceShape";
import type { BitcoinTransaction } from "../BitcoinTransactionsService";
import type { BitcoinSendResult, BitcoinSendTarget } from "../BitcoinSendService";
import type {
  BtcL2GetBalanceOptions,
  BtcL2GetTransactionsOptions,
  BtcL2GetTransactionsResult,
  BtcL2Provider,
  BtcL2SubscribeHandlers,
} from "../BtcL2Provider";

type ArkadeReceiveUpdatePayload = {
  scanned?: number;
  claimed?: number;
  settled?: number;
  final?: number;
  failed?: number;
};

function unifiedArkadeRowToTransaction(atx: UnifiedTransaction): BitcoinTransaction {
  return {
    id: atx.id,
    source: "arkade",
    type: atx.type,
    amountSats: Math.max(0, Math.trunc(atx.amountSats || 0)),
    timestamp: atx.timestamp,
    status: atx.status,
    txid: atx.txid,
    kind: atx.kind,
    isMigrationTx: atx.isMigrationTx,
    counterpartyScripts: atx.counterpartyScripts,
    ...(atx.counterpartyAddresses ? { counterpartyAddresses: atx.counterpartyAddresses } : {}),
    ...(atx.boarding ? { boarding: true as const } : {}),
    ...(atx.boardingTxid ? { boardingTxid: atx.boardingTxid } : {}),
  };
}

function emitPostSendRefresh(): void {
  try {
    EventBus.emit("bitcoin:refresh");
  } catch {}
  try {
    EventBus.emit("bitcoin:syncWallet");
  } catch {}
}

export const arkadeProvider: BtcL2Provider = {
  async getBalance(opts: BtcL2GetBalanceOptions): Promise<BitcoinBalance> {
    try {
      const summary = await getArkadeWalletSummary({
        scheduleAutoClaim: opts.scheduleAutoClaim ?? true,
        scheduleAutoRecover: opts.scheduleAutoRecover ?? false,
        scheduleAutoBoardingSweep: opts.scheduleAutoBoardingSweep ?? false,
        forceFresh: opts.forceFresh,
      });
      return balanceFromArkadeSummary(summary);
    } catch (error) {
      // Fall back to the last cached summary, which represents the actual
      // last-known state of the wallet (even if it is zero). If none exists,
      // rethrow so the store keeps the previous balance.
      const fallback = getArkadeWalletSummarySnapshot();
      logWithId(
        `${LOG_EMOJI.bitcoin} Bitcoin.arkadeBalance`,
        fallback ? "summary failed; using fallback" : "summary failed; no fallback",
        {
          fallback: fallback ? 1 : 0,
          err: error instanceof Error ? error.message : String(error || "unknown"),
        },
        {
          context: "background",
          event: "API_ERR",
          action: "balance",
          source: "services/bitcoin/providers/arkadeProvider.ts#getBalance",
        },
      );
      if (fallback) return balanceFromArkadeSummary(fallback);
      throw error;
    }
  },

  async getTransactions(opts: BtcL2GetTransactionsOptions): Promise<BtcL2GetTransactionsResult> {
    try {
      const history = await getUnifiedTransactionHistory({ legacyAddress: opts.address });
      const rows = history.map(unifiedArkadeRowToTransaction);
      return { rows, legacyRaw: [], isFullCache: false, error: null };
    } catch (e) {
      return {
        rows: [],
        legacyRaw: [],
        isFullCache: false,
        error: e instanceof Error ? e.message : "arkade history failed",
      };
    }
  },

  async send(target: BitcoinSendTarget): Promise<BitcoinSendResult> {
    if (target.kind === "bolt11") {
      const result = await payArkadeLightningInvoice({ invoice: target.invoice });
      emitPostSendRefresh();
      return { kind: "bolt11", paymentHash: result.paymentHash, raw: result };
    }
    if (target.kind === "lnurl") {
      const result = await payArkadeLightningInvoice({
        invoice: target.lnurl,
        amountSats: target.amountSats > 0 ? target.amountSats : undefined,
      });
      emitPostSendRefresh();
      return { kind: "lnurl", paymentHash: result.paymentHash, raw: result };
    }
    if (target.kind === "ark_send") {
      const txid = await sendArkadeToArk({
        address: target.address,
        amountSats: target.amountSats,
        onSigned: target.onSigned,
      });
      emitPostSendRefresh();
      return { kind: "ark_send", txid, raw: txid };
    }
    const { txid } = await sendArkadeBitcoinOnchain({
      address: target.address,
      amountSats: target.amountSats,
    });
    emitPostSendRefresh();
    return { kind: "bitcoin_onchain", txid, raw: txid };
  },

  async getReceiveAddress(): Promise<string> {
    try {
      const summary = await getArkadeWalletSummary();
      const boarding = (summary.boardingAddress || "").trim();
      if (boarding) return boarding;
    } catch (error) {
      // Receiving an address is a critical, user-facing operation (buy/receive),
      // so a fresh-summary failure must be logged rather than silently swallowed.
      const fallback = getArkadeWalletSummarySnapshot();
      logWithId(
        `${LOG_EMOJI.bitcoin} Bitcoin.arkadeReceiveAddress`,
        "summary failed; using cached boarding address",
        {
          fallback: fallback ? 1 : 0,
          err: error instanceof Error ? error.message : String(error || "unknown"),
        },
        {
          context: "background",
          event: "API_ERR",
          action: "receiveAddress",
          source: "services/bitcoin/providers/arkadeProvider.ts#getReceiveAddress",
        },
      );
    }
    // The cached boarding address is required, not a convenience: without it a
    // network blip during a buy would leave the user with no destination at all.
    // It is the SAME address, cache-evicted on identity change, so it can never
    // be another account's. What must never happen is substituting a DIFFERENT
    // address — the legacy MuSig2 one above all, which nothing in the app
    // renders, so funds arriving there read as lost. With no cached boarding
    // address either, return "" and let the caller abort.
    const snapshot = getArkadeWalletSummarySnapshot();
    return (snapshot?.boardingAddress || "").trim();
  },

  subscribe(handlers: BtcL2SubscribeHandlers): () => void {
    // The module-level subscription in services/arkade/internal/subscriptions.ts
    // owns the SDK's notifyIncomingFunds stream and emits via EventBus. We
    // hook the bus here so per-call subscribers get a typed callback.
    const off = EventBus.on<ArkadeReceiveUpdatePayload>("arkade:receiveUpdated", (payload) => {
      const claimed = Number(payload?.claimed ?? 0) || 0;
      const final = Number(payload?.final ?? 0) || 0;
      const settled = Number(payload?.settled ?? 0) || 0;
      try {
        handlers.onIncoming?.({
          newVtxos: claimed,
          spentVtxos: final,
          coins: settled,
        });
      } catch (e) {
        try {
          handlers.onError?.(e);
        } catch {}
      }
    });
    return off;
  },
};
