// services/bitcoin/BitcoinBalanceDriver.ts
//
// The headless driver for `bitcoinBalanceStore`. It does what the Bitcoin
// screen's refresh hook did — cache hydration, the poll cadence, the
// `bitcoin:refresh` / `arkade:receiveUpdated` subscriptions — with one
// difference that is the whole point: the gate is the app being in the
// foreground, not a tab being on screen. The balance is therefore current
// without any screen mounted.
//
// It claims the store's poll ownership, so a Bitcoin screen that is still
// mounted keeps rendering from the same store but no longer contributes a
// second read per interval.

import { bitcoinBalanceStore, type ArkadeReceiveUpdatePayload } from "./BitcoinBalanceStore";
import { EventBus } from "../events/AppEventBusService";
import { BITCOIN_BALANCE_POLL_INTERVAL_MS } from "../../config/constants";
import { createForegroundPoller, type ForegroundPoller } from "../app/ForegroundPoller";
import { getNetworkStatus } from "../app/NetworkStatusService";

const POLL_OWNER = Symbol("BitcoinBalanceDriver");

let poller: ForegroundPoller | null = null;
let unsubscribe: Array<() => void> = [];

/** Idempotent — a second call while running is a no-op. */
export function startBitcoinBalanceDriver(): void {
  if (poller) return;

  bitcoinBalanceStore.claimPollOwnership(POLL_OWNER);

  unsubscribe.push(
    EventBus.on("bitcoin:refresh", () => {
      void bitcoinBalanceStore.refresh("event");
    }),
  );
  unsubscribe.push(
    EventBus.on<ArkadeReceiveUpdatePayload>("arkade:receiveUpdated", (payload) => {
      // A payload that already carries the settled figure is applied straight
      // to the store; anything else needs a fresh arkade read to resolve it.
      const handled = bitcoinBalanceStore.applyArkadeReceiveUpdate(payload);
      if (!handled) void bitcoinBalanceStore.refresh("arkadeUpdate");
    }),
  );

  void bitcoinBalanceStore.hydrateFromCache();

  poller = createForegroundPoller({
    intervalMs: BITCOIN_BALANCE_POLL_INTERVAL_MS,
    canTick: () => !getNetworkStatus().isWaitingForNetwork,
    tick: () => {
      void bitcoinBalanceStore.refresh("poll", POLL_OWNER);
    },
  });
  poller.start();
}

export function stopBitcoinBalanceDriver(): void {
  poller?.stop();
  poller = null;
  for (const off of unsubscribe) {
    try {
      off();
    } catch {}
  }
  unsubscribe = [];
  // Released, not held: with no headless driver running, a mounted screen's own
  // poll loop has to be able to keep the balance moving again.
  bitcoinBalanceStore.releasePollOwnership(POLL_OWNER);
}
