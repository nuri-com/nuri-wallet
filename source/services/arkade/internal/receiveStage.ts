// Receive-stage state machine. Lives in internal/ so other internal modules
// (receiveAutoClaim, walletSummary) can read/write receive-stage status
// without importing the prod-tier ArkadeReceiveOrchestrator (which would
// create a module cycle). The prod-tier orchestrator re-exports the public
// surfaces and adds the scheduler wrapper functions.
import type { ArkadeReceiveStageSnapshot, ArkadeReceiveStageStatus } from "../types/receive";
import type { ArkadeWalletSummary } from "../types/wallet";
import {
  getCachedBoardingSweepFailureSnapshot,
  setBoardingSweepFailureChangeListener,
  type ArkadeBoardingSweepFailureSnapshot,
} from "./boardingSweepFailure";
import { emitTrace } from "./logging";

export type ArkadeReceiveStageBaseCounts = {
  pendingCount: number;
  claimableCount: number;
  claimedCount: number;
  settledCount: number;
  failedCount: number;
};

let cachedReceiveStageBaseCounts: ArkadeReceiveStageBaseCounts = {
  pendingCount: 0,
  claimableCount: 0,
  claimedCount: 0,
  settledCount: 0,
  failedCount: 0,
};

let cachedReceiveStage: ArkadeReceiveStageSnapshot = {
  status: "idle",
  pendingCount: 0,
  claimableCount: 0,
  claimedCount: 0,
  settledCount: 0,
  failedCount: 0,
  updatedAtMs: 0,
  detail: "ln_receive_pending_count=0 ln_receive_claimable_count=0 claiming=0 settled=0 failed=0",
};

function readCachedBoardingSweepFailure(): ArkadeBoardingSweepFailureSnapshot | null {
  return getCachedBoardingSweepFailureSnapshot();
}

function buildReceiveStageDetail(
  snapshot: Omit<ArkadeReceiveStageSnapshot, "updatedAtMs" | "detail">,
  extra?: string,
): string {
  const base =
    `ln_receive_pending_count=${snapshot.pendingCount} ` +
    `ln_receive_claimable_count=${snapshot.claimableCount} ` +
    `claiming=${snapshot.claimedCount} settled=${snapshot.settledCount} failed=${snapshot.failedCount}`;
  const failure = readCachedBoardingSweepFailure();
  const sweepDetail = failure
    ? [
        "sweep_blocked=1",
        `sweep_source=${failure.source}`,
        `sweep_selected_count=${failure.selectedCount}`,
        `sweep_selected_confirmed=${failure.selectedConfirmedCount}`,
        `sweep_selected_unconfirmed=${failure.selectedUnconfirmedCount}`,
        `sweep_selected_total=${failure.selectedTotalSats}`,
        `sweep_selected_all_confirmed=${failure.selectedAllConfirmed ? 1 : 0}`,
        `sweep_selected_outpoints=${failure.selectedOutpointsText}`,
        `sweep_selected_txids=${failure.selectedTxidsText}`,
        failure.failedTxid ? `sweep_failed_txid=${failure.failedTxid}` : "",
        `sweep_err=${failure.detail}`,
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const suffix = [extra, sweepDetail].filter(Boolean).join(" ");
  return suffix ? `${base} ${suffix}` : base;
}

export function setReceiveStage(
  status: ArkadeReceiveStageStatus,
  counts: ArkadeReceiveStageBaseCounts,
  extra?: string,
): void {
  const nextBaseCounts: ArkadeReceiveStageBaseCounts = {
    pendingCount: Math.max(0, Math.trunc(counts.pendingCount)),
    claimableCount: Math.max(0, Math.trunc(counts.claimableCount)),
    claimedCount: Math.max(0, Math.trunc(counts.claimedCount)),
    settledCount: Math.max(0, Math.trunc(counts.settledCount)),
    failedCount: Math.max(0, Math.trunc(counts.failedCount)),
  };
  cachedReceiveStageBaseCounts = nextBaseCounts;
  const sweepFailure = readCachedBoardingSweepFailure();
  const nextCore = {
    status: status === "idle" && sweepFailure ? ("failed" as const) : status,
    ...nextBaseCounts,
    failedCount: Math.max(nextBaseCounts.failedCount, sweepFailure ? 1 : 0),
  };
  const detail = buildReceiveStageDetail(nextCore, extra);
  const changed =
    cachedReceiveStage.status !== nextCore.status ||
    cachedReceiveStage.pendingCount !== nextCore.pendingCount ||
    cachedReceiveStage.claimableCount !== nextCore.claimableCount ||
    cachedReceiveStage.claimedCount !== nextCore.claimedCount ||
    cachedReceiveStage.settledCount !== nextCore.settledCount ||
    cachedReceiveStage.failedCount !== nextCore.failedCount ||
    cachedReceiveStage.detail !== detail;
  cachedReceiveStage = {
    ...nextCore,
    updatedAtMs: Date.now(),
    detail,
  };
  if (!changed) return;
  emitTrace({
    atMs: cachedReceiveStage.updatedAtMs,
    op: "ln_receive_stage",
    status: cachedReceiveStage.status,
    detail,
  });
}

export function deriveArkadeReceiveStageStatus(
  counts: ArkadeReceiveStageBaseCounts,
): ArkadeReceiveStageStatus {
  if (counts.claimedCount > 0) return "claiming";
  if (counts.claimableCount > 0) return "claimable";
  if (counts.settledCount > 0) {
    return "settled";
  }
  if (counts.failedCount > 0 || readCachedBoardingSweepFailure()) return "failed";
  return "idle";
}

export function refreshArkadeReceiveStageFromCaches(source: string): void {
  setReceiveStage(
    deriveArkadeReceiveStageStatus(cachedReceiveStageBaseCounts),
    cachedReceiveStageBaseCounts,
    `source=${source}`,
  );
}

// Refresh receive-stage detail when boarding-sweep failure state flips, since
// the failure goes into the stage detail string.
setBoardingSweepFailureChangeListener(refreshArkadeReceiveStageFromCaches);

export function getArkadeReceiveStageSnapshot(): ArkadeReceiveStageSnapshot {
  return { ...cachedReceiveStage };
}

export function getArkadeReceiveStageBaseCounts(): ArkadeReceiveStageBaseCounts {
  return { ...cachedReceiveStageBaseCounts };
}

export function updateReceiveStageFromWalletSummary(_summary: ArkadeWalletSummary): void {
  // Wallet-level preconfirmed/pending VTXOs are tracked in walletSummary.ts.
  // They must not influence LN receive claimability or receive-stage status.
}

export function resetArkadeReceiveOrchestratorState(): void {
  cachedReceiveStageBaseCounts = {
    pendingCount: 0,
    claimableCount: 0,
    claimedCount: 0,
    settledCount: 0,
    failedCount: 0,
  };
  cachedReceiveStage = {
    status: "idle",
    pendingCount: 0,
    claimableCount: 0,
    claimedCount: 0,
    settledCount: 0,
    failedCount: 0,
    updatedAtMs: 0,
    detail: "ln_receive_pending_count=0 ln_receive_claimable_count=0 claiming=0 settled=0 failed=0",
  };
}
