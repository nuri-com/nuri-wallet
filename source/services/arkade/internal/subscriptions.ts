// Incoming-funds subscription owned by the wallet bootstrap. The SDK's
// notifyIncomingFunds subscription can be killed by a "subscription not
// found" 500 from the indexer or by iOS suspending the app; the
// recoverArkadeSubscription listener wires both an AppState foreground
// signal and an EventBus 'arkade:subscriptionLost' trigger into a clean
// re-subscribe path.
import { AppState, type AppStateStatus, Platform } from "react-native";
import { errMsg } from "../../../lib/errorMessage";
import { EventBus } from "../../events/AppEventBusService";
// Import from the leaf event module so this file no longer pulls in the
// receive-claim runtime — that import was the SCC edge subscriptions →
// receiveAutoClaim → walletSummary → walletCache → subscriptions. The leaf
// emits an internal event that receiveAutoClaim listens for to schedule the
// follow-up balance refresh, so the side effect is preserved.
import { emitArkadeReceiveUpdated } from "./receiveUpdatedEvents";
import { logArkadeWalletErrorTrace, logArkadeWalletSignTrace } from "./logging";
import { truncateForLog } from "./utils";
import { subscribeToBufferedLogs } from "../../logging/DebugLogBuffer";

type SubscriptionWallet = {
  notifyIncomingFunds?: (cb: (funds: SubscriptionFunds) => void) => Promise<() => void>;
  getContractManager(): Promise<DisposableContractManager>;
  _contractManager?: DisposableContractManager;
  _contractManagerInitializing?: Promise<DisposableContractManager>;
};

type SubscriptionFunds = {
  type?: string;
  newVtxos?: unknown[];
  spentVtxos?: unknown[];
  coins?: unknown[];
};

type DisposableContractManager = {
  dispose?: () => void | Promise<void>;
};

const RECOVER_SUBSCRIPTION_THROTTLE_MS = 30_000;
// Web only: re-enable the SDK's incoming-funds push (server -> WebSocket/indexer
// subscription) so the PWA gets event-driven balance updates instead of
// receive_sync polling. Native stays on polling until the indexer subscription's
// reliability (the #722 "subscription not found" / suspend noise) is verified.
const ARKADE_INCOMING_FUNDS_SUBSCRIPTION_ENABLED = Platform.OS === "web";
const ARKADE_CONTRACT_WATCHER_RECOVERY_ENABLED = true;

let cachedIncomingFundsStop: (() => void) | null = null;
let cachedIncomingFundsKey: string | null = null;
let incomingFundsInitInFlight: Promise<void> | null = null;
let recoverSubscriptionInFlight: Promise<void> | null = null;
let recoverSubscriptionLastAtMs = 0;
let recoverSubscriptionListenerInstalled = false;
let incomingFundsSubscriptionDisabledLogged = false;

let resubscribeProvider:
  | (() => { wallet: SubscriptionWallet | null; subscriptionKey: string | null })
  | null = null;

export function registerArkadeIncomingFundsResubscribeProvider(
  provider: () => { wallet: SubscriptionWallet | null; subscriptionKey: string | null },
): void {
  resubscribeProvider = provider;
}

export function stopArkadeIncomingFundsSubscription(reason: string): void {
  const stop = cachedIncomingFundsStop;
  cachedIncomingFundsStop = null;
  cachedIncomingFundsKey = null;
  if (!stop) return;
  try {
    stop();
    logArkadeWalletSignTrace("wallet_notify_incoming_funds", {
      status: "stopped",
      reason,
      expected_next: "restart_when_wallet_ready",
    });
  } catch (error: unknown) {
    logArkadeWalletSignTrace("wallet_notify_incoming_funds", {
      status: "stop_failed",
      reason,
      err: truncateForLog(errMsg(error, "unknown"), 140),
      expected_next: "restart_when_wallet_ready",
    });
  }
}

export async function ensureArkadeIncomingFundsSubscription(
  wallet: SubscriptionWallet,
  subscriptionKey: string,
  reason: string,
): Promise<void> {
  if (!ARKADE_INCOMING_FUNDS_SUBSCRIPTION_ENABLED) {
    stopArkadeIncomingFundsSubscription(`disabled_${reason}`);
    if (!incomingFundsSubscriptionDisabledLogged) {
      incomingFundsSubscriptionDisabledLogged = true;
      logArkadeWalletSignTrace("wallet_notify_incoming_funds", {
        status: "disabled",
        reason,
        expected_next: "server_receive_sync_polling",
      });
    }
    return;
  }
  if (cachedIncomingFundsStop && cachedIncomingFundsKey === subscriptionKey) {
    return;
  }
  if (incomingFundsInitInFlight) {
    return incomingFundsInitInFlight;
  }
  incomingFundsInitInFlight = (async () => {
    if (typeof wallet?.notifyIncomingFunds !== "function") {
      logArkadeWalletSignTrace("wallet_notify_incoming_funds", {
        status: "unavailable",
        reason,
        expected_next: "poll_wallet_summary",
      });
      return;
    }

    stopArkadeIncomingFundsSubscription(`restart_${reason}`);
    logArkadeWalletSignTrace("wallet_notify_incoming_funds", {
      status: "start",
      reason,
      expected_next: "sdk_notify_incoming_vtxos",
    });

    const stop = await wallet.notifyIncomingFunds((funds: SubscriptionFunds) => {
      const type = String(funds?.type || "unknown");
      const newVtxos = Array.isArray(funds?.newVtxos) ? funds.newVtxos.length : 0;
      const spentVtxos = Array.isArray(funds?.spentVtxos) ? funds.spentVtxos.length : 0;
      const coins = Array.isArray(funds?.coins) ? funds.coins.length : 0;
      logArkadeWalletSignTrace("wallet_notify_incoming_funds", {
        status: type,
        new_vtxos: newVtxos,
        spent_vtxos: spentVtxos,
        coins,
        expected_next: "refresh_wallet_balance",
      });
      emitArkadeReceiveUpdated("wallet_notify_incoming_funds", {
        scanned: newVtxos + spentVtxos + coins,
        claimable: 0,
        claimed: newVtxos,
        settled: coins,
        final: spentVtxos,
        failed: 0,
      });
    });

    cachedIncomingFundsStop = stop;
    cachedIncomingFundsKey = subscriptionKey;
    logArkadeWalletSignTrace("wallet_notify_incoming_funds", {
      status: "ready",
      reason,
      expected_next: "event_driven_balance_refresh",
    });
  })();

  try {
    await incomingFundsInitInFlight;
  } finally {
    incomingFundsInitInFlight = null;
  }
}

async function readCurrentContractManager(
  wallet: SubscriptionWallet,
): Promise<DisposableContractManager | null> {
  if (wallet._contractManager) return wallet._contractManager;
  if (!wallet._contractManagerInitializing) return null;
  try {
    return await wallet._contractManagerInitializing;
  } catch {
    return null;
  }
}

async function disposeContractManager(
  manager: DisposableContractManager | null,
  reason: string,
): Promise<void> {
  if (!manager || typeof manager.dispose !== "function") {
    logArkadeWalletSignTrace("subscription_recovery", {
      status: "old_manager_missing",
      reason,
      expected_next: "clear_and_recreate_manager",
    });
    return;
  }
  const startedAtMs = Date.now();
  try {
    await manager.dispose();
    logArkadeWalletSignTrace("subscription_recovery", {
      status: "old_manager_disposed",
      reason,
      dur_ms: Date.now() - startedAtMs,
      expected_next: "clear_and_recreate_manager",
    });
  } catch (error: unknown) {
    logArkadeWalletErrorTrace("subscription_recovery", {
      status: "old_manager_dispose_failed",
      reason,
      dur_ms: Date.now() - startedAtMs,
      err: truncateForLog(errMsg(error, "unknown"), 160),
    });
  }
}

async function recoverArkadeSubscription(reason: string): Promise<void> {
  if (recoverSubscriptionInFlight) return recoverSubscriptionInFlight;
  const now = Date.now();
  if (now - recoverSubscriptionLastAtMs < RECOVER_SUBSCRIPTION_THROTTLE_MS) {
    logArkadeWalletSignTrace("subscription_recovery", {
      status: "skip",
      reason,
      why: "throttled",
    });
    return;
  }
  recoverSubscriptionLastAtMs = now;
  recoverSubscriptionInFlight = (async () => {
    const startedAtMs = Date.now();
    try {
      const provider = resubscribeProvider?.();
      const wallet = provider?.wallet || null;
      if (!wallet) {
        logArkadeWalletSignTrace("subscription_recovery", {
          status: "skip",
          reason,
          why: "no_cached_wallet",
        });
        return;
      }
      logArkadeWalletSignTrace("subscription_recovery", {
        status: "start",
        reason,
        expected_next: "dispose_old_manager",
      });
      stopArkadeIncomingFundsSubscription("subscription_recovery");
      const oldManager = await readCurrentContractManager(wallet);
      await disposeContractManager(oldManager, reason);
      wallet._contractManager = undefined;
      wallet._contractManagerInitializing = undefined;
      await wallet.getContractManager();
      logArkadeWalletSignTrace("subscription_recovery", {
        status: "new_manager_ready",
        reason,
        dur_ms: Date.now() - startedAtMs,
        expected_next: "subscription_recovered",
      });
      if (provider?.subscriptionKey) {
        await ensureArkadeIncomingFundsSubscription(
          wallet,
          provider.subscriptionKey,
          "subscription_recovery",
        );
      }
      logArkadeWalletSignTrace("subscription_recovery", {
        status: "ok",
        reason,
        dur_ms: Date.now() - startedAtMs,
      });
    } catch (error: unknown) {
      logArkadeWalletErrorTrace("subscription_recovery", {
        status: "error",
        reason,
        err: truncateForLog(errMsg(error, "unknown"), 200),
      });
    } finally {
      recoverSubscriptionInFlight = null;
    }
  })();
  return recoverSubscriptionInFlight;
}

// Foreground triggers a re-subscribe whenever the app has been backgrounded
// for at least FOREGROUND_RESUBSCRIBE_GAP_MS. iOS suspends the SDK's
// streaming gRPC connection while the app is inactive; by the time the user
// resumes, the server-side subscription is typically gone and we need a
// fresh one. The recoverArkadeSubscription throttle prevents thrash if the
// app flickers in/out of active state.
const FOREGROUND_RESUBSCRIBE_GAP_MS = 30_000;
let lastForegroundActiveAtMs = Date.now();
let lastAppState: AppStateStatus = AppState.currentState;

// Sniffs DebugLogBuffer for the specific SDK stale-subscription string.
// Proper fix would be an SDK-exposed onError callback; until then, keep the
// recovery trigger scoped to ContractWatcher/indexer-subscribe stale IDs.
function isContractWatcherRecoveryMessage(message: string): boolean {
  if (!message) return false;
  const scopedToContractWatcher =
    /ContractWatcher connection failed/i.test(message) ||
    /failed to subscribe to scripts/i.test(message) ||
    /\/v1\/indexer\/script\/subscribe/i.test(message);
  return scopedToContractWatcher && /subscription not found/i.test(message);
}

export function ensureArkadeSubscriptionRecoveryListener(): void {
  if (!ARKADE_CONTRACT_WATCHER_RECOVERY_ENABLED) return;
  if (recoverSubscriptionListenerInstalled) return;
  recoverSubscriptionListenerInstalled = true;
  EventBus.on("arkade:subscriptionLost", (payload?: { url?: string; body?: string }) => {
    const url = String(payload?.url || "unknown");
    void recoverArkadeSubscription(`subscription_lost url=${truncateForLog(url, 80)}`);
  });

  // B — AppState foreground recovery.
  AppState.addEventListener("change", (next: AppStateStatus) => {
    const prev = lastAppState;
    lastAppState = next;
    if (next !== "active") {
      lastForegroundActiveAtMs = Date.now();
      return;
    }
    if (prev === "active") return;
    const sinceMs = Date.now() - lastForegroundActiveAtMs;
    if (sinceMs < FOREGROUND_RESUBSCRIBE_GAP_MS) return;
    void recoverArkadeSubscription(`app_foreground_after_${Math.round(sinceMs / 1000)}s`);
  });

  // A — sniff SDK console.error for subscription-lost patterns.
  subscribeToBufferedLogs((entry) => {
    if (entry.level !== "error" && entry.level !== "warn") return;
    const message = entry.message || "";
    if (isContractWatcherRecoveryMessage(message)) {
      void recoverArkadeSubscription("log_sniff subscription_not_found");
    }
  });
}
