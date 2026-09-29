// services/pricing/BtcSpotPriceService.ts
// Single BTC/fiat price source for the app.
// Aggregates Coingecko + Kraken + Bitstamp + mempool.space, takes the median,
// rejects the snapshot if max deviation from median exceeds MAX_SPREAD.
// No solver/swap dry-quote indirection — one source, used everywhere.

import { MEMPOOL_PRICES_URL } from "../../config/endpoints";
import type { FiatCode } from "../../lib/tokens";
import { errMsg, errName } from "../../lib/errorMessage";
import { logWithId, LOG_EMOJI } from "../../lib/OperationLogUtils";

const CACHE_TTL_MS = 30_000;
const MAX_SPREAD = 0.03;
const FEED_TIMEOUT_MS = 5_000;
const SOURCE = "services/pricing/BtcSpotPriceService.ts";

export type PriceSourceSample = {
  name: "coingecko" | "kraken" | "bitstamp" | "mempool";
  price: number | null;
  ok: boolean;
  error?: string;
};

export type BtcSpotSnapshot = {
  /** Median of valid samples (BTC/<currency>), or null when no valid feed. */
  price: number | null;
  /** True when at least one feed succeeded AND max deviation from median ≤ MAX_SPREAD. */
  valid: boolean;
  sources: PriceSourceSample[];
  /** Epoch ms when the snapshot was produced. */
  updatedAt: number;
  reason?: "no_valid_feeds" | "feed_spread_too_wide" | "stale_fallback";
};

type CurrencyState = {
  snapshot: BtcSpotSnapshot | null;
  lastValid: BtcSpotSnapshot | null;
};

async function fetchCoingecko(currency: FiatCode): Promise<PriceSourceSample> {
  const name = "coingecko" as const;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${currency.toLowerCase()}`,
      { signal: controller.signal },
    );
    if (!res.ok) return { name, price: null, ok: false, error: `http_${res.status}` };
    const json: any = await res.json();
    const raw = json?.bitcoin?.[currency.toLowerCase()];
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0) {
      return { name, price: null, ok: false, error: "invalid_number" };
    }
    return { name, price, ok: true };
  } catch (e: unknown) {
    if (errName(e) === "AbortError") return { name, price: null, ok: false, error: "timeout" };
    return { name, price: null, ok: false, error: errMsg(e, "error") };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKraken(currency: FiatCode): Promise<PriceSourceSample> {
  const name = "kraken" as const;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=XBT${currency}`, {
      signal: controller.signal,
    });
    if (!res.ok) return { name, price: null, ok: false, error: `http_${res.status}` };
    const json: any = await res.json();
    const result = json?.result || {};
    const firstKey = Object.keys(result)[0];
    const ticker = firstKey ? result[firstKey] : null;
    const lastStr = ticker?.c?.[0];
    const price = Number(lastStr);
    if (!Number.isFinite(price) || price <= 0) {
      return { name, price: null, ok: false, error: "invalid_number" };
    }
    return { name, price, ok: true };
  } catch (e: unknown) {
    if (errName(e) === "AbortError") return { name, price: null, ok: false, error: "timeout" };
    return { name, price: null, ok: false, error: errMsg(e, "error") };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBitstamp(currency: FiatCode): Promise<PriceSourceSample> {
  const name = "bitstamp" as const;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://www.bitstamp.net/api/v2/ticker/btc${currency.toLowerCase()}/`,
      { signal: controller.signal },
    );
    if (!res.ok) return { name, price: null, ok: false, error: `http_${res.status}` };
    const json: any = await res.json();
    const lastStr = json?.last;
    const price = Number(lastStr);
    if (!Number.isFinite(price) || price <= 0) {
      return { name, price: null, ok: false, error: "invalid_number" };
    }
    return { name, price, ok: true };
  } catch (e: unknown) {
    if (errName(e) === "AbortError") return { name, price: null, ok: false, error: "timeout" };
    return { name, price: null, ok: false, error: errMsg(e, "error") };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMempool(currency: FiatCode): Promise<PriceSourceSample> {
  const name = "mempool" as const;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(MEMPOOL_PRICES_URL, { signal: controller.signal });
    if (!res.ok) return { name, price: null, ok: false, error: `http_${res.status}` };
    const json: any = await res.json();
    const raw = json?.[currency];
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0) {
      return { name, price: null, ok: false, error: "invalid_number" };
    }
    return { name, price, ok: true };
  } catch (e: unknown) {
    if (errName(e) === "AbortError") return { name, price: null, ok: false, error: "timeout" };
    return { name, price: null, ok: false, error: errMsg(e, "error") };
  } finally {
    clearTimeout(timer);
  }
}

export class BtcSpotPriceService {
  private states: Map<FiatCode, CurrencyState> = new Map();
  private inflight: Map<FiatCode, Promise<BtcSpotSnapshot>> = new Map();

  async getFresh(currency: FiatCode): Promise<BtcSpotSnapshot> {
    const state = this.getState(currency);
    const now = Date.now();
    if (state.snapshot && now - state.snapshot.updatedAt <= CACHE_TTL_MS) {
      return state.snapshot;
    }

    const existing = this.inflight.get(currency);
    if (existing) return existing;

    const task = this.refresh(currency).finally(() => {
      this.inflight.delete(currency);
    });
    this.inflight.set(currency, task);
    return task;
  }

  /** Last valid snapshot for currency, or null. Synchronous. */
  getCachedValid(currency: FiatCode): BtcSpotSnapshot | null {
    return this.getState(currency).lastValid;
  }

  private getState(currency: FiatCode): CurrencyState {
    let state = this.states.get(currency);
    if (!state) {
      state = { snapshot: null, lastValid: null };
      this.states.set(currency, state);
    }
    return state;
  }

  private async refresh(currency: FiatCode): Promise<BtcSpotSnapshot> {
    const state = this.getState(currency);
    const fresh = await this.fetchAllFeeds(currency);

    if (fresh.valid && typeof fresh.price === "number" && fresh.price > 0) {
      state.snapshot = fresh;
      state.lastValid = fresh;
      logWithId(
        `${LOG_EMOJI.bitcoin} BtcPrice.fresh`,
        `median=${fresh.price} cur=${currency}`,
        {
          currency,
          median: fresh.price,
          sources: fresh.sources.map((s) => `${s.name}:${s.ok ? s.price : s.error}`).join(" "),
        },
        { source: `${SOURCE}#refresh`, event: "STATE", action: "price" },
      );
      return fresh;
    }

    const failed = fresh.sources
      .filter((s) => !s.ok)
      .map((s) => `${s.name}:${s.error || "error"}`)
      .join(",");
    logWithId(
      `${LOG_EMOJI.bitcoin} BtcPrice.invalid`,
      `reason=${fresh.reason} failed=[${failed}]`,
      { currency, reason: fresh.reason, failed },
      { source: `${SOURCE}#refresh`, event: "VALIDATION", action: "price" },
    );

    if (state.lastValid) {
      const fallback: BtcSpotSnapshot = {
        ...state.lastValid,
        reason: "stale_fallback",
        updatedAt: fresh.updatedAt,
      };
      state.snapshot = fallback;
      return fallback;
    }
    state.snapshot = fresh;
    return fresh;
  }

  private async fetchAllFeeds(currency: FiatCode): Promise<BtcSpotSnapshot> {
    const now = Date.now();
    const SOURCE_ORDER = ["coingecko", "kraken", "bitstamp", "mempool"] as const;
    const tasks = [
      fetchCoingecko(currency),
      fetchKraken(currency),
      fetchBitstamp(currency),
      fetchMempool(currency),
    ];
    const settled = await Promise.allSettled(tasks);

    const sources: PriceSourceSample[] = settled.map((res, i): PriceSourceSample => {
      if (res.status === "fulfilled") return res.value;
      return {
        name: SOURCE_ORDER[i],
        price: null,
        ok: false,
        error: res.reason?.message || String(res.reason) || "error",
      };
    });

    const okSamples = sources.filter((s) => s.ok && s.price !== null && s.price > 0);
    if (okSamples.length === 0) {
      return {
        price: null,
        valid: false,
        sources,
        updatedAt: now,
        reason: "no_valid_feeds",
      };
    }

    const prices = okSamples.map((s) => s.price as number).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 === 1 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;

    const maxSpread =
      prices.length > 1
        ? prices.reduce((max, p) => {
            const dev = Math.abs(p - median) / median;
            return dev > max ? dev : max;
          }, 0)
        : 0;

    const valid = maxSpread <= MAX_SPREAD;

    return {
      price: median,
      valid,
      sources,
      updatedAt: now,
      reason: valid ? undefined : "feed_spread_too_wide",
    };
  }
}

export const btcSpotPriceService = new BtcSpotPriceService();
export default btcSpotPriceService;
