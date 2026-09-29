// services/app/BalanceDriversService.ts
//
// One switch for every headless balance driver, and one subscribable view over
// the figures they produce. Each driver owns its own domain — this only starts
// them together and fans their snapshots in, so a caller with no tab screens
// (App, or the single screen that replaces them) has exactly one thing to start
// and one thing to read.
//
// Not a store: it holds no balance of its own. Every figure below is read
// straight from the service that owns it.

import {
  startBitcoinBalanceDriver,
  stopBitcoinBalanceDriver,
} from "../bitcoin/BitcoinBalanceDriver";
import { bitcoinBalanceStore } from "../bitcoin/BitcoinBalanceStore";
import { btcFiatRateStore } from "../pricing/BtcFiatRateStore";
import {
  startPendingWalletTransfers,
  stopPendingWalletTransfers,
} from "../balance/PendingWalletTransfersStore";
import {
  startPendingTransferSettleWatcher,
  stopPendingTransferSettleWatcher,
} from "../balance/PendingTransferSettleWatcher";
import { walletBalanceStore } from "../balance/WalletBalanceStore";
import { usdcBalanceStore } from "../balance/UsdcBalanceStore";
import {
  startPendingSendsReconciler,
  stopPendingSendsReconciler,
} from "../bitcoin/PendingSendsReconciler";
import { wirexAccountService } from "../wirex/WirexAccountService";
import { startInFlightDoneWatcher, stopInFlightDoneWatcher } from "../money/InFlightDoneWatcher";

export type HeadlessBalances = {
  /** Wirex card balance in EUR; null until a figure is known (never a stand-in 0). */
  cardBalanceEur: number | null;
  /** Arkade balance in sats. */
  bitcoinSats: number;
  /** Wallet Base-mainnet EURC in EUR; null until known. */
  walletBalanceEur: number | null;
  /** Wallet Base-mainnet USDC in USD, on the same EOA; null until known. */
  walletBalanceUsd: number | null;
  /** Fiat per whole BTC and the currency it is quoted in. */
  btcFiatRate: number | null;
  btcFiatCurrency: string | null;
};

/**
 * Start every balance driver. Idempotent, and safe to call again whenever the
 * gate reopens — each driver no-ops if it is already running. Call it only once
 * signed in and unlocked: these are authenticated reads, and the store contract
 * is that nothing runs pre-login or behind the biometric lock.
 */
export function startBalanceDrivers(): void {
  startBitcoinBalanceDriver();
  startInFlightDoneWatcher();
  startPendingSendsReconciler();
  startPendingWalletTransfers();
  startPendingTransferSettleWatcher();
  btcFiatRateStore.start();
  walletBalanceStore.start();
  usdcBalanceStore.start();
  wirexAccountService.startBalancePolling();
}

export function stopBalanceDrivers(): void {
  stopBitcoinBalanceDriver();
  stopInFlightDoneWatcher();
  stopPendingSendsReconciler();
  stopPendingWalletTransfers();
  stopPendingTransferSettleWatcher();
  btcFiatRateStore.stop();
  walletBalanceStore.stop();
  usdcBalanceStore.stop();
  wirexAccountService.stopBalancePolling();
}

const listeners = new Set<() => void>();
let sourceUnsubscribe: Array<() => void> = [];
let current: HeadlessBalances | null = null;
let dirty = true;

function build(): HeadlessBalances {
  const rate = btcFiatRateStore.getSnapshot();
  return {
    cardBalanceEur: wirexAccountService.getSnapshot().balanceEur,
    bitcoinSats: bitcoinBalanceStore.getSnapshot().bitcoinBalance.total,
    walletBalanceEur: walletBalanceStore.getSnapshot().balanceEur,
    walletBalanceUsd: usdcBalanceStore.getSnapshot().balanceUsd,
    btcFiatRate: rate.rate,
    btcFiatCurrency: rate.currency,
  };
}

function isSame(a: HeadlessBalances, b: HeadlessBalances): boolean {
  return (
    a.cardBalanceEur === b.cardBalanceEur &&
    a.bitcoinSats === b.bitcoinSats &&
    a.walletBalanceEur === b.walletBalanceEur &&
    a.walletBalanceUsd === b.walletBalanceUsd &&
    a.btcFiatRate === b.btcFiatRate &&
    a.btcFiatCurrency === b.btcFiatCurrency
  );
}

function onSourceChange(): void {
  dirty = true;
  for (const listener of listeners) listener();
}

/**
 * Stable across calls unless one of the figures actually moved, so it can back a
 * `useSyncExternalStore` without re-rendering on every unchanged poll.
 */
export function getBalancesSnapshot(): HeadlessBalances {
  if (!current || dirty) {
    dirty = false;
    const next = build();
    if (!current || !isSame(current, next)) current = next;
  }
  return current;
}

export function subscribeBalances(listener: () => void): () => void {
  if (listeners.size === 0) {
    sourceUnsubscribe = [
      wirexAccountService.subscribe(onSourceChange),
      bitcoinBalanceStore.subscribe(onSourceChange),
      walletBalanceStore.subscribe(onSourceChange),
      usdcBalanceStore.subscribe(onSourceChange),
      btcFiatRateStore.subscribe(onSourceChange),
    ];
    // Sources kept moving while nothing was listening, so the memoised snapshot
    // has to be rebuilt before the first read.
    dirty = true;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    for (const off of sourceUnsubscribe) {
      try {
        off();
      } catch {}
    }
    sourceUnsubscribe = [];
  };
}
