// Receive-flow auto-claim machinery: LNURL pending auto-load, claim scan,
// foreground monitor, and claim cooldown.
// Owns its own bookkeeping (in-flight handles, throttles, cooldowns, active
// retry queues) so the prod orchestrator's scheduler functions can be real
// implementations with no DI plumbing.
import { AppState } from "react-native";
import { EventBus } from "../../events/AppEventBusService";
import {
  arkadeReceiveSync,
  type ArkadeLnurlPendingSwap as ArkadeApiPendingLnurlSwap,
  type ArkadeReceiveLightningRow,
} from "../ArkadeApiService";
import { readCachedLnurlStatus } from "./lnurlStatusCache";
import { getArkadeWalletSummary, loadArkadeWalletSummary } from "./walletSummary";
import { addArkadeWalletSummaryListener } from "./walletSummaryEvents";
import { addArkadeWalletCacheListener } from "./walletCacheEvents";
import {
  deriveArkadeReceiveStageStatus,
  getArkadeReceiveStageBaseCounts,
  getArkadeReceiveStageSnapshot,
  setReceiveStage,
} from "./receiveStage";
import type { ArkadePendingLnurlSwap } from "../types/lnurl";
import type { ArkadeWalletSummary } from "../types/wallet";
import { settleWithBatchCommitment } from "./settleWithCommitment";
import { withOutgoingBrowserApproval } from "./browserApproval";
import { getArkadeReceiveOwner } from "./identity";
import { startArkadeReceiveSsePush, stopArkadeReceiveSsePush } from "./receiveSsePush";
import { getCachedArkadeWallet, getOrCreateWallet } from "./walletCache";
import { assertArkadeRecoveryCsvCompatible } from "./recovery";
import { emitTrace, logArkadeWalletSignTrace } from "./logging";
import {
  getPendingLnurlSwapsCount,
  readPendingLnurlSwapsCache,
  resetPendingLnurlSwapsCache,
  setPendingLnurlSwaps,
} from "./pendingLnurlSwaps";
import { truncateForLog } from "./utils";
import { claimInFlightSwapIds, clearLnReceiveClaimCooldowns } from "./lnClaimCooldown";
import { clearLnReceiveResumeDedupeState } from "./resumeLightningClaims";
import {
  isReverseClaimableStatus,
  isReverseFailedFinalStatus,
  isReverseFinalStatus,
  isReverseSuccessfulFinalStatus,
} from "./reverseSwapClaim";
// emitArkadeReceiveUpdated + the summary type live in a leaf module so that
// subscriptions.ts can emit the event without importing this file (which
// previously closed the walletCache → subscriptions → receiveAutoClaim →
// walletSummary → walletCache SCC). Re-exported here to keep the public
// import surface stable.
import {
  ARKADE_RECEIVE_CLAIM_INTERNAL_EVENT,
  emitArkadeReceiveUpdated,
  type ArkadeLightningClaimSummary,
} from "./receiveUpdatedEvents";
export { emitArkadeReceiveUpdated, type ArkadeLightningClaimSummary };

const ARKADE_LNURL_PENDING_AUTO_LOAD_MIN_INTERVAL_MS = 20_000;
const ARKADE_LNURL_FOREGROUND_MONITOR_MS = 15_000;

let lnurlPendingAutoLoadInFlight: Promise<void> | null = null;
let receiveBalanceRefreshInFlight: Promise<void> | null = null;
let lnurlForegroundMonitorTimer: ReturnType<typeof setInterval> | null = null;
let lnurlForegroundMonitorSub: { remove?: () => void } | null = null;
let lastLnurlPendingAutoLoadAtMs = 0;
let lastLnurlPendingSnapshotReason = "";
let lastLnurlPendingSnapshotSkippedAuth = false;
let pendingLnurlPendingActiveRetry: { reason: string; allowPrompt: boolean } | null = null;
let receiveActiveRetrySub: { remove?: () => void } | null = null;
let lnurlPendingAutoLoadRetryTimer: ReturnType<typeof setTimeout> | null = null;

// Sweep scheduler lives in receiveAutoSweep.ts and is imported directly by
// the orchestrator. No facade is needed inside receiveAutoClaim.

// Register a top-level listener so this module schedules LNURL pending
// auto-load in response to wallet-summary loads, WITHOUT walletSummary.ts
// importing back into here. The orchestrator imports this module at app
// startup, which side-effect-loads this file and installs the listener before
// any wallet_summary load can fire.
addArkadeWalletSummaryListener((summary, options) => {
  const autoClaimEnabled = options?.scheduleAutoClaim === true;
  if (autoClaimEnabled) {
    // Warm persisted LNURL metadata for compatibility, but receive discovery
    // itself is now server-scoped and must not depend on LNURL status.
    void (async () => {
      try {
        await readCachedLnurlStatus();
      } catch {}
      scheduleArkadeLnurlPendingAutoLoadImpl("wallet_summary", false);
    })();
  }
  void summary;
});

// Bridge wallet-cache lifecycle events into the foreground monitor without
// walletCache importing back into this module (avoids the walletSummary →
// walletCache → receiveAutoClaim → walletSummary cycle flagged on PR #546).
addArkadeWalletCacheListener((event, reason) => {
  if (event === "ready") {
    startArkadeLnurlForegroundMonitor(reason);
    // Web push: on an incoming-payment event, run the same refresh as a poll tick
    // (instant instead of waiting a cycle). No-op on native; poll stays as fallback.
    void startArkadeReceiveSsePush((swapId) =>
      runArkadeLnurlForegroundMonitorTick(`sse_incoming_${swapId || "x"}`, true),
    );
  } else if (event === "recreating") {
    stopArkadeLnurlForegroundMonitor(reason);
    stopArkadeReceiveSsePush(reason);
  }
});

async function defaultSettleSdkFn(
  wallet: {
    settle: (
      params?: undefined,
      eventCallback?: (event: { type?: unknown; unsignedCommitmentTx?: unknown }) => void,
    ) => Promise<unknown>;
  },
  reason: string,
  preconfirmedSats: number,
  startedAtMs: number,
): Promise<unknown> {
  logArkadeWalletSignTrace("ark_settle_sdk_stage", {
    reason,
    stage: "wallet_settle_call",
    preconfirmed: preconfirmedSats,
    expected_next: "ark_sdk_tree_or_batch_flow",
  });
  try {
    // Same hand-off as the offboard path, and it clears after itself: the slot
    // is module-level and the next tree session reads whatever is left in it.
    const txid = await settleWithBatchCommitment(wallet);
    logArkadeWalletSignTrace("ark_settle_sdk_stage", {
      reason,
      stage: "wallet_settle_return",
      txid: String(txid || "n/a"),
      dur_ms: Date.now() - startedAtMs,
      expected_next: "refresh_wallet_summary",
    });
    return txid;
  } catch (error: unknown) {
    logArkadeWalletSignTrace("ark_settle_sdk_stage", {
      reason,
      stage: "wallet_settle_throw",
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 180),
      dur_ms: Date.now() - startedAtMs,
      expected_next: "inspect_tree_sign_or_network_logs",
    });
    throw error;
  }
}

function stripLightningReceiveId(value: unknown): string {
  const raw = String(value || "").trim();
  return raw.startsWith("lightning:") ? raw.slice("lightning:".length) : raw;
}

function receiveRowSwapId(row: ArkadeReceiveLightningRow): string {
  return (
    String(row?.swap_id || "").trim() ||
    stripLightningReceiveId(row?.receive_id) ||
    stripLightningReceiveId(row?.id)
  );
}

function mapReceiveRowToPendingSwap(row: ArkadeReceiveLightningRow): ArkadeApiPendingLnurlSwap {
  const restore = row.restore && typeof row.restore === "object" ? row.restore : null;
  return {
    id: receiveRowSwapId(row),
    username: String(row.username || ""),
    invoice: String(row.invoice || ""),
    preimage_hex: String(row.preimage_hex || restore?.preimage || "")
      .trim()
      .toLowerCase(),
    preimage_hash_hex: String(row.preimage_hash_hex || row.payment_hash_hex || "")
      .trim()
      .toLowerCase(),
    amount_msat: Number(row.amount_msat || 0),
    status: String(row.boltz_status || row.status || ""),
    created_at_ms: Number(row.created_at_ms || 0),
    updated_at_ms: Number(row.updated_at_ms || 0),
  };
}

type ReceiveStatusLike = {
  status?: unknown;
  boltz_status?: unknown;
};

function receiveRowStatus(row: ReceiveStatusLike): string {
  return String(row.boltz_status || row.status || "");
}

function countClaimableReceiveRows(rows: ReceiveStatusLike[]): number {
  return rows.filter((row) => isReverseClaimableStatus(receiveRowStatus(row))).length;
}

function countFailedReceiveRows(rows: ReceiveStatusLike[]): number {
  return rows.filter((row) => isReverseFailedFinalStatus(receiveRowStatus(row))).length;
}

function countSettledReceiveRows(rows: ReceiveStatusLike[]): number {
  return rows.filter((row) => isReverseSuccessfulFinalStatus(receiveRowStatus(row))).length;
}

// Matches the errors thrown by getArkadeReceiveOwner() when auth state has no
// wallet credential yet (cold start before passkey bootstrap, or signed out).
// These are auth-deficit conditions, not network failures.
function isReceiveOwnerUnavailableError(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("missing wallet passkey credential id") ||
    normalized.includes("missing user external compressed pubkey") ||
    normalized.includes("arkade identity unavailable")
  );
}

// Emit itself lives in the leaf module receiveUpdatedEvents.ts (imported &
// re-exported at the top of the file). The downstream "schedule a balance
// refresh" side effect that used to live inside the function body is now
// driven via an EventBus listener registered below, so any caller (this
// module OR subscriptions.ts via the leaf) gets the refresh without forming
// the SCC edge subscriptions → receiveAutoClaim.
EventBus.on(ARKADE_RECEIVE_CLAIM_INTERNAL_EVENT, (payload: { reason?: string } | undefined) => {
  scheduleArkadeReceiveBalanceRefresh(payload?.reason || "arkade_receive_event");
});

function emitArkadeWalletSummaryUpdated(reason: string, summary: ArkadeWalletSummary): void {
  try {
    EventBus.emit("arkade:receiveUpdated", {
      reason,
      walletSummary: summary,
      availableSats: summary.balanceAvailableSats,
      boardingConfirmedSats: summary.balanceBoardingConfirmedSats,
      boardingUnconfirmedSats: summary.balanceBoardingUnconfirmedSats,
      preconfirmedSats: summary.balancePreconfirmedSats,
      settledSats: summary.balanceSettledSats,
    });
    EventBus.emit("transactions:refresh");
    logArkadeWalletSignTrace("arkade_wallet_summary_event", {
      status: "emitted",
      reason,
      available: summary.balanceAvailableSats,
      boarding_confirmed: summary.balanceBoardingConfirmedSats,
      boarding_unconfirmed: summary.balanceBoardingUnconfirmedSats,
      preconfirmed: summary.balancePreconfirmedSats,
      settled: summary.balanceSettledSats,
      expected_next: "arkade_balance_and_transaction_refresh",
    });
  } catch {}
}

export function emitArkadeWalletSummaryAfterAutoSweep(
  reason: string,
  summary: ArkadeWalletSummary,
): void {
  emitArkadeWalletSummaryUpdated(reason, summary);
}

export function scheduleArkadeReceiveBalanceRefresh(reason: string): void {
  if (receiveBalanceRefreshInFlight) return;
  receiveBalanceRefreshInFlight = (async () => {
    try {
      logArkadeWalletSignTrace("ln_receive_balance_refresh", {
        status: "start",
        reason,
        expected_next: "wallet_summary_without_claim_loop",
      });
      // Use the rate-limited public wrapper so receive-triggered refreshes
      // honour the 30s mempool 429 backoff. The bare loader only has the 3s
      // cooldown — using it here let receive activity hammer wallet_summary
      // after rate-limit errors (PR #546 regression).
      const summary = await getArkadeWalletSummary({
        scheduleAutoClaim: false,
        scheduleAutoBoardingSweep: false,
        scheduleAutoSettle: false,
      });
      logArkadeWalletSignTrace("ln_receive_balance_refresh", {
        status: "ok",
        reason,
        total: summary.balanceTotalSats,
        available: summary.balanceAvailableSats,
        arkade_wallet_pending_vtxo_count: summary.debugPendingVtxoCount,
        arkade_wallet_pending_vtxo_sats: summary.debugPendingVtxoTotalSats,
        expected_next: "ui_reads_updated_summary",
      });
    } catch (error: unknown) {
      logArkadeWalletSignTrace("ln_receive_balance_refresh", {
        status: "failed",
        reason,
        err: truncateForLog(
          error instanceof Error ? error.message : String(error || "unknown"),
          160,
        ),
        expected_next: "retry_on_next_wallet_refresh",
      });
    } finally {
      receiveBalanceRefreshInFlight = null;
    }
  })();
}

function hasArkadeClaimableReceiveWork(): boolean {
  const stage = getArkadeReceiveStageSnapshot();
  return (
    stage.claimableCount > 0 ||
    stage.status === "claimable" ||
    countClaimableReceiveRows(readPendingLnurlSwapsCache()) > 0
  );
}

export function runArkadeLnurlForegroundMonitorTick(reason: string, force = false): void {
  const appState = AppState.currentState;
  if (appState !== "active") {
    logArkadeWalletSignTrace("lnurl_foreground_monitor", {
      status: "skip",
      reason,
      why: "app_not_active",
      app_state: appState,
      expected_next: "retry_when_active",
    });
    return;
  }
  if (!getCachedArkadeWallet()) {
    logArkadeWalletSignTrace("lnurl_foreground_monitor", {
      status: "skip",
      reason,
      why: "wallet_not_ready",
      expected_next: "wallet_init",
    });
    return;
  }
  if (hasArkadeClaimableReceiveWork()) {
    const stage = getArkadeReceiveStageSnapshot();
    const cachedClaimableCount = countClaimableReceiveRows(readPendingLnurlSwapsCache());
    const lnReceiveClaimableCount = Math.max(stage.claimableCount, cachedClaimableCount);
    const lnReceivePendingCount = Math.max(
      0,
      getPendingLnurlSwapsCount() - lnReceiveClaimableCount,
    );
    logArkadeWalletSignTrace("lnurl_foreground_monitor", {
      status: "claimable_detected",
      reason,
      force: force ? 1 : 0,
      receive_status: stage.status,
      ln_receive_pending_count: lnReceivePendingCount,
      ln_receive_claimable_count: lnReceiveClaimableCount,
      expected_next: "unlock_wallet_modal",
    });
    return;
  }
  logArkadeWalletSignTrace("lnurl_foreground_monitor", {
    status: "poll",
    reason,
    force: force ? 1 : 0,
    expected_next: "lnurl_pending_auto_load",
  });
  scheduleArkadeLnurlPendingAutoLoadImpl(`${reason}_foreground_poll`, false, force);
}

export function startArkadeLnurlForegroundMonitor(reason: string): void {
  if (!lnurlForegroundMonitorTimer) {
    lnurlForegroundMonitorTimer = setInterval(() => {
      runArkadeLnurlForegroundMonitorTick("foreground_interval", false);
    }, ARKADE_LNURL_FOREGROUND_MONITOR_MS);
    logArkadeWalletSignTrace("lnurl_foreground_monitor", {
      status: "started",
      reason,
      interval_ms: ARKADE_LNURL_FOREGROUND_MONITOR_MS,
      expected_next: "poll_pending_lnurl_swaps",
    });
  }
  if (!lnurlForegroundMonitorSub) {
    lnurlForegroundMonitorSub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        runArkadeLnurlForegroundMonitorTick("app_state_active", true);
      }
    });
  }
  runArkadeLnurlForegroundMonitorTick(reason, true);
}

export function stopArkadeLnurlForegroundMonitor(reason: string): void {
  const hadMonitor = Boolean(lnurlForegroundMonitorTimer || lnurlForegroundMonitorSub);
  if (lnurlForegroundMonitorTimer) {
    clearInterval(lnurlForegroundMonitorTimer);
    lnurlForegroundMonitorTimer = null;
  }
  const sub = lnurlForegroundMonitorSub;
  lnurlForegroundMonitorSub = null;
  if (!hadMonitor) return;
  try {
    sub?.remove?.();
    logArkadeWalletSignTrace("lnurl_foreground_monitor", {
      status: "stopped",
      reason,
      expected_next: "restart_when_wallet_ready",
    });
  } catch (error: unknown) {
    logArkadeWalletSignTrace("lnurl_foreground_monitor", {
      status: "stop_failed",
      reason,
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 140),
      expected_next: "restart_when_wallet_ready",
    });
  }
}

function queueLnurlPendingActiveRetry(reason: string, allowPrompt: boolean): void {
  pendingLnurlPendingActiveRetry = { reason, allowPrompt };
  ensureArkadeReceiveActiveRetryObserver(reason);
}

function ensureArkadeReceiveActiveRetryObserver(reason: string): void {
  if (receiveActiveRetrySub) return;
  receiveActiveRetrySub = AppState.addEventListener("change", (nextState) => {
    if (nextState === "active") {
      triggerArkadeReceiveActiveRetry("app_state_active");
    }
  });
  logArkadeWalletSignTrace("ln_receive_active_retry_observer", {
    status: "installed",
    reason,
    expected_next: "retry_queued_receive_when_app_active",
  });
}

function stopArkadeReceiveActiveRetryObserver(reason: string): void {
  const sub = receiveActiveRetrySub;
  receiveActiveRetrySub = null;
  if (!sub) return;
  try {
    sub.remove?.();
    logArkadeWalletSignTrace("ln_receive_active_retry_observer", {
      status: "stopped",
      reason,
      expected_next: "install_on_next_retry_queue",
    });
  } catch (error: unknown) {
    logArkadeWalletSignTrace("ln_receive_active_retry_observer", {
      status: "stop_failed",
      reason,
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 140),
      expected_next: "install_on_next_retry_queue",
    });
  }
}

function scheduleLnurlPendingAutoLoadRetry(
  reason: string,
  allowPrompt: boolean,
  delayMs: number,
  why: string,
): void {
  if (lnurlPendingAutoLoadRetryTimer) {
    clearTimeout(lnurlPendingAutoLoadRetryTimer);
    lnurlPendingAutoLoadRetryTimer = null;
    logArkadeWalletSignTrace("lnurl_pending_auto_load", {
      status: "retry_replaced",
      reason,
      prompt: allowPrompt ? 1 : 0,
      why,
      expected_next: "new_delayed_pending_load",
    });
  }
  const retryDelayMs = Math.max(250, Math.trunc(delayMs));
  lnurlPendingAutoLoadRetryTimer = setTimeout(() => {
    lnurlPendingAutoLoadRetryTimer = null;
    scheduleArkadeLnurlPendingAutoLoadImpl(`${reason}_delayed`, allowPrompt, true);
  }, retryDelayMs);
  logArkadeWalletSignTrace("lnurl_pending_auto_load", {
    status: "retry_scheduled",
    reason,
    prompt: allowPrompt ? 1 : 0,
    delay_ms: retryDelayMs,
    why,
    expected_next: "delayed_pending_load",
  });
}

export async function getArkadePendingLnurlSwaps(options?: {
  allowPrompt?: boolean;
  reason?: string;
}): Promise<ArkadePendingLnurlSwap[]> {
  const allowPrompt = options?.allowPrompt === true;
  const reason = options?.reason || "lnurl_pending_swaps";
  lastLnurlPendingSnapshotReason = reason;
  lastLnurlPendingSnapshotSkippedAuth = false;
  emitTrace({
    atMs: Date.now(),
    op: "lnurl_pending_snapshot",
    status: "attempt",
    detail: `reason=${reason} prompt=0 source=receive_sync requestedPrompt=${allowPrompt ? 1 : 0}`,
  });
  let receiveRows: ArkadeReceiveLightningRow[];
  try {
    const owner = await getArkadeReceiveOwner();
    const out = await arkadeReceiveSync(owner);
    receiveRows = Array.isArray(out?.lightning)
      ? out.lightning
      : Array.isArray(out?.receives)
        ? out.receives.filter((row): row is ArkadeReceiveLightningRow => row?.type === "lightning")
        : [];
  } catch (error: unknown) {
    const errorText = error instanceof Error ? error.message : String(error || "unknown");
    if (!isReceiveOwnerUnavailableError(errorText)) {
      throw error;
    }
    // Cold start / signed-out: credential metadata isn't populated yet, so
    // the server-side sync can't be addressed. Fall back to the cached
    // snapshot instead of failing — same contract the assertion-gated
    // pending fetch had before the receive-sync migration.
    lastLnurlPendingSnapshotSkippedAuth = true;
    emitTrace({
      atMs: Date.now(),
      op: "lnurl_pending_snapshot",
      status: "skipped",
      detail: `reason=${reason} prompt=0 why=receive_owner_unavailable`,
    });
    logArkadeWalletSignTrace("lnurl_pending_snapshot", {
      status: "skipped",
      reason,
      prompt: 0,
      why: "receive_owner_unavailable",
      app_state: AppState.currentState,
      expected_next: "wait_for_passkey_bootstrap_or_manual_claim",
    });
    return readPendingLnurlSwapsCache();
  }
  const rows = receiveRows.map((row) => mapReceiveRowToPendingSwap(row));
  // Terminal rows (settled/refunded/expired/failed) stay on the server as
  // evidence — /receive/sync never deletes them. Only non-final rows are
  // pending work for the client; final rows must not keep the receive stage
  // or the foreground monitor busy.
  const activeRows = rows.filter((row) => !isReverseFinalStatus(row.status));
  const mapped = setPendingLnurlSwaps(activeRows);
  const baseCounts = getArkadeReceiveStageBaseCounts();
  const claimableRows = countClaimableReceiveRows(activeRows);
  const failedRows = countFailedReceiveRows(rows);
  const settledRows = countSettledReceiveRows(rows);
  const pendingRows = Math.max(0, mapped.length - claimableRows);
  const nextCounts = {
    pendingCount: pendingRows,
    claimableCount: claimableRows,
    claimedCount: mapped.length > 0 ? baseCounts.claimedCount : 0,
    settledCount: Math.max(baseCounts.settledCount, settledRows),
    failedCount: failedRows,
  };
  setReceiveStage(
    deriveArkadeReceiveStageStatus(nextCounts),
    nextCounts,
    `source=pending_snapshot rows=${mapped.length}`,
  );
  emitTrace({
    atMs: Date.now(),
    op: "lnurl_pending_snapshot",
    status: "ok",
    detail: `rows=${mapped.length}`,
  });
  logArkadeWalletSignTrace("lnurl_pending_snapshot", {
    status: "ok",
    reason,
    prompt: 0,
    ln_receive_pending_count: pendingRows,
    ln_receive_claimable_count: claimableRows,
    failed: failedRows,
    expected_next: claimableRows > 0 ? "unlock_wallet_modal" : "idle",
  });
  return mapped;
}

export async function resumeArkadeLightningClaimsManual(): Promise<ArkadeLightningClaimSummary> {
  // The engine is retired (see lightningCache), so a persisted receive row can
  // no longer be claimed. Reporting a zero-success summary here is what turned a
  // stranded receive into a clean "unlock completed": when rows exist, fail
  // loudly instead, so the unlock surfaces them and nobody reads success over
  // sats they cannot move.
  const persisted = getPendingLnurlSwapsCount();
  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_manual_claim",
    status: persisted > 0 ? "blocked" : "disabled",
    detail:
      persisted > 0
        ? `persisted_receive_rows=${persisted} reason=arkade_lightning_engine_retired expected_next=server_side_recovery`
        : "reason=arkade_lightning_retired expected_next=boarding_address_receive",
  });
  if (persisted > 0) {
    throw new Error(
      `Lightning receive is retired: ${persisted} persisted receive row(s) cannot be claimed from this build`,
    );
  }
  return { scanned: 0, claimable: 0, claimed: 0, settled: 0, final: 0, failed: 0 };
}

export function scheduleArkadeReceiveAutoClaims(reason: string, force = false): void {
  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_auto_claim",
    status: "disabled",
    detail: `reason=${reason} force=${force ? 1 : 0} expected_next=unlock_wallet_manual_runner`,
  });
}

export function scheduleArkadeLnurlPendingAutoLoadImpl(
  reason: string,
  allowPrompt: boolean,
  force = false,
): void {
  if (hasArkadeClaimableReceiveWork()) {
    emitTrace({
      atMs: Date.now(),
      op: "lnurl_pending_auto_load",
      status: "skip",
      detail: `reason=${reason} why=cache_has_claimable pending=${getPendingLnurlSwapsCount()}`,
    });
    return;
  }

  if (lnurlPendingAutoLoadInFlight) {
    emitTrace({
      atMs: Date.now(),
      op: "lnurl_pending_auto_load",
      status: "skip",
      detail: `reason=${reason} why=in_flight`,
    });
    return;
  }

  const appState = AppState.currentState;
  if (!allowPrompt && appState !== "active") {
    emitTrace({
      atMs: Date.now(),
      op: "lnurl_pending_auto_load",
      status: "skip",
      detail: `reason=${reason} why=app_not_active_no_prompt appState=${appState}`,
    });
    return;
  }
  if (allowPrompt && appState !== "active") {
    queueLnurlPendingActiveRetry(reason, allowPrompt);
    emitTrace({
      atMs: Date.now(),
      op: "lnurl_pending_auto_load",
      status: "skip",
      detail: `reason=${reason} why=app_not_active appState=${appState}`,
    });
    return;
  }
  const now = Date.now();
  if (
    !force &&
    now - lastLnurlPendingAutoLoadAtMs < ARKADE_LNURL_PENDING_AUTO_LOAD_MIN_INTERVAL_MS
  ) {
    const retryDelayMs =
      ARKADE_LNURL_PENDING_AUTO_LOAD_MIN_INTERVAL_MS - (now - lastLnurlPendingAutoLoadAtMs) + 100;
    emitTrace({
      atMs: now,
      op: "lnurl_pending_auto_load",
      status: "skip",
      detail: `reason=${reason} why=throttled throttleMs=${ARKADE_LNURL_PENDING_AUTO_LOAD_MIN_INTERVAL_MS}`,
    });
    scheduleLnurlPendingAutoLoadRetry(reason, allowPrompt, retryDelayMs, "throttled");
    return;
  }

  const shouldPrompt = allowPrompt && appState === "active";
  lastLnurlPendingAutoLoadAtMs = now;
  emitTrace({
    atMs: now,
    op: "lnurl_pending_auto_load",
    status: "attempt",
    detail: `reason=${reason} prompt=${shouldPrompt ? 1 : 0} appState=${appState}`,
  });

  const pendingSnapshotReason = `${reason}_auto_pending_load`;
  const run = getArkadePendingLnurlSwaps({
    allowPrompt: shouldPrompt,
    reason: pendingSnapshotReason,
  })
    .then((rows) => {
      const skippedAuth =
        lastLnurlPendingSnapshotSkippedAuth &&
        lastLnurlPendingSnapshotReason === pendingSnapshotReason;
      if (skippedAuth) {
        emitTrace({
          atMs: Date.now(),
          op: "lnurl_pending_auto_load",
          status: "auth_skipped",
          detail: `reason=${reason} rows=cache_only appState=${AppState.currentState}`,
        });
        return;
      }
      emitTrace({
        atMs: Date.now(),
        op: "lnurl_pending_auto_load",
        status: "ok",
        detail: `reason=${reason} rows=${rows.length}`,
      });
    })
    .catch((error: unknown) => {
      const errorText = error instanceof Error ? error.message : String(error || "unknown");
      emitTrace({
        atMs: Date.now(),
        op: "lnurl_pending_auto_load",
        status: "failed",
        detail: `reason=${reason} err=${truncateForLog(errorText, 170)}`,
      });
    });

  lnurlPendingAutoLoadInFlight = run;
  void run.finally(() => {
    if (lnurlPendingAutoLoadInFlight === run) {
      lnurlPendingAutoLoadInFlight = null;
    }
  });
}

export function triggerArkadeReceiveAutomation(reason = "debug_receive_automation"): void {
  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_auto_claim",
    status: "disabled",
    detail: `reason=${reason} expected_next=unlock_wallet_manual_runner`,
  });
}

export function triggerArkadeReceiveActiveRetry(reason = "app_active"): void {
  if (AppState.currentState !== "active") return;
  stopArkadeReceiveActiveRetryObserver(reason);
  const pendingLoad = pendingLnurlPendingActiveRetry;
  pendingLnurlPendingActiveRetry = null;
  if (pendingLoad) {
    scheduleArkadeLnurlPendingAutoLoadImpl(
      `${pendingLoad.reason}_${reason}`,
      pendingLoad.allowPrompt,
      true,
    );
    return;
  }
}

// Auto-settle is obsolete. Settlement must happen through explicit user approval.
export function scheduleArkadeWalletAutoSettleImpl(reason: string, force = false): void {
  emitTrace({
    atMs: Date.now(),
    op: "ark_settle",
    status: "disabled",
    detail: `reason=${reason} force=${force ? 1 : 0} expected_next=manual_unlock_approval`,
  });
}

export async function settleArkadePreconfirmedVtxos(): Promise<ArkadeWalletSummary> {
  const startedAtMs = Date.now();
  const wallet = await getOrCreateWallet();
  await assertArkadeRecoveryCsvCompatible(wallet, "ark_settle_manual");
  // Manual settle (user-driven): bypass the 30s rate-limit backoff because the
  // operation can't proceed without a fresh preconfirmed count, and the user
  // is actively waiting.
  const before = await loadArkadeWalletSummary({
    scheduleAutoClaim: false,
    scheduleAutoSettle: false,
  });
  const preconfirmedSats = Math.max(0, Number(before.balancePreconfirmedSats || 0));
  const settledSats = Math.max(0, Number(before.balanceSettledSats || 0));

  if (preconfirmedSats <= 0) {
    emitTrace({
      atMs: Date.now(),
      op: "ark_settle",
      status: "skip",
      detail: `reason=manual preconfirmed=0 settled=${settledSats}`,
    });
    return before;
  }

  emitTrace({
    atMs: Date.now(),
    op: "ark_settle",
    status: "attempt",
    detail: `reason=manual preconfirmed=${preconfirmedSats} settled=${settledSats}`,
  });

  try {
    const txid = await withOutgoingBrowserApproval(
      {
        kind: "arkade_settle",
        title: "Approve Arkade Settle",
        amountSats: preconfirmedSats,
        recipient: before.arkAddress,
        note: "Settle preconfirmed Arkade VTXOs back to your Arkade address.",
        source: "debug_arkade",
        approvalScope: "direct_session",
      },
      () =>
        defaultSettleSdkFn(
          wallet as unknown as Parameters<typeof defaultSettleSdkFn>[0],
          "manual",
          preconfirmedSats,
          startedAtMs,
        ),
      {
        detail: `flow=arkade.settle reason=manual preconfirmed=${preconfirmedSats}`,
      },
    );
    emitTrace({
      atMs: Date.now(),
      op: "ark_settle",
      status: "ok",
      id: String(txid || "") || undefined,
      detail: `reason=manual txid=${String(txid || "n/a")} durMs=${Date.now() - startedAtMs}`,
    });
    // Manual settle post-refresh: bypass rate-limit so the user sees the
    // updated balance immediately after their interactive action.
    const after = await loadArkadeWalletSummary({
      scheduleAutoClaim: false,
      scheduleAutoSettle: false,
    });
    emitTrace({
      atMs: Date.now(),
      op: "ark_settle",
      status: "post_summary",
      id: String(txid || "") || undefined,
      detail: `reason=manual available=${after.balanceAvailableSats} settled=${after.balanceSettledSats} preconfirmed=${after.balancePreconfirmedSats}`,
    });
    return after;
  } catch (error: unknown) {
    const raw = error instanceof Error ? error.message : String(error || "unknown");
    emitTrace({
      atMs: Date.now(),
      op: "ark_settle",
      status: "failed",
      detail: `reason=manual err=${truncateForLog(raw, 170)}`,
    });
    throw error;
  }
}

// reset: clear all module state and observers. Called from the debug-tier
// resetArkadeWalletDebug flow on logout/migration.
export function resetArkadeReceiveAutoClaimState(): void {
  stopArkadeLnurlForegroundMonitor("reset");
  stopArkadeReceiveSsePush("reset");
  lnurlPendingAutoLoadInFlight = null;
  receiveBalanceRefreshInFlight = null;
  if (lnurlPendingAutoLoadRetryTimer) {
    clearTimeout(lnurlPendingAutoLoadRetryTimer);
    lnurlPendingAutoLoadRetryTimer = null;
  }
  pendingLnurlPendingActiveRetry = null;
  stopArkadeReceiveActiveRetryObserver("reset");
  lastLnurlPendingAutoLoadAtMs = 0;
  lastLnurlPendingSnapshotReason = "";
  lastLnurlPendingSnapshotSkippedAuth = false;
  clearLnReceiveResumeDedupeState();
  clearLnReceiveClaimCooldowns();
  claimInFlightSwapIds.clear();
  resetPendingLnurlSwapsCache();
}

// Read-only accessors for callers that need to coordinate with claim state.
export function isArkadeReceiveClaimInFlight(): boolean {
  return claimInFlightSwapIds.size > 0;
}
