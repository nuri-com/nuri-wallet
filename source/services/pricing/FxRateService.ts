// services/pricing/FxRateService.ts
// Reads fiat FX rates relative to USD: Frankfurter API primary, Chainlink
// onchain oracles (Base mainnet) fallback.

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { FRANKFURTER_URL } from "../../config/endpoints";
import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { withFallback } from "../../lib/rpc/chainRpc";
import type { FiatCode } from "../../lib/tokens";

import {
  CHAINLINK_DECIMALS,
  CHAINLINK_EUR_USD_FEED,
  CHAINLINK_GBP_USD_FEED,
  FX_RATE_CACHE_TTL_MS,
} from "../../config/constants";

const CACHE_TTL_MS = FX_RATE_CACHE_TTL_MS;

// Base mainnet — FX reference data is read from mainnet regardless of APP_NETWORK.
const FX_FEED_CHAIN_ID = 8453;
const CHAINLINK_ABI = parseAbi(["function latestAnswer() view returns (int256)"]);

// --- Types ---

/** Rates relative to USD (e.g. { EUR: 1.158, GBP: 1.339, USD: 1.0 }) */
export type FxRates = Record<FiatCode, number>;

// --- Service ---

class FxRateService {
  private cachedRates: FxRates | null = null;
  private cacheTimestamp = 0;

  /**
   * Get FX rates for all supported fiat codes, relative to USD.
   * EUR/USD = 1.15 means 1 EUR = 1.15 USD.
   * Rates are cached for 5 minutes.
   */
  async getRates(): Promise<FxRates> {
    const op = newOp("FxRateService", "getRates", LOG_EMOJI.wallet);

    // Check cache
    if (this.cachedRates && Date.now() - this.cacheTimestamp < CACHE_TTL_MS) {
      op.log("cache hit");
      op.end("OK (cached)");
      return this.cachedRates;
    }

    op.log("cache miss, fetching from Frankfurter");

    try {
      const rates = await this.fetchFrankfurterRates(op);
      this.cachedRates = rates;
      this.cacheTimestamp = Date.now();
      op.log(`Frankfurter rates: EUR=${rates.EUR.toFixed(4)} GBP=${rates.GBP.toFixed(4)}`);
      op.end("OK");
      return rates;
    } catch (frankfurterErr) {
      op.warn("Frankfurter failed, trying Chainlink fallback", frankfurterErr);
    }

    try {
      const rates = await this.fetchChainlinkRates(op);
      this.cachedRates = rates;
      this.cacheTimestamp = Date.now();
      op.log(`Chainlink rates: EUR=${rates.EUR.toFixed(4)} GBP=${rates.GBP.toFixed(4)}`);
      op.end("OK (fallback)");
      return rates;
    } catch (chainlinkErr) {
      op.error("Both Frankfurter and Chainlink failed", chainlinkErr);
      op.end("FAIL");
      throw new Error("FX rates unavailable: both Frankfurter and Chainlink failed");
    }
  }

  /**
   * Convert an amount between fiat currencies.
   * Example: convert(100, "EUR", "GBP", rates) = 100 * (rates.EUR / rates.GBP)
   */
  convert(amount: number, from: FiatCode, to: FiatCode, rates: FxRates): number {
    if (from === to) return amount;
    const fromRate = rates[from];
    const toRate = rates[to];
    if (!fromRate || !toRate || toRate === 0) return amount;
    return amount * (fromRate / toRate);
  }

  // --- Private helpers ---

  private async fetchChainlinkRates(op: ReturnType<typeof newOp>): Promise<FxRates> {
    // Both EUR/USD and GBP/USD proxies live on Base mainnet; read them through a
    // single provider with primary→fallback RPC resilience.
    const [eurUsdRaw, gbpUsdRaw] = await withFallback(FX_FEED_CHAIN_ID, (client) =>
      Promise.all(
        [CHAINLINK_EUR_USD_FEED, CHAINLINK_GBP_USD_FEED].map(async (feed) => {
          const { data } = await client.call({
            to: feed as `0x${string}`,
            data: encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "latestAnswer" }),
          });
          if (!data) throw new Error(`latestAnswer returned no data from ${feed}`);
          return decodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "latestAnswer", data });
        }),
      ),
    );

    const eurUsd = Number(eurUsdRaw) / 10 ** CHAINLINK_DECIMALS;
    const gbpUsd = Number(gbpUsdRaw) / 10 ** CHAINLINK_DECIMALS;

    if (eurUsd <= 0 || gbpUsd <= 0) {
      throw new Error(`Invalid Chainlink values: EUR/USD=${eurUsd}, GBP/USD=${gbpUsd}`);
    }

    op.log(`Chainlink raw: EUR/USD=${eurUsd}, GBP/USD=${gbpUsd}`);

    return {
      EUR: eurUsd,
      GBP: gbpUsd,
      USD: 1.0,
    };
  }

  private async fetchFrankfurterRates(op: ReturnType<typeof newOp>): Promise<FxRates> {
    const res = await fetch(FRANKFURTER_URL);
    if (!res.ok) {
      throw new Error(`Frankfurter API error: ${res.status} ${res.statusText}`);
    }

    const data: { rates?: Record<string, number> } = await res.json();
    if (!data.rates) {
      throw new Error("Frankfurter API returned no rates");
    }

    op.log("Frankfurter response received", data.rates);

    // Frankfurter returns: from=USD, rates = { EUR: 0.87, GBP: 0.75 }
    // We need X/USD (how many USD per 1 X), so invert: EUR/USD = 1/0.87
    const usdToEur = data.rates.EUR;
    const usdToGbp = data.rates.GBP;

    if (!usdToEur || !usdToGbp) {
      throw new Error("Frankfurter missing EUR or GBP rate");
    }

    return {
      EUR: 1 / usdToEur,
      GBP: 1 / usdToGbp,
      USD: 1.0,
    };
  }
}

export const fxRateService = new FxRateService();

// Re-export convenience functions bound to the singleton
export const getRates = () => fxRateService.getRates();
export const convert = (amount: number, from: FiatCode, to: FiatCode, rates: FxRates) =>
  fxRateService.convert(amount, from, to, rates);

export default fxRateService;
