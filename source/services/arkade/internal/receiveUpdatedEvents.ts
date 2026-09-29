// Leaf module for the "arkade receive updated" event surface. Lives apart
// from receiveAutoClaim.ts so subscriptions.ts can emit the event without
// importing the receive-claim runtime — that import edge previously closed
// the SCC walletCache → subscriptions → receiveAutoClaim → walletSummary →
// walletCache.
//
// Only depends on EventBus (cross-service, leaf) and logging (leaf), so no
// path from here back into the wallet/lightning cache modules.

import { EventBus } from "../../events/AppEventBusService";
import { logArkadeWalletSignTrace } from "./logging";

export type ArkadeLightningClaimSummary = {
  scanned: number;
  claimable: number;
  claimed: number;
  settled: number;
  final: number;
  failed: number;
};

// Internal event used by receiveAutoClaim to drive a follow-up balance
// refresh. Separate from the public "arkade:receiveUpdated" so the wallet-
// summary emit (which already produced a fresh summary) doesn't re-trigger
// a refresh. UI consumers should keep listening on "arkade:receiveUpdated".
export const ARKADE_RECEIVE_CLAIM_INTERNAL_EVENT = "arkade:receiveClaim:internal";
export const ARKADE_RECEIVE_UNLOCK_PROGRESS_EVENT = "arkade:receiveUnlock:progress";
// Asks the app to bring the unlock modal back up. Emitted by the surfaces that
// show waiting funds (the arkade rail's pending-sweep row), because a dismissed
// modal otherwise stays suppressed until the actionable work disappears — and a
// boarding sweep has no other path: it only ever runs from that modal.
export const ARKADE_OPEN_UNLOCK_WALLET_EVENT = "arkade:receiveUnlock:open";

export function emitArkadeOpenUnlockWallet(reason: string): void {
  try {
    EventBus.emit(ARKADE_OPEN_UNLOCK_WALLET_EVENT, { reason });
    logArkadeWalletSignTrace("arkade_receive_unlock_open_requested", {
      reason,
      expected_next: "show_unlock_wallet_modal",
    });
  } catch {}
}

export type ArkadeReceiveUnlockProgressPayload = {
  /** claim_signed / claim_waiting: a Lightning claim is signed or waiting.
   * sweep_approved: the passkey approved a boarding sweep; the settlement round
   * runs on without the user. */
  phase: "claim_signed" | "claim_waiting" | "sweep_approved";
  reason: string;
  id: string;
  elapsedMs?: number;
};

export function emitArkadeReceiveUnlockProgress(payload: ArkadeReceiveUnlockProgressPayload): void {
  try {
    EventBus.emit(ARKADE_RECEIVE_UNLOCK_PROGRESS_EVENT, payload);
    logArkadeWalletSignTrace("arkade_receive_unlock_progress", {
      phase: payload.phase,
      reason: payload.reason,
      id: payload.id,
      elapsed_ms: payload.elapsedMs || 0,
      expected_next: "close_modal_show_pending_status",
    });
  } catch {}
}

export function emitArkadeReceiveUpdated(
  reason: string,
  summary: ArkadeLightningClaimSummary,
): void {
  try {
    EventBus.emit("arkade:receiveUpdated", {
      reason,
      scanned: summary.scanned,
      claimable: summary.claimable,
      claimed: summary.claimed,
      settled: summary.settled,
      final: summary.final,
      failed: summary.failed,
    });
    EventBus.emit("transactions:refresh");
    // Drives scheduleArkadeReceiveBalanceRefresh inside receiveAutoClaim's
    // module-load listener. Fired only by receive-claim emits, not by
    // wallet-summary emits — same gating as the pre-refactor code path.
    EventBus.emit(ARKADE_RECEIVE_CLAIM_INTERNAL_EVENT, { reason });
    logArkadeWalletSignTrace("arkade_receive_event", {
      status: "emitted",
      reason,
      claimed: summary.claimed,
      settled: summary.settled,
      final: summary.final,
      failed: summary.failed,
      expected_next: "arkade_ui_and_transaction_refresh",
    });
  } catch {}
}
