import { EventBus } from "../events/AppEventBusService";
import {
  arkadeReceiveSync,
  type ArkadeReceiveBoardingRow,
  type ArkadeReceiveLightningRow,
} from "./ArkadeApiService";
import {
  isArkadeBoardingClaimable,
  getArkadeBoardingMinimumSats,
  primeArkadeBoardingMinimumSats,
} from "./internal/boardingMinimum";
import { ARKADE_RECOVERABLE_UNLOCK_MIN_SATS } from "./internal/constants";
import { fetchArkNodeInfoWithRetry } from "./internal/network";
import { arkadeServerConfigService } from "./ArkadeServerConfigService";
import { getArkadeReceiveOwner } from "./internal/identity";
import { emitTrace, logArkadeWalletSignTrace } from "./internal/logging";
import { recoverArkadeRecoverableVtxosManual } from "./internal/receiveAutoRecover";
import { resumeArkadeLightningClaimsManual } from "./internal/receiveAutoClaim";
import { renewArkadeExpiringVtxosManual } from "./internal/vtxoRenewal";
import { setPendingLnurlSwapsFromReceiveRows } from "./internal/pendingLnurlSwaps";
import {
  filterArkadeBoardingRowsForCurrentWallet,
  getArkadeBoardingOwnershipCopyLogs,
  isBoardingOutpointRecentlySwept,
  resetArkadeBoardingOwnershipCopyLogs,
  sweepArkadeBoardingToOffchain,
} from "./internal/receiveAutoSweep";
import {
  isReverseClaimableStatus,
  isReverseFinalStatus,
  isReverseSuccessfulFinalStatus,
} from "./internal/reverseSwapClaim";
import { truncateForLog } from "./internal/utils";
import {
  duplicatedIntentInputs,
  formatDuplicatedIntentError,
  isDuplicatedIntentError,
} from "./internal/duplicatedIntent";
import { getArkadeWalletSummary, loadArkadeWalletSummary } from "./internal/walletSummary";
import type { ArkadeWalletSummary } from "./types/wallet";
export {
  ARKADE_OPEN_UNLOCK_WALLET_EVENT,
  ARKADE_RECEIVE_UNLOCK_PROGRESS_EVENT,
  emitArkadeOpenUnlockWallet,
  type ArkadeReceiveUnlockProgressPayload,
} from "./internal/receiveUpdatedEvents";

export type ArkadeReceiveUnlockStatus = "idle" | "pending" | "actionable" | "running" | "failed";

export type ArkadeReceiveUnlockItemKind =
  | "ln_receive_claim"
  | "boarding_sweep"
  | "recoverable_wallet_update"
  | "vtxo_renewal";

export type ArkadeReceiveUnlockItem = {
  kind: ArkadeReceiveUnlockItemKind;
  count: number;
  sats: number;
};

export type ArkadeReceiveUnlockState = {
  status: ArkadeReceiveUnlockStatus;
  actionableCount: number;
  actionableSats: number;
  actionableItems: ArkadeReceiveUnlockItem[];
  lnReceivePendingCount: number;
  lnReceiveClaimableCount: number;
  lnReceiveClaimableSats: number;
  boardingPendingCount: number;
  boardingSweepReadyCount: number;
  boardingSweepReadySats: number;
  /**
   * The local wallet could not be built, so the boarding rows above are the
   * server's unverified view. They stay actionable on purpose: the sweep is
   * client-only, and the next unlock tap is what rebuilds the wallet.
   */
  boardingWalletUnavailable: boolean;
  recoverableSats: number;
  recoverableMinSats: number;
  /** VTXOs whose batch expires within the renewal window (#1635). */
  vtxoRenewalDueCount: number;
  vtxoRenewalDueSats: number;
  arkadeWalletPendingVtxoCount: number;
  arkadeWalletPendingVtxoSats: number;
  preconfirmedPendingSats: number;
  detail: string;
  lastError: string | null;
  updatedAtMs: number;
};

export type ArkadeReceiveUnlockResult = {
  ok: boolean;
  state: ArkadeReceiveUnlockState;
  logs: string[];
  errors: string[];
  attemptedStepCount: number;
  completedStepCount: number;
  skippedStepCount: number;
  shouldCloseModal: boolean;
};

type UnlockListener = (state: ArkadeReceiveUnlockState) => void;

type ArkadeReceiveUnlockStepStatus = "completed" | "skipped" | "failed";

type ArkadeReceiveUnlockStepResult = {
  status: ArkadeReceiveUnlockStepStatus;
  label: string;
  output?: unknown;
};

const ARKADE_UNLOCK_FAST_PATH_STATE_MAX_AGE_MS = 15_000;

const IDLE_STATE: ArkadeReceiveUnlockState = {
  status: "idle",
  actionableCount: 0,
  actionableSats: 0,
  actionableItems: [],
  lnReceivePendingCount: 0,
  lnReceiveClaimableCount: 0,
  lnReceiveClaimableSats: 0,
  boardingPendingCount: 0,
  boardingSweepReadyCount: 0,
  boardingSweepReadySats: 0,
  boardingWalletUnavailable: false,
  recoverableSats: 0,
  recoverableMinSats: ARKADE_RECOVERABLE_UNLOCK_MIN_SATS,
  vtxoRenewalDueCount: 0,
  vtxoRenewalDueSats: 0,
  arkadeWalletPendingVtxoCount: 0,
  arkadeWalletPendingVtxoSats: 0,
  preconfirmedPendingSats: 0,
  detail: "idle",
  lastError: null,
  updatedAtMs: 0,
};

let currentState: ArkadeReceiveUnlockState = { ...IDLE_STATE };
let unlockInFlight: Promise<ArkadeReceiveUnlockResult> | null = null;
const listeners = new Set<UnlockListener>();
let currentWalletBoardingRows: ArkadeReceiveBoardingRow[] = [];
// The row set the newest refresh published, by identity: a node floor that
// arrives late may only republish the refresh that asked for it.
let latestBoardingRows: ArkadeReceiveBoardingRow[] | null = null;

function isFreshReceiveOnlyUnlockState(state: ArkadeReceiveUnlockState, nowMs: number): boolean {
  const ageMs = nowMs - state.updatedAtMs;
  return (
    state.actionableCount > 0 &&
    state.lnReceiveClaimableCount > 0 &&
    state.actionableItems.length === 1 &&
    state.actionableItems[0]?.kind === "ln_receive_claim" &&
    ageMs >= 0 &&
    ageMs <= ARKADE_UNLOCK_FAST_PATH_STATE_MAX_AGE_MS &&
    !state.lastError
  );
}

function clearReceiveClaimActionableState(
  state: ArkadeReceiveUnlockState,
  reason: string,
): ArkadeReceiveUnlockState {
  return publishState(
    {
      ...state,
      status: "pending",
      actionableCount: 0,
      actionableSats: 0,
      actionableItems: [],
      lnReceiveClaimableCount: 0,
      lnReceiveClaimableSats: 0,
      detail: "receive claim submitted; refreshing",
      updatedAtMs: Date.now(),
    },
    reason,
  );
}

function parseSats(value: unknown): number {
  const sats = Number(value ?? 0);
  return Number.isFinite(sats) && sats > 0 ? Math.trunc(sats) : 0;
}

function normalizeStatus(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function readLightningStatus(row: ArkadeReceiveLightningRow): string {
  return normalizeStatus(row.boltz_status || row.status);
}

function readLightningSats(row: ArkadeReceiveLightningRow): number {
  const msat = Number(row.amount_msat || 0);
  return Number.isFinite(msat) && msat > 0 ? Math.trunc(msat / 1000) : 0;
}

function readBoardingSweepStatus(row: ArkadeReceiveBoardingRow): string {
  const direct = normalizeStatus(row.status);
  const sweep = row.sweep && typeof row.sweep === "object" ? row.sweep : null;
  const nested = sweep ? normalizeStatus((sweep as { status?: unknown }).status) : "";
  return nested || direct;
}

function isBoardingSweepReady(row: ArkadeReceiveBoardingRow): boolean {
  return readBoardingSweepStatus(row) === "sweep_ready";
}

function formatUnlockDetail(
  state: Omit<ArkadeReceiveUnlockState, "detail" | "updatedAtMs">,
): string {
  return [
    `ln_receive_pending_count=${state.lnReceivePendingCount}`,
    `ln_receive_claimable_count=${state.lnReceiveClaimableCount}`,
    `ln_receive_claimable_sats=${state.lnReceiveClaimableSats}`,
    `boarding_pending_count=${state.boardingPendingCount}`,
    `boarding_sweep_ready_count=${state.boardingSweepReadyCount}`,
    `boarding_sweep_ready_sats=${state.boardingSweepReadySats}`,
    `boarding_wallet_unavailable=${state.boardingWalletUnavailable ? 1 : 0}`,
    `recoverable_sats=${state.recoverableSats}`,
    `recoverable_min_sats=${state.recoverableMinSats}`,
    `vtxo_renewal_due_count=${state.vtxoRenewalDueCount}`,
    `vtxo_renewal_due_sats=${state.vtxoRenewalDueSats}`,
    `arkade_wallet_pending_vtxo_count=${state.arkadeWalletPendingVtxoCount}`,
    `arkade_wallet_pending_vtxo_sats=${state.arkadeWalletPendingVtxoSats}`,
    `preconfirmed_pending_sats=${state.preconfirmedPendingSats}`,
    `actionable_count=${state.actionableCount}`,
    `actionable_sats=${state.actionableSats}`,
    state.lastError ? `err=${state.lastError}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function publishState(next: ArkadeReceiveUnlockState, source: string): ArkadeReceiveUnlockState {
  currentState = { ...next };
  emitTrace({
    atMs: currentState.updatedAtMs,
    op: "arkade_receive_unlock_state",
    status: currentState.status,
    detail: `source=${source} ${currentState.detail}`,
  });
  logArkadeWalletSignTrace("arkade_receive_unlock_state", {
    status: currentState.status,
    source,
    actionable_count: currentState.actionableCount,
    actionable_sats: currentState.actionableSats,
    ln_receive_pending_count: currentState.lnReceivePendingCount,
    ln_receive_claimable_count: currentState.lnReceiveClaimableCount,
    boarding_sweep_ready_count: currentState.boardingSweepReadyCount,
    recoverable_sats: currentState.recoverableSats,
    recoverable_min_sats: currentState.recoverableMinSats,
    arkade_wallet_pending_vtxo_count: currentState.arkadeWalletPendingVtxoCount,
    arkade_wallet_pending_vtxo_sats: currentState.arkadeWalletPendingVtxoSats,
    expected_next:
      currentState.actionableCount > 0 ? "show_unlock_wallet_modal" : "no_unlock_prompt",
  });
  for (const listener of listeners) {
    try {
      listener(currentState);
    } catch {}
  }
  try {
    EventBus.emit("arkade:unlockState", currentState);
  } catch {}
  return currentState;
}

function buildUnlockState(args: {
  lightningRows: ArkadeReceiveLightningRow[];
  boardingRows: ArkadeReceiveBoardingRow[];
  summary: ArkadeWalletSummary | null;
  status?: ArkadeReceiveUnlockStatus;
  lastError?: string | null;
  boardingWalletUnavailable?: boolean;
}): ArkadeReceiveUnlockState {
  const activeLightningRows = args.lightningRows.filter(
    (row) => !isReverseFinalStatus(readLightningStatus(row)),
  );
  const claimableRows = activeLightningRows.filter((row) =>
    isReverseClaimableStatus(readLightningStatus(row)),
  );
  const lnReceiveClaimableSats = claimableRows.reduce(
    (sum, row) => sum + readLightningSats(row),
    0,
  );
  const lnReceivePendingCount = Math.max(0, activeLightningRows.length - claimableRows.length);
  // Exclude outpoints we just swept: the server sync still reports them as
  // sweep_ready until the indexer sees them spent, which would otherwise
  // re-present a spent UTXO as actionable and cause a false sweep failure.
  const readyBoardingRows = args.boardingRows.filter(
    (row) =>
      isBoardingSweepReady(row) &&
      isArkadeBoardingClaimable(row.value_sats) &&
      !isBoardingOutpointRecentlySwept(row.txid, row.vout),
  );
  const boardingSweepReadySats = readyBoardingRows.reduce(
    (sum, row) => sum + parseSats(row.value_sats),
    0,
  );
  const boardingPendingCount = Math.max(0, args.boardingRows.length - readyBoardingRows.length);
  const recoverableSats = parseSats(args.summary?.balanceRecoverableSats);
  const vtxoRenewalDueCount = parseSats(args.summary?.vtxoRenewalDueCount);
  const vtxoRenewalDueSats = parseSats(args.summary?.vtxoRenewalDueSats);
  const arkadeWalletPendingVtxoCount = Math.max(
    0,
    Math.trunc(Number(args.summary?.debugPendingVtxoCount || 0) || 0),
  );
  const arkadeWalletPendingVtxoSats = parseSats(args.summary?.debugPendingVtxoTotalSats);
  const preconfirmedPendingSats = parseSats(args.summary?.balancePreconfirmedSats);
  const actionableItems: ArkadeReceiveUnlockItem[] = [];
  if (claimableRows.length > 0) {
    actionableItems.push({
      kind: "ln_receive_claim",
      count: claimableRows.length,
      sats: lnReceiveClaimableSats,
    });
  }
  if (readyBoardingRows.length > 0) {
    actionableItems.push({
      kind: "boarding_sweep",
      count: readyBoardingRows.length,
      sats: boardingSweepReadySats,
    });
  }
  if (recoverableSats >= ARKADE_RECOVERABLE_UNLOCK_MIN_SATS) {
    actionableItems.push({
      kind: "recoverable_wallet_update",
      count: 1,
      sats: recoverableSats,
    });
  }
  if (vtxoRenewalDueCount > 0 && vtxoRenewalDueSats >= ARKADE_RECOVERABLE_UNLOCK_MIN_SATS) {
    actionableItems.push({
      kind: "vtxo_renewal",
      count: vtxoRenewalDueCount,
      sats: vtxoRenewalDueSats,
    });
  }
  const actionableCount = actionableItems.reduce((sum, item) => sum + item.count, 0);
  const actionableSats = actionableItems.reduce((sum, item) => sum + item.sats, 0);
  const hasPending =
    lnReceivePendingCount > 0 ||
    boardingPendingCount > 0 ||
    readyBoardingRows.length > 0 ||
    arkadeWalletPendingVtxoCount > 0 ||
    preconfirmedPendingSats > 0;
  const status =
    args.status || (actionableCount > 0 ? "actionable" : hasPending ? "pending" : "idle");
  const core = {
    status,
    actionableCount,
    actionableSats,
    actionableItems,
    lnReceivePendingCount,
    lnReceiveClaimableCount: claimableRows.length,
    lnReceiveClaimableSats,
    boardingPendingCount,
    boardingSweepReadyCount: readyBoardingRows.length,
    boardingSweepReadySats,
    boardingWalletUnavailable: args.boardingWalletUnavailable === true,
    recoverableSats,
    recoverableMinSats: ARKADE_RECOVERABLE_UNLOCK_MIN_SATS,
    vtxoRenewalDueCount,
    vtxoRenewalDueSats,
    arkadeWalletPendingVtxoCount,
    arkadeWalletPendingVtxoSats,
    preconfirmedPendingSats,
    lastError: args.lastError || null,
  };
  return {
    ...core,
    detail: formatUnlockDetail(core),
    updatedAtMs: Date.now(),
  };
}

export function getArkadeReceiveUnlockState(): ArkadeReceiveUnlockState {
  return {
    ...currentState,
    actionableItems: currentState.actionableItems.map((item) => ({ ...item })),
  };
}

export function addArkadeReceiveUnlockStateListener(listener: UnlockListener): () => void {
  listeners.add(listener);
  try {
    listener(getArkadeReceiveUnlockState());
  } catch {}
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Emits `arkade:lightningReceived` with the payment hashes of every Lightning
 * receive whose sats have actually arrived — claimable (`transaction.mempool` /
 * `transaction.confirmed`) or already settled. Payload: `{ paymentHashes:
 * string[] }`, lowercased hex.
 *
 * Consumed by the wallet's pending-transfer state: a EURC→BTC swap records the
 * payment hash of the invoice it settles to, and arrival here is the moment the
 * EURC can no longer be refunded. SwapKit only reports the order COMPLETED
 * roughly a minute later, so waiting on it leaves a pending spinner up long
 * after the user has the sats.
 */
function emitLightningReceived(rows: ReadonlyArray<ArkadeReceiveLightningRow>): void {
  const paymentHashes = rows
    .filter((row) => {
      const status = readLightningStatus(row);
      return isReverseClaimableStatus(status) || isReverseSuccessfulFinalStatus(status);
    })
    .map((row) =>
      String(row.payment_hash_hex || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  if (paymentHashes.length === 0) return;
  try {
    EventBus.emit("arkade:lightningReceived", { paymentHashes });
  } catch {}
}

export async function refreshArkadeReceiveUnlockState(options?: {
  reason?: string;
  forceFresh?: boolean;
}): Promise<ArkadeReceiveUnlockState> {
  const reason = options?.reason || "refresh";
  let summary: ArkadeWalletSummary | null = null;
  let lightningRows: ArkadeReceiveLightningRow[] = [];
  let boardingRows: ArkadeReceiveBoardingRow[] = [];
  let softError: string | null = null;
  // Kept so the failure path can put them back. The failed state carries the
  // previous counts forward, so dropping the rows they refer to would advertise
  // a sweep with nothing to sweep.
  const previousBoardingRows = currentWalletBoardingRows;
  currentWalletBoardingRows = [];
  resetArkadeBoardingOwnershipCopyLogs(`${reason}_unlock_state_start`);
  try {
    // Settled independently, never as one Promise.all: the summary only feeds
    // balance display, while the sync rows are the sole record of funds waiting
    // to be swept. Collapsing both into one rejection discarded good boarding
    // rows and published actionableCount=0, which is exactly what keeps the
    // unlock modal — the only client-side sweep path — from ever opening.
    const [syncSettled, summarySettled] = await Promise.allSettled([
      getArkadeReceiveOwner().then((owner) => arkadeReceiveSync(owner)),
      (options?.forceFresh ? loadArkadeWalletSummary : getArkadeWalletSummary)({
        scheduleAutoClaim: false,
        scheduleAutoRecover: false,
        scheduleAutoSettle: false,
        scheduleAutoBoardingSweep: false,
        forceFresh: options?.forceFresh === true,
      }),
    ]);
    if (summarySettled.status === "fulfilled") {
      summary = summarySettled.value;
    } else {
      softError = truncateForLog(
        summarySettled.reason instanceof Error
          ? summarySettled.reason.message
          : String(summarySettled.reason || "unknown"),
        180,
      );
      logArkadeWalletSignTrace("arkade_receive_unlock_summary_failed", {
        status: "degraded",
        reason,
        err: softError,
        expected_next: "build_unlock_state_from_sync_rows",
      });
    }
    if (syncSettled.status === "rejected") throw syncSettled.reason;
    const syncOut = syncSettled.value;
    lightningRows = Array.isArray(syncOut.lightning)
      ? syncOut.lightning
      : Array.isArray(syncOut.receives)
        ? syncOut.receives.filter(
            (row): row is ArkadeReceiveLightningRow => row?.type === "lightning",
          )
        : [];
    boardingRows = Array.isArray(syncOut.boarding)
      ? syncOut.boarding
      : Array.isArray(syncOut.receives)
        ? syncOut.receives.filter(
            (row): row is ArkadeReceiveBoardingRow => row?.type === "boarding",
          )
        : [];
    const boardingFilter = await filterArkadeBoardingRowsForCurrentWallet(
      boardingRows,
      `${reason}_unlock_state`,
    );
    boardingRows = boardingFilter.rows;
    if (boardingRows.length > 0) {
      // The active node's own floor, read only when there is a boarding row to
      // classify: a custom node may demand more than the fallback, and marking
      // such a row actionable only defers the refusal to Ramps.onboard.
      //
      // NOT awaited. That helper retries three times with 8s timeouts, so waiting
      // for it would withhold rows the signer already returned for up to ~25s
      // whenever /v1/info is slow. The rows publish now against the last good
      // floor; when the node answers with a different one, the same rows are
      // classified again and republished. A failed read keeps the last good floor.
      const floorBefore = getArkadeBoardingMinimumSats();
      const rowsForFloor = boardingRows;
      void fetchArkNodeInfoWithRetry(
        arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, ""),
      )
        .catch((): null => null)
        .then((nodeInfo) => {
          if (primeArkadeBoardingMinimumSats(nodeInfo) === floorBefore) return;
          // Only while these rows are still the current ones: a newer refresh
          // already published with the new floor and must not be overwritten.
          if (currentWalletBoardingRows.length === 0 || rowsForFloor !== latestBoardingRows) return;
          publishState(
            buildUnlockState({
              lightningRows,
              boardingRows: rowsForFloor,
              summary,
              lastError: softError,
              boardingWalletUnavailable: boardingFilter.walletUnavailable,
            }),
            `${reason}_node_floor`,
          );
        });
    }
    latestBoardingRows = boardingRows;
    if (boardingFilter.walletError) softError = softError || boardingFilter.walletError;
    currentWalletBoardingRows = boardingRows.map((row) => ({ ...row }));
    setPendingLnurlSwapsFromReceiveRows(
      lightningRows.filter((row) => !isReverseFinalStatus(readLightningStatus(row))),
    );
    emitLightningReceived(lightningRows);
    return publishState(
      buildUnlockState({
        lightningRows,
        boardingRows,
        summary,
        lastError: softError,
        boardingWalletUnavailable: boardingFilter.walletUnavailable,
      }),
      reason,
    );
  } catch (error: unknown) {
    const detail = truncateForLog(
      error instanceof Error ? error.message : String(error || "unknown"),
      180,
    );
    // Put the rows back alongside the counts they belong to: the state below is
    // the previous one carried forward, and a sweep step that finds no rows
    // reports a skip — success, with the funds still sitting there.
    if (currentWalletBoardingRows.length === 0 && previousBoardingRows.length > 0) {
      currentWalletBoardingRows = previousBoardingRows;
    }
    const failedState = {
      ...currentState,
      status: currentState.actionableCount > 0 ? ("actionable" as const) : ("failed" as const),
      lastError: detail,
      detail: `${currentState.detail} err=${detail}`,
      updatedAtMs: Date.now(),
    };
    return publishState(failedState, `${reason}_failed`);
  }
}

async function runStep(
  logs: string[],
  errors: string[],
  label: string,
  work: () => Promise<unknown>,
): Promise<ArkadeReceiveUnlockStepResult> {
  const startedAtMs = Date.now();
  logs.push(`${label}: start`);
  try {
    const out = await work();
    const status: ArkadeReceiveUnlockStepStatus =
      label === "boarding_sweep" && (out === "pending_unconfirmed" || out === "not_wallet_script")
        ? "skipped"
        : "completed";
    logs.push(`${label}: ${status} ${String(out || "done")} durMs=${Date.now() - startedAtMs}`);
    return { status, label, output: out };
  } catch (error: unknown) {
    const detail = truncateForLog(
      error instanceof Error ? error.message : String(error || "unknown"),
      180,
    );
    // A settle refused for `duplicated input` is not a failure the user can
    // retry away: an earlier attempt left its intent registered over these
    // sats, and every new attempt is refused the same way until that intent
    // clears server-side. Reported as its own condition so the modal stops
    // inviting the retry loop that cannot succeed.
    if (isDuplicatedIntentError(error)) {
      const held = duplicatedIntentInputs(error)
        .map((input) => `${input.txid}:${input.vout}`)
        .join(",");
      errors.push(`${label}: ${formatDuplicatedIntentError(error)}`);
      logs.push(
        `${label}: blocked duplicated_intent inputs=${held} durMs=${Date.now() - startedAtMs}`,
      );
      return { status: "failed", label };
    }
    errors.push(`${label}: ${detail}`);
    logs.push(`${label}: failed ${detail} durMs=${Date.now() - startedAtMs}`);
    return { status: "failed", label };
  }
}

export async function runArkadeReceiveUnlock(
  reason = "unlock_wallet",
): Promise<ArkadeReceiveUnlockResult> {
  if (unlockInFlight) return unlockInFlight;
  unlockInFlight = (async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const startedAtMs = Date.now();
    const fastPathState = isFreshReceiveOnlyUnlockState(currentState, startedAtMs)
      ? {
          ...currentState,
          actionableItems: currentState.actionableItems.map((item) => ({ ...item })),
        }
      : null;
    publishState({ ...currentState, status: "running", updatedAtMs: startedAtMs }, reason);
    const revalidated =
      fastPathState ||
      (await refreshArkadeReceiveUnlockState({
        reason: `${reason}_revalidate`,
        forceFresh: true,
      }));
    if (fastPathState) {
      const ageMs = startedAtMs - fastPathState.updatedAtMs;
      logs.push(`fast_path: receive-only state ageMs=${ageMs}`);
      logArkadeWalletSignTrace("arkade_receive_unlock_fast_path", {
        status: "used_cached_receive_state",
        reason,
        age_ms: ageMs,
        ln_receive_claimable_count: fastPathState.lnReceiveClaimableCount,
        expected_next: "ln_receive_manual_claim",
      });
    }
    logs.push(...getArkadeBoardingOwnershipCopyLogs());
    if (revalidated.actionableCount <= 0) {
      logs.push("revalidate: no actionable work");
      const state = await refreshArkadeReceiveUnlockState({
        reason: `${reason}_empty`,
        forceFresh: true,
      });
      return {
        ok: true,
        state,
        logs,
        errors,
        attemptedStepCount: 0,
        completedStepCount: 0,
        skippedStepCount: 0,
        shouldCloseModal: state.actionableCount <= 0,
      };
    }

    const stepResults: ArkadeReceiveUnlockStepResult[] = [];
    // The receive work runs in this one session. Taking only the first item
    // stranded whatever came after it: `buildUnlockState` lists the Lightning
    // claim ahead of the boarding sweep, so mixed pending work meant the claim
    // always consumed the tap and the sweep was never offered a second one.
    //
    // A recoverable wallet update is deliberately NOT bundled in: it is a whole
    // settlement round, and pairing it with a claim costs the passkey prefetch
    // and the optimistic close (both require exactly one item), leaving the
    // modal over the screen for the duration. It runs when it is the only work,
    // which is the only case the single-step selection ever ran it in.
    const plannedKinds: ArkadeReceiveUnlockItemKind[] = revalidated.actionableItems
      .map((item) => item.kind)
      .filter((kind) => kind !== "recoverable_wallet_update" && kind !== "vtxo_renewal");
    // A VTXO renewal is a whole settlement round too, so it follows the same
    // rule: it runs on its own tap, after the receive work and any recoverable
    // update have cleared.
    for (const settlementKind of ["recoverable_wallet_update", "vtxo_renewal"] as const) {
      if (
        plannedKinds.length === 0 &&
        revalidated.actionableItems.some((item) => item.kind === settlementKind)
      ) {
        plannedKinds.push(settlementKind);
      }
    }
    // Snapshot the rows BEFORE the first step: the Lightning claim emits
    // `arkade:receiveUpdated`, the app-level monitor answers it with a refresh,
    // and that refresh clears `currentWalletBoardingRows` synchronously on
    // entry. Reading module state after an await therefore hands the sweep an
    // empty list, which it reports as a skip — success, with the UTXO untouched.
    const sweepReadyRows = currentWalletBoardingRows.filter(
      (row) =>
        isBoardingSweepReady(row) &&
        isArkadeBoardingClaimable(row.value_sats) &&
        !isBoardingOutpointRecentlySwept(row.txid, row.vout),
    );
    const selectedActionKinds = plannedKinds.join(",");
    logs.push(`step_select: ${selectedActionKinds || "none"}`);
    logArkadeWalletSignTrace("arkade_receive_unlock_step_select", {
      reason,
      selected_action: plannedKinds[0] || "none",
      planned_actions: selectedActionKinds || "none",
      actionable_count: revalidated.actionableCount,
      actionable_sats: revalidated.actionableSats,
      actionable_kinds: selectedActionKinds || "none",
      expected_next: selectedActionKinds || "refresh_state",
    });
    if (plannedKinds.length === 0) {
      logs.push("step_select: no supported actionable step");
    }
    // A failed step never cancels the ones behind it: a Lightning claim that
    // cannot sign must not take the boarding sweep down with it.
    for (const kind of plannedKinds) {
      if (kind === "ln_receive_claim") {
        stepResults.push(
          await runStep(logs, errors, "ln_receive_claim", () =>
            resumeArkadeLightningClaimsManual(),
          ),
        );
      } else if (kind === "recoverable_wallet_update") {
        stepResults.push(
          await runStep(logs, errors, "recoverable_wallet_update", () =>
            recoverArkadeRecoverableVtxosManual(),
          ),
        );
      } else if (kind === "vtxo_renewal") {
        stepResults.push(
          await runStep(logs, errors, "vtxo_renewal", () => renewArkadeExpiringVtxosManual()),
        );
      } else if (kind === "boarding_sweep") {
        if (sweepReadyRows.length === 0) {
          // The state says sats are waiting, but this session has no rows to
          // sweep — the revalidate failed and carried the previous state
          // forward, or the rows were cleared underneath us. Sweeping an empty
          // list returns "pending_unconfirmed", which counts as a skip and
          // reports the unlock as successful while the UTXO stays exactly where
          // it was. Fail it instead, so the modal stays open for another try.
          errors.push("boarding_sweep: no boarding rows available in this unlock session");
          logs.push("boarding_sweep: failed no_rows_in_session");
          logArkadeWalletSignTrace("arkade_boarding_sweep_no_rows", {
            status: "failed",
            reason,
            boarding_sweep_ready_count: revalidated.boardingSweepReadyCount,
            boarding_wallet_unavailable: revalidated.boardingWalletUnavailable ? 1 : 0,
            expected_next: "keep_modal_open_for_retry",
          });
          stepResults.push({ status: "failed", label: "boarding_sweep" });
          continue;
        }
        stepResults.push(
          await runStep(logs, errors, "boarding_sweep", () =>
            sweepArkadeBoardingToOffchain(sweepReadyRows, { appendLog: (line) => logs.push(line) }),
          ),
        );
      }
    }

    const attemptedStepCount = stepResults.length;
    const completedStepCount = stepResults.filter((step) => step.status === "completed").length;
    const skippedStepCount = stepResults.filter((step) => step.status === "skipped").length;
    const receiveOnlyUnlock =
      revalidated.actionableItems.length === 1 &&
      revalidated.actionableItems[0]?.kind === "ln_receive_claim";
    if (errors.length === 0 && completedStepCount > 0 && receiveOnlyUnlock) {
      const finalState = clearReceiveClaimActionableState(
        currentState,
        `${reason}_optimistic_complete`,
      );
      void refreshArkadeReceiveUnlockState({
        reason: `${reason}_complete`,
        forceFresh: true,
      }).catch((error: unknown) => {
        logArkadeWalletSignTrace("arkade_receive_unlock_fast_path", {
          status: "background_refresh_failed",
          reason,
          err: truncateForLog(
            error instanceof Error ? error.message : String(error || "unknown"),
            160,
          ),
          expected_next: "retry_on_next_refresh",
        });
      });
      emitTrace({
        atMs: Date.now(),
        op: "arkade_receive_unlock",
        status: "ok",
        detail: `durMs=${Date.now() - startedAtMs} logs=${logs.length} errors=0 attempted=${attemptedStepCount} completed=${completedStepCount} skipped=${skippedStepCount} close=1 optimistic=1`,
      });
      return {
        ok: true,
        state: finalState,
        logs,
        errors,
        attemptedStepCount,
        completedStepCount,
        skippedStepCount,
        shouldCloseModal: true,
      };
    }

    const state = await refreshArkadeReceiveUnlockState({
      reason: errors.length > 0 ? `${reason}_partial_failed` : `${reason}_complete`,
      forceFresh: true,
    });
    const finalState =
      errors.length > 0
        ? publishState(
            {
              ...state,
              status: state.actionableCount > 0 ? "actionable" : "failed",
              lastError: errors.join("; "),
              detail: `${state.detail} unlock_errors=${errors.join("|")}`,
              updatedAtMs: Date.now(),
            },
            `${reason}_errors`,
          )
        : state;
    const shouldCloseModal = finalState.actionableCount <= 0;
    emitTrace({
      atMs: Date.now(),
      op: "arkade_receive_unlock",
      status: errors.length > 0 ? "partial_failed" : "ok",
      detail: `durMs=${Date.now() - startedAtMs} logs=${logs.length} errors=${errors.length} attempted=${attemptedStepCount} completed=${completedStepCount} skipped=${skippedStepCount} close=${shouldCloseModal ? 1 : 0}`,
    });
    return {
      ok: errors.length === 0,
      state: finalState,
      logs,
      errors,
      attemptedStepCount,
      completedStepCount,
      skippedStepCount,
      shouldCloseModal,
    };
  })().finally(() => {
    unlockInFlight = null;
  });
  return unlockInFlight;
}
