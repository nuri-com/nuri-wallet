import * as Network from "expo-network";
import {
  NETWORK_FAILURE_WINDOW_MS,
  NETWORK_FAILURE_STREAK_THRESHOLD,
} from "../../config/constants";
import { EventBus } from "../events/AppEventBusService";

export type NetworkStatus = {
  isConnected: boolean;
  isInternetReachable: boolean | null;
  type: Network.NetworkStateType | null;
  isOffline: boolean;
  isWaitingForNetwork: boolean;
  failureStreak: number;
  firstFailureAt: number | null;
  lastFailureAt: number | null;
  updatedAt: number;
};

let current: NetworkStatus = {
  isConnected: true,
  isInternetReachable: null,
  type: null,
  isOffline: false,
  isWaitingForNetwork: false,
  failureStreak: 0,
  firstFailureAt: null,
  lastFailureAt: null,
  updatedAt: Date.now(),
};

let subscription: ReturnType<typeof Network.addNetworkStateListener> | null = null;

const normalizeState = (state: Network.NetworkState): NetworkStatus => {
  const isConnected = !!state.isConnected;
  const isInternetReachable =
    typeof state.isInternetReachable === "boolean" ? state.isInternetReachable : null;
  const type = state.type ?? null;
  const isOffline = isConnected === false || isInternetReachable === false;
  return {
    isConnected,
    isInternetReachable,
    type,
    isOffline,
    isWaitingForNetwork: isOffline,
    failureStreak: current.failureStreak,
    firstFailureAt: current.firstFailureAt,
    lastFailureAt: current.lastFailureAt,
    updatedAt: Date.now(),
  };
};

const setCurrent = (state?: Network.NetworkState | null) => {
  if (!state) return;
  const next = normalizeState(state);
  const isWaitingForNetwork =
    next.isOffline || current.failureStreak >= NETWORK_FAILURE_STREAK_THRESHOLD;
  current = {
    ...next,
    isWaitingForNetwork,
  };
  EventBus.emit("network:status", current);
};

export async function startNetworkMonitor(): Promise<NetworkStatus> {
  if (subscription) return current;
  try {
    const initial = await Network.getNetworkStateAsync();
    setCurrent(initial);
  } catch {}
  subscription = Network.addNetworkStateListener((next) => {
    setCurrent(next);
  });
  return current;
}

export function stopNetworkMonitor() {
  if (!subscription) return;
  subscription.remove();
  subscription = null;
}

export function getNetworkStatus(): NetworkStatus {
  return current;
}

export function onNetworkStatusChange(listener: (state: NetworkStatus) => void): () => void {
  return EventBus.on("network:status", listener);
}

export function reportNetworkSuccess() {
  if (
    current.failureStreak === 0 &&
    current.firstFailureAt === null &&
    current.lastFailureAt === null
  ) {
    return;
  }
  current = {
    ...current,
    failureStreak: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    isWaitingForNetwork: current.isOffline,
    updatedAt: Date.now(),
  };
  EventBus.emit("network:status", current);
}

export function reportNetworkFailure() {
  const now = Date.now();
  const firstFailureAt = current.firstFailureAt ?? now;
  const isWithinWindow = now - firstFailureAt <= NETWORK_FAILURE_WINDOW_MS;
  const nextFirstFailureAt = isWithinWindow ? firstFailureAt : now;
  const nextFailureStreak = isWithinWindow ? current.failureStreak + 1 : 1;
  current = {
    ...current,
    failureStreak: nextFailureStreak,
    firstFailureAt: nextFirstFailureAt,
    lastFailureAt: now,
    isWaitingForNetwork: current.isOffline || nextFailureStreak >= NETWORK_FAILURE_STREAK_THRESHOLD,
    updatedAt: now,
  };
  EventBus.emit("network:status", current);
}
