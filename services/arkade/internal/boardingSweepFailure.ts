// Module-state cache for the last boarding-sweep failure. The orchestrator
// reads the snapshot for the receive-stage detail; the sweep flow writes
// here on failure and clears on success.
import { emitTrace } from "./logging";
import { truncateForLog } from "./utils";

export type ArkadeBoardingSweepFailureSnapshot = {
  source: string;
  selectedCount: number;
  selectedConfirmedCount: number;
  selectedUnconfirmedCount: number;
  selectedTotalSats: number;
  selectedAllConfirmed: boolean;
  selectedOutpointsText: string;
  selectedTxidsText: string;
  failedTxid: string;
  detail: string;
};

export type ArkadeBoardingSweepFailure = {
  atMs: number;
  source: "server" | "local";
  detail: string;
  selectedCount: number;
  selectedConfirmedCount: number;
  selectedUnconfirmedCount: number;
  selectedTotalSats: number;
  selectedAllConfirmed: boolean;
  selectedOutpointsText: string;
  selectedTxidsText: string;
  failedTxid: string;
};

let cachedBoardingSweepFailure: ArkadeBoardingSweepFailure | null = null;

let onChangeListener: ((source: string) => void) | null = null;

export function setBoardingSweepFailureChangeListener(
  listener: ((source: string) => void) | null,
): void {
  onChangeListener = listener;
}

export function getCachedBoardingSweepFailureSnapshot(): ArkadeBoardingSweepFailureSnapshot | null {
  if (!cachedBoardingSweepFailure) return null;
  return {
    source: cachedBoardingSweepFailure.source,
    selectedCount: cachedBoardingSweepFailure.selectedCount,
    selectedConfirmedCount: cachedBoardingSweepFailure.selectedConfirmedCount,
    selectedUnconfirmedCount: cachedBoardingSweepFailure.selectedUnconfirmedCount,
    selectedTotalSats: cachedBoardingSweepFailure.selectedTotalSats,
    selectedAllConfirmed: cachedBoardingSweepFailure.selectedAllConfirmed,
    selectedOutpointsText: cachedBoardingSweepFailure.selectedOutpointsText,
    selectedTxidsText: cachedBoardingSweepFailure.selectedTxidsText,
    failedTxid: cachedBoardingSweepFailure.failedTxid,
    detail: cachedBoardingSweepFailure.detail,
  };
}

export function getCachedBoardingSweepFailure(): ArkadeBoardingSweepFailure | null {
  return cachedBoardingSweepFailure ? { ...cachedBoardingSweepFailure } : null;
}

export function setBoardingSweepFailure(
  failure: ArkadeBoardingSweepFailure | null,
  source: string,
): void {
  const prev = cachedBoardingSweepFailure;
  const changed = JSON.stringify(prev ?? null) !== JSON.stringify(failure ?? null);
  cachedBoardingSweepFailure = failure;
  if (!changed) return;
  emitTrace({
    atMs: Date.now(),
    op: "arkade_boarding_sweep_state",
    status: failure ? "blocked" : "clear",
    detail: failure
      ? truncateForLog(
          `arkade=1 source=${failure.source} selected_count=${failure.selectedCount} selected_confirmed=${failure.selectedConfirmedCount} selected_unconfirmed=${failure.selectedUnconfirmedCount} selected_total=${failure.selectedTotalSats} selected_all_confirmed=${failure.selectedAllConfirmed ? 1 : 0} selected_outpoints=${failure.selectedOutpointsText} selected_txids=${failure.selectedTxidsText} ${failure.failedTxid ? `failed_txid=${failure.failedTxid} ` : ""}err=${failure.detail}`,
          320,
        )
      : `arkade=1 source=${source}`,
  });
  if (onChangeListener) {
    try {
      onChangeListener(source);
    } catch {}
  }
}

export function resetBoardingSweepFailureCache(): void {
  cachedBoardingSweepFailure = null;
}
