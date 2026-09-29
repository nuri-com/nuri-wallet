// Pending-tx rescue: finalize sends that were submitted to the Ark operator
// but never finalized (half-finalized "stranded" sends — inputs spent, outputs
// never spendable VTXOs; seen 2026-07-05 via the checkpoint-order bug).
// Wraps the SDK's finalizePendingTxs in the recoverable approval scope: one
// passkey prompt, then the SERVER-returned checkpoint PSBTs are co-signed and
// finalized directly — the submitTx response-ordering bug cannot affect this
// path because there is no client-side index pairing here.
import { EventBus } from "../../events/AppEventBusService";
import { emitTrace, logArkadeWalletSignTrace } from "./logging";
import { truncateForLog } from "./utils";
import { getOrCreateWallet } from "./walletCache";
import { loadArkadeWalletSummary } from "./walletSummary";

export type ArkadePendingTxRescueResult = {
  finalized: string[];
  pending: string[];
};

// Standalone shape (NOT an intersection with the SDK Wallet class):
// setPendingTxFlag is `private` in the SDK typings, and intersecting a class
// private with a same-named public member collapses the type to `never`. The
// member exists on the runtime prototype; see the flag note in
// finalizeArkadePendingTxs for why the rescue must call it.
type PendingTxWalletApi = {
  finalizePendingTxs?: () => Promise<ArkadePendingTxRescueResult>;
  setPendingTxFlag?: (value: boolean) => Promise<void>;
  identity?: {
    withRecoverableApproval?: <T>(reason: string, work: () => Promise<T>) => Promise<T>;
  };
};

/**
 * Ask the server for pending (half-finalized) txs of this wallet, co-sign
 * their checkpoints (one passkey prompt via the recoverable approval scope)
 * and finalize them. Refreshes balances when something was rescued.
 *
 * The SDK gates finalizePendingTxs on its LOCAL hasPendingTx flag, and any
 * later successful send clears that flag — a stranded tx from before that
 * send would be silently skipped. The rescue therefore forces the flag and
 * always asks the server; the SDK clears the flag itself once nothing is
 * left pending, so this cannot leave a stale flag behind.
 */
export async function finalizeArkadePendingTxs(
  reason: string,
): Promise<ArkadePendingTxRescueResult> {
  const wallet = (await getOrCreateWallet()) as unknown as PendingTxWalletApi;
  if (
    typeof wallet.finalizePendingTxs !== "function" ||
    typeof wallet.setPendingTxFlag !== "function"
  ) {
    throw new Error("arkade wallet pending-tx api unavailable");
  }
  const identity = wallet.identity;
  if (typeof identity?.withRecoverableApproval !== "function") {
    throw new Error("arkade recoverable approval identity unavailable");
  }
  const finalizePendingTxs: () => Promise<ArkadePendingTxRescueResult> =
    wallet.finalizePendingTxs.bind(wallet);
  await wallet.setPendingTxFlag(true);
  logArkadeWalletSignTrace("pending_tx_rescue_start", {
    reason,
    expected_next: "recoverable_approve_then_server_pending_tx_fetch",
  });
  emitTrace({
    atMs: Date.now(),
    op: "arkade_pending_tx_rescue",
    status: "attempt",
    detail: `reason=${reason}`,
  });
  try {
    const result = await identity.withRecoverableApproval(`pending_tx_rescue_${reason}`, () =>
      finalizePendingTxs(),
    );
    logArkadeWalletSignTrace("pending_tx_rescue_done", {
      reason,
      finalized: result.finalized.length,
      pending: result.pending.length,
      finalized_txids: result.finalized.map((txid) => txid.slice(0, 12)).join(",") || "none",
      expected_next: result.finalized.length > 0 ? "balance_refresh" : "idle",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_pending_tx_rescue",
      status: "ok",
      detail: `reason=${reason} finalized=${result.finalized.length} pending=${result.pending.length}`,
    });
    if (result.finalized.length > 0) {
      await loadArkadeWalletSummary({
        scheduleAutoClaim: false,
        scheduleAutoRecover: false,
        scheduleAutoSettle: false,
        scheduleAutoBoardingSweep: false,
        forceFresh: true,
      });
      try {
        EventBus.emit("bitcoin:refresh");
        EventBus.emit("bitcoin:syncWallet");
        EventBus.emit("transactions:refresh");
      } catch {}
    }
    return result;
  } catch (error: unknown) {
    logArkadeWalletSignTrace("pending_tx_rescue_failed", {
      reason,
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 160),
      expected_next: "surface_rescue_error",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_pending_tx_rescue",
      status: "failed",
      detail: `reason=${reason} err=${truncateForLog(
        error instanceof Error ? error.message : String(error || "unknown"),
        140,
      )}`,
    });
    throw error;
  }
}
