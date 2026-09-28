// services/pricing/BtcFiatRateStore.ts
//
// Singleton owner of the BTC → home-currency rate used to price the Bitcoin
// balance. The fetch, its cache and the home-currency re-fetch used to live in
// the Bitcoin screen and only ran while that tab was active, so the rate — and
// with it every fiat figure derived from a sats balance — existed only as long
// as the tab did. It is owned here instead and exposed via subscribe/getSnapshot
// for `useSyncExternalStore`.
//
// The rate has no cadence of its own: it is read on start, whenever the home
// currency changes, and whenever the app returns to the foreground.

import { MEMPOOL_PRICES_URL } from "../../config/endpoints";
import { homeCurrencyService } from "../../lib/currency/HomeCurrencyService";
import { EventBus } from "../events/AppEventBusService";
import {
  BALANCE_CACHE_KEYS,
  getCachedBalance,
  setCachedBalance,
} from "../balance/BalanceCacheService";
import { btcSpotPriceService } from "./BtcSpotPriceService";
import { onAppForegroundEnter } from "../app/ForegroundPoller";

export type BtcFiatRateSnapshot = {
  /** Fiat per whole BTC, or null when nothing has been read yet. */
  rate: number | null;
  currency: string | null;
  source: "cache" | "live";
};

class BtcFiatRateStore {
  private snapshot: BtcFiatRateSnapshot = { rate: null, currency: null, source: "cache" };
  private readonly listeners = new Set<(snapshot: BtcFiatRateSnapshot) => void>();
  private unsubscribe: Array<() => void> = [];
  private started = false;
  private inFlight: Promise<void> | null = null;

  getSnapshot(): BtcFiatRateSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: BtcFiatRateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setSnapshot(next: BtcFiatRateSnapshot): void {
    if (
      this.snapshot.rate === next.rate &&
      this.snapshot.currency === next.currency &&
      this.snapshot.source === next.source
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener(this.snapshot);
  }

  /** Idempotent — a second call while running is a no-op. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe.push(
      EventBus.on("currency:changed", () => {
        void this.refresh();
      }),
    );
    this.unsubscribe.push(
      onAppForegroundEnter(() => {
        void this.refresh();
      }),
    );
    void this.hydrateFromCache().then(() => this.refresh());
  }

  stop(): void {
    this.started = false;
    for (const off of this.unsubscribe) {
      try {
        off();
      } catch {}
    }
    this.unsubscribe = [];
  }

  private hasLiveRate(): boolean {
    return this.snapshot.source === "live";
  }

  /** Benign local cache read; never overwrites a live rate. */
  async hydrateFromCache(): Promise<void> {
    if (this.hasLiveRate()) return;
    try {
      const cached = await getCachedBalance(BALANCE_CACHE_KEYS.bitcoinFiatRate);
      if (this.hasLiveRate()) return;
      const amount = cached?.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount)) return;
      this.setSnapshot({
        rate: amount,
        currency: typeof cached?.currency === "string" ? cached.currency : null,
        source: "cache",
      });
    } catch {}
  }

  /** Read the live rate for the current home currency. Coalesced. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.readRate().finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async readRate(): Promise<void> {
    const homeCurrency = homeCurrencyService.getHomeCurrency();
    try {
      let rate: number | null = null;
      if (homeCurrency === "EUR") {
        // EUR flows through BtcSpotPriceService, which prefers the Nuri solver
        // oracle and falls back to the multi-feed median. Every other currency
        // keeps the raw mempool feed.
        const snap = await btcSpotPriceService.getFresh("EUR");
        rate = snap.valid && snap.price !== null && snap.price > 0 ? snap.price : null;
      } else {
        const response = await fetch(MEMPOOL_PRICES_URL);
        const json = await response.json();
        rate = Number(json?.[homeCurrency]);
      }
      if (rate === null || !Number.isFinite(rate)) return;
      this.setSnapshot({ rate, currency: homeCurrency, source: "live" });
      void setCachedBalance(BALANCE_CACHE_KEYS.bitcoinFiatRate, rate, homeCurrency);
    } catch {}
  }
}

export const btcFiatRateStore = new BtcFiatRateStore();
