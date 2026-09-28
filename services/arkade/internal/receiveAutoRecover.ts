// Recoverable VTXO auto-claim machinery. Refreshes claimable recoverable Arkade
// sats back into spendable offchain balance without routing through send approval.
import { AppState } from "react-native";
import { EventBus } from "../../events/AppEventBusService";

import { emitTrace, logArkadeWalletSignTrace } from "./logging";
import { assertArkadeRecoveryCsvCompatible } from "./recovery";
import { truncateForLog } from "./utils";
import { getOrCreateWallet } from "./walletCache";
import { addArkadeWalletSummaryListener } from "./walletSummaryEvents";
import { loadArkadeWalletSummary } from "./walletSummary";
import type { ArkadeWalletSummary } from "../types/wallet";
import type { ArkadeWallet } from "./types";

const ARKADE_RECOVERABLE_AUTO_CLAIM_MIN_INTERVAL_MS = 60_000;
const ARKADE_RECOVERABLE_AUTO_CLAIM_FAILURE_RETRY_MS = 5 * 60_000;

function isArkadeRecoverableAutoClaimEnabled(): boolean {
  return false;
}

type RecoverableBalance = {
  recoverable?: bigint;
  subdust?: bigint;
  includesSubdust?: boolean;
  vtxoCount?: number;
};

type RecoverableManager = {
  recoverVtxos: () => Promise<string>;
  getRecoverableBalance?: () => Promise<RecoverableBalance>;
};

type RecoverableWallet = ArkadeWallet & {
  getVtxoManager?: () => Promise<RecoverableManager>;
};

let recoverableAutoClaimInFlight: Promise<void> | null = null;
let lastRecoverableAutoClaimAtMs = 0;
let lastRecoverableAutoClaimFailure: {
  recoverableSats: number;
  atMs: number;
  error: string;
} | null = null;
let pendingRecoverableAutoClaimActiveRetry: {
  summary: ArkadeWalletSummary;
  reason: string;
  force: boolean;
} | null = null;
let recoverableActiveRetrySub: { remove?: () => void } | null = null;

addArkadeWalletSummaryListener((summary, options) => {
  if (options?.scheduleAutoRecover === true) {
    scheduleArkadeRecoverableAutoClaimImpl(summary, "wallet_summary");
  }
});

function parsePositiveSats(value: unknown): number {
  const sats = Number(value ?? 0);
  return Number.isFinite(sats) && sats > 0 ? Math.trunc(sats) : 0;
}

function bigintToSafeSats(value: unknown): number {
  if (typeof value === "bigint") {
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
  }
  return parsePositiveSats(value);
}

async function readClaimableRecoverableBalance(
  manager: RecoverableManager,
): Promise<Required<RecoverableBalance>> {
  if (typeof manager.getRecoverableBalance !== "function") {
    return { recoverable: 0n, subdust: 0n, includesSubdust: false, vtxoCount: 0 };
  }
  const balance = await manager.getRecoverableBalance().catch((): null => null);
  return {
    recoverable: typeof balance?.recoverable === "bigint" ? balance.recoverable : 0n,
    subdust: typeof balance?.subdust === "bigint" ? balance.subdust : 0n,
    includesSubdust: balance?.includesSubdust === true,
    vtxoCount: Math.max(0, Math.trunc(Number(balance?.vtxoCount ?? 0) || 0)),
  };
}

function emitRecoverableRefresh(reason: string, summary: ArkadeWalletSummary): void {
  try {
    EventBus.emit("arkade:receiveUpdated", {
      reason,
      walletSummary: summary,
      availableSats: summary.balanceAvailableSats,
      boardingConfirmedSats: summary.balanceBoardingConfirmedSats,
      boardingUnconfirmedSats: summary.balanceBoardingUnconfirmedSats,
      preconfirmedSats: summary.balancePreconfirmedSats,
      settledSats: summary.balanceSettledSats,
      recoverableSats: summary.balanceRecoverableSats,
    });
    EventBus.emit("bitcoin:refresh");
    EventBus.emit("bitcoin:syncWallet");
    EventBus.emit("transactions:refresh");
    logArkadeWalletSignTrace("arkade_wallet_update_event", {
      status: "emitted",
      reason,
      available: summary.balanceAvailableSats,
      recoverable: summary.balanceRecoverableSats,
      expected_next: "arkade_balance_and_transaction_refresh",
    });
  } catch {}
}

async function getRecoverableManager(wallet: RecoverableWallet): Promise<RecoverableManager> {
  const manager = await wallet.getVtxoManager?.();
  if (!manager || typeof manager.recoverVtxos !== "function") {
    throw new Error("arkade recoverable manager unavailable");
  }
  return manager;
}

async function recoverArkadeRecoverableVtxosNow(
  reason: string,
  walletArg?: RecoverableWallet,
): Promise<string | null> {
  const wallet = walletArg || ((await getOrCreateWallet()) as RecoverableWallet);
  await assertArkadeRecoveryCsvCompatible(wallet, "arkade_wallet_update");
  const manager = await getRecoverableManager(wallet);
  const recoverableBalance = await readClaimableRecoverableBalance(manager);
  const recoverableSats = bigintToSafeSats(recoverableBalance?.recoverable);
  const vtxoCount = Math.max(0, Math.trunc(Number(recoverableBalance?.vtxoCount ?? 0) || 0));
  const subdustSats = bigintToSafeSats(recoverableBalance?.subdust);
  const includesSubdust = recoverableBalance?.includesSubdust === true;

  logArkadeWalletSignTrace("arkade_wallet_update_preflight", {
    status: "ok",
    reason,
    recoverable: recoverableSats,
    vtxos: vtxoCount,
    subdust: subdustSats,
    includes_subdust: includesSubdust ? 1 : 0,
    expected_next:
      recoverableSats > 0 && vtxoCount > 0 ? "server_approved_receive_flow_only" : "idle",
  });
  if (recoverableSats <= 0 || vtxoCount <= 0) {
    logArkadeWalletSignTrace("arkade_wallet_update_prompt_decision", {
      status: "skip",
      reason,
      recoverable: recoverableSats,
      vtxos: vtxoCount,
      subdust: subdustSats,
      includes_subdust: includesSubdust ? 1 : 0,
      expected_next: "idle",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_wallet_update",
      status: "skip",
      detail: `reason=${reason} recoverable=${recoverableSats} vtxos=${vtxoCount} why=no_claimable_recoverable_vtxos`,
    });
    return null;
  }
  const identity = (wallet as unknown as { identity?: unknown }).identity as
    | { withRecoverableApproval?: <T>(reason: string, work: () => Promise<T>) => Promise<T> }
    | undefined;
  if (typeof identity?.withRecoverableApproval !== "function") {
    throw new Error("arkade recoverable approval identity unavailable");
  }
  logArkadeWalletSignTrace("arkade_wallet_update_prompt_decision", {
    status: "manual_approve",
    reason,
    recoverable: recoverableSats,
    vtxos: vtxoCount,
    expected_next: "recoverable_wallet_update_approve_start",
  });
  emitTrace({
    atMs: Date.now(),
    op: "arkade_wallet_update",
    status: "attempt",
    detail: `reason=${reason} recoverable=${recoverableSats} vtxos=${vtxoCount} expected_next=recoverable_wallet_update_approve_start`,
  });
  const txid = await identity.withRecoverableApproval(reason, () => manager.recoverVtxos());
  emitTrace({
    atMs: Date.now(),
    op: "arkade_wallet_update",
    status: "ok",
    id: txid || undefined,
    detail: `reason=${reason} recoverable=${recoverableSats} vtxos=${vtxoCount} txid=${txid || "n/a"}`,
  });
  return txid || null;
}

export async function recoverArkadeRecoverableVtxosManual(): Promise<ArkadeWalletSummary> {
  const txid = await recoverArkadeRecoverableVtxosNow("manual_unlock_wallet");
  const summary = await loadArkadeWalletSummary({
    scheduleAutoClaim: false,
    scheduleAutoRecover: false,
    scheduleAutoSettle: false,
    scheduleAutoBoardingSweep: false,
    forceFresh: true,
  });
  if (txid) {
    emitTrace({
      atMs: Date.now(),
      op: "arkade_wallet_update",
      status: "post_summary",
      id: txid,
      detail: `reason=manual_unlock_wallet available=${summary.balanceAvailableSats} recoverable=${summary.balanceRecoverableSats}`,
    });
    emitRecoverableRefresh("manual_unlock_wallet", summary);
  }
  return summary;
}

function queueArkadeRecoverableActiveRetry(
  summary: ArkadeWalletSummary,
  reason: string,
  force: boolean,
): void {
  pendingRecoverableAutoClaimActiveRetry = { summary, reason, force };
  ensureArkadeRecoverableActiveRetryObserver(reason);
  logArkadeWalletSignTrace("arkade_wallet_update_prompt_decision", {
    status: "queued",
    reason,
    recoverable: summary.balanceRecoverableSats,
    app_state: AppState.currentState,
    expected_next: "prompt_when_app_active",
  });
}

function ensureArkadeRecoverableActiveRetryObserver(reason: string): void {
  if (recoverableActiveRetrySub) return;
  recoverableActiveRetrySub = AppState.addEventListener("change", (nextState) => {
    if (nextState === "active") {
      triggerArkadeRecoverableActiveRetry("app_state_active");
    }
  });
  logArkadeWalletSignTrace("arkade_wallet_update_active_retry_observer", {
    status: "installed",
    reason,
    expected_next: "retry_when_app_active",
  });
}

function stopArkadeRecoverableActiveRetryObserver(reason: string): void {
  const sub = recoverableActiveRetrySub;
  recoverableActiveRetrySub = null;
  if (!sub) return;
  try {
    sub.remove?.();
    logArkadeWalletSignTrace("arkade_wallet_update_active_retry_observer", {
      status: "stopped",
      reason,
      expected_next: "install_on_next_wallet_update",
    });
  } catch (error: unknown) {
    logArkadeWalletSignTrace("arkade_wallet_update_active_retry_observer", {
      status: "stop_failed",
      reason,
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 140),
      expected_next: "install_on_next_wallet_update",
    });
  }
}

function triggerArkadeRecoverableActiveRetry(reason = "app_active"): void {
  if (AppState.currentState !== "active") return;
  stopArkadeRecoverableActiveRetryObserver(reason);
  const pending = pendingRecoverableAutoClaimActiveRetry;
  pendingRecoverableAutoClaimActiveRetry = null;
  if (!pending) return;
  scheduleArkadeRecoverableAutoClaimImpl(pending.summary, `${pending.reason}_${reason}`, true);
}

export function scheduleArkadeRecoverableAutoClaimImpl(
  summary: ArkadeWalletSummary,
  reason: string,
  force = false,
): void {
  const recoverableSats = parsePositiveSats(summary.balanceRecoverableSats);
  if (!isArkadeRecoverableAutoClaimEnabled()) {
    lastRecoverableAutoClaimFailure = null;
    pendingRecoverableAutoClaimActiveRetry = null;
    stopArkadeRecoverableActiveRetryObserver("disabled");
    logArkadeWalletSignTrace("arkade_wallet_update_auto", {
      status: "disabled",
      reason,
      recoverable: recoverableSats,
      force: force ? 1 : 0,
      expected_next: "server_approved_receive_flow_only",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_wallet_update_auto",
      status: "disabled",
      detail: `reason=${reason} recoverable=${recoverableSats} force=${force ? 1 : 0} expected_next=server_approved_receive_flow_only`,
    });
    return;
  }
  if (recoverableSats <= 0) {
    lastRecoverableAutoClaimFailure = null;
    pendingRecoverableAutoClaimActiveRetry = null;
    stopArkadeRecoverableActiveRetryObserver("no_wallet_update_needed");
    emitTrace({
      atMs: Date.now(),
      op: "arkade_wallet_update_auto",
      status: "skip",
      detail: `reason=${reason} recoverable=0 expected_next=idle`,
    });
    return;
  }
  if (AppState.currentState !== "active") {
    queueArkadeRecoverableActiveRetry(summary, reason, force);
    emitTrace({
      atMs: Date.now(),
      op: "arkade_wallet_update_auto",
      status: "queued",
      detail: `reason=${reason} recoverable=${recoverableSats} why=app_not_active app_state=${AppState.currentState}`,
    });
    return;
  }
  pendingRecoverableAutoClaimActiveRetry = null;
  stopArkadeRecoverableActiveRetryObserver("active_wallet_update_attempt");
  if (recoverableAutoClaimInFlight) {
    emitTrace({
      atMs: Date.now(),
      op: "arkade_wallet_update_auto",
      status: "skip",
      detail: `reason=${reason} recoverable=${recoverableSats} why=in_flight`,
    });
    return;
  }
  const now = Date.now();
  const failedRecently =
    lastRecoverableAutoClaimFailure?.recoverableSats === recoverableSats &&
    now - lastRecoverableAutoClaimFailure.atMs < ARKADE_RECOVERABLE_AUTO_CLAIM_FAILURE_RETRY_MS;
  if (failedRecently) {
    emitTrace({
      atMs: now,
      op: "arkade_wallet_update_auto",
      status: "skip",
      detail: `reason=${reason} recoverable=${recoverableSats} why=failure_backoff error=${truncateForLog(
        lastRecoverableAutoClaimFailure?.error || "unknown",
        90,
      )} retryMs=${ARKADE_RECOVERABLE_AUTO_CLAIM_FAILURE_RETRY_MS}`,
    });
    return;
  }
  if (
    !force &&
    now - lastRecoverableAutoClaimAtMs < ARKADE_RECOVERABLE_AUTO_CLAIM_MIN_INTERVAL_MS
  ) {
    emitTrace({
      atMs: now,
      op: "arkade_wallet_update_auto",
      status: "skip",
      detail: `reason=${reason} recoverable=${recoverableSats} why=throttled throttleMs=${ARKADE_RECOVERABLE_AUTO_CLAIM_MIN_INTERVAL_MS}`,
    });
    return;
  }

  const run = (async () => {
    lastRecoverableAutoClaimAtMs = Date.now();
    const txid = await recoverArkadeRecoverableVtxosNow(reason);
    if (!txid) {
      lastRecoverableAutoClaimFailure = {
        recoverableSats,
        atMs: Date.now(),
        error: "no_claimable_recoverable_vtxos",
      };
      return;
    }
    lastRecoverableAutoClaimFailure = null;
    const postSummary = await loadArkadeWalletSummary({
      scheduleAutoClaim: false,
      scheduleAutoRecover: false,
      scheduleAutoSettle: false,
      scheduleAutoBoardingSweep: false,
      forceFresh: true,
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_wallet_update_auto",
      status: "post_summary_ok",
      id: txid || undefined,
      detail: `reason=${reason} available=${postSummary.balanceAvailableSats} recoverable=${postSummary.balanceRecoverableSats}`,
    });
    emitRecoverableRefresh("arkade_wallet_update_auto", postSummary);
  })().catch((error: unknown) => {
    lastRecoverableAutoClaimFailure = {
      recoverableSats,
      atMs: Date.now(),
      error: error instanceof Error ? error.message : String(error || "unknown"),
    };
    emitTrace({
      atMs: Date.now(),
      op: "arkade_wallet_update_auto",
      status: "failed",
      detail: `reason=${reason} recoverable=${recoverableSats} err=${truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 170)}`,
    });
  });

  recoverableAutoClaimInFlight = run;
  void run.finally(() => {
    if (recoverableAutoClaimInFlight === run) {
      recoverableAutoClaimInFlight = null;
    }
  });
}

export function resetArkadeRecoverableAutoClaimState(): void {
  recoverableAutoClaimInFlight = null;
  lastRecoverableAutoClaimAtMs = 0;
  lastRecoverableAutoClaimFailure = null;
  pendingRecoverableAutoClaimActiveRetry = null;
  stopArkadeRecoverableActiveRetryObserver("reset");
}
