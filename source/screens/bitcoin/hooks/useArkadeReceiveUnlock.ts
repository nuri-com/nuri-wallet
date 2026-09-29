import { useCallback, useEffect, useRef, useState } from "react";
import { ARKADE_BOARDING_MONITOR_INTERVAL_MS } from "../../../config/constants";
import {
  addArkadeReceiveUnlockStateListener,
  getArkadeReceiveUnlockState,
  refreshArkadeReceiveUnlockState,
  runArkadeReceiveUnlock,
  type ArkadeReceiveUnlockResult,
  type ArkadeReceiveUnlockState,
} from "../../../services/arkade/ArkadeReceiveUnlockService";
import { EventBus } from "../../../services/events/AppEventBusService";

// Subscribe-only view of the receive-unlock state. Used where a component just
// needs to read the latest state (e.g. optimistic balance) without driving the
// refresh loop — the App-level monitor owns the refreshing.
export function useArkadeReceiveUnlockState(): ArkadeReceiveUnlockState {
  const [unlockState, setUnlockState] = useState<ArkadeReceiveUnlockState>(() =>
    getArkadeReceiveUnlockState(),
  );

  useEffect(() => addArkadeReceiveUnlockStateListener(setUnlockState), []);

  return unlockState;
}

type UseArkadeReceiveUnlockMonitorOptions = {
  enabled: boolean;
  isAppActive: boolean;
  isWaitingForNetwork: boolean;
};

// App-level monitor that drives receive-unlock detection on every tab. It polls
// and listens for updates regardless of the active tab so an incoming payment is
// detected while the user is on Wallet or Card, not only on Bitcoin.
export function useArkadeReceiveUnlockMonitor(opts: UseArkadeReceiveUnlockMonitorOptions): {
  unlockState: ArkadeReceiveUnlockState;
  refreshUnlockState: () => Promise<ArkadeReceiveUnlockState>;
  runUnlock: () => Promise<ArkadeReceiveUnlockResult>;
} {
  const { enabled, isAppActive, isWaitingForNetwork } = opts;
  const unlockState = useArkadeReceiveUnlockState();
  const inFlightRef = useRef(false);

  const refreshUnlockState = useCallback(
    () =>
      refreshArkadeReceiveUnlockState({
        reason: "app_monitor",
        forceFresh: false,
      }),
    [],
  );

  const runUnlock = useCallback(() => runArkadeReceiveUnlock("bitcoin_unlock_wallet"), []);

  useEffect(() => {
    if (!enabled || !isAppActive || isWaitingForNetwork) return;
    let cancelled = false;

    const refresh = async () => {
      if (cancelled || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const next = await refreshUnlockState();
        console.log(
          `[ArkadeReceiveUnlockMonitor] refreshed status=${next.status} actionable=${next.actionableCount} sats=${next.actionableSats}`,
        );
      } catch {
        // Refresh service logs detailed failures; keep the monitor alive.
      } finally {
        inFlightRef.current = false;
      }
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, ARKADE_BOARDING_MONITOR_INTERVAL_MS);
    const offReceive = EventBus.on("arkade:receiveUpdated", () => {
      void refresh();
    });
    const offBitcoin = EventBus.on("bitcoin:refresh", () => {
      void refresh();
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      offReceive();
      offBitcoin();
    };
  }, [enabled, isAppActive, isWaitingForNetwork, refreshUnlockState]);

  return {
    unlockState,
    refreshUnlockState,
    runUnlock,
  };
}
