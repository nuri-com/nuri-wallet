// services/pricing/PriceService.ts
// Historical BTC fiat price via mempool.space REST API

import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { homeCurrencyService } from "../../lib/currency/HomeCurrencyService";
import { MEMPOOL_BASE_URL } from "../../config/endpoints";
import btcSpotPriceService from "./BtcSpotPriceService";
import type { FiatCode } from "../../lib/tokens";

// Within this window the spot price stands in for the historical one.
const RECENT_PRICE_WINDOW_SEC = 48 * 60 * 60;

const PRICE_CACHE_PREFIX = "price:";
const getCacheKey = (currency: string, tsSec: number) =>
  `${PRICE_CACHE_PREFIX}${currency.toLowerCase()}:${Math.floor(tsSec)}`;

class PriceService {
  // key: `${currency}:${tsSec}`, value: fiat price
  private priceCache: Map<string, number> = new Map();
  private baseRoot = MEMPOOL_BASE_URL;

  private cacheKey(currency: string, tsSec: number): string {
    return `${currency}:${Math.floor(tsSec)}`;
  }

  /** Get the home currency code for price lookups. */
  private homeCurrency(): string {
    return homeCurrencyService.getHomeCurrency();
  }

  getCachedPriceAt(tsSec: number, currency?: string): number | null {
    const cur = currency ?? this.homeCurrency();
    const k = this.cacheKey(cur, tsSec);
    const cached = this.priceCache.get(k);
    return cached ?? null;
  }

  /** @deprecated Use getCachedPriceAt */
  getCachedEURAt(tsSec: number): number | null {
    return this.getCachedPriceAt(tsSec);
  }

  async getPriceAt(tsSec: number, currency?: string): Promise<number | null> {
    const cur = currency ?? this.homeCurrency();
    const k = this.cacheKey(cur, tsSec);
    const ts = Math.floor(tsSec);
    const memoized = this.priceCache.get(k);
    if (memoized !== undefined) return memoized;
    try {
      const cached = await getCacheValue<number>(getCacheKey(cur, ts));
      if (typeof cached === "number") {
        this.priceCache.set(k, cached);
        return cached;
      }
    } catch {}
    const url = `${this.baseRoot}/api/v1/historical-price?currency=${encodeURIComponent(cur)}&timestamp=${ts}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`mempool price error: ${res.status} ${res.statusText}`);
      const data = await res.json();
      const price =
        Array.isArray(data?.prices) && data.prices.length > 0
          ? (data.prices[0]?.[cur] ?? null)
          : null;
      if (typeof price === "number") {
        this.priceCache.set(k, price);
        try {
          await setCacheValue(getCacheKey(cur, ts), price);
        } catch {}
        return price;
      }
      return this.recentSpotFallback(ts, cur);
    } catch (_e) {
      return this.recentSpotFallback(ts, cur);
    }
  }

  /**
   * The historical endpoint lives on mempool.space, which is not reachable from
   * every network — and a transaction from an hour ago showing "— €" is the
   * whole list looking broken. For anything recent the spot price IS the
   * historical price to within rounding, and the spot service has its own
   * exchange feeds (Coingecko, Kraken, Bitstamp) that answer when mempool does
   * not. Older transactions keep no figure rather than a made-up one.
   */
  private recentSpotFallback(tsSec: number, currency: string): number | null {
    if (Date.now() / 1000 - tsSec > RECENT_PRICE_WINDOW_SEC) return null;
    const spot = btcSpotPriceService.getCachedValid(currency as FiatCode);
    const price = spot?.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
    this.priceCache.set(this.cacheKey(currency, tsSec), price);
    return price;
  }

  /** @deprecated Use getPriceAt */
  async getEURAt(tsSec: number): Promise<number | null> {
    return this.getPriceAt(tsSec);
  }

  async getPriceForBatch(
    timestampsSec: number[],
    currency?: string,
    concurrency = 4,
  ): Promise<void> {
    const cur = currency ?? this.homeCurrency();
    const uniq = Array.from(new Set(timestampsSec.map((t) => Math.floor(t))));
    const queue = uniq.filter((t) => !this.priceCache.has(this.cacheKey(cur, t)));
    let idx = 0;
    const worker = async () => {
      while (idx < queue.length) {
        const my = queue[idx++];
        await this.getPriceAt(my, cur);
      }
    };
    const tasks = new Array(Math.min(concurrency, queue.length)).fill(0).map(worker);
    await Promise.all(tasks);
  }

  /** @deprecated Use getPriceForBatch */
  async getEURForBatch(timestampsSec: number[], concurrency = 4): Promise<void> {
    return this.getPriceForBatch(timestampsSec, undefined, concurrency);
  }
}

export const priceService = new PriceService();
export default priceService;
