import { expect, it, vi } from "vitest";

vi.mock("expo-sqlite", () => ({
  deleteDatabaseAsync: vi.fn(async () => undefined),
  openDatabaseAsync: vi.fn(async () => ({
    closeAsync: vi.fn(async () => undefined),
    execAsync: vi.fn(async () => undefined),
    getFirstAsync: vi.fn(async () => null),
    runAsync: vi.fn(async () => undefined),
  })),
}));

import { ethers } from "ethers";
import { MEMPOOL_API_BASE_URL } from "../../config/endpoints";
import { describeLiveIfEnv } from "../../test/liveEnv";
import { btcSpotPriceService } from "./BtcSpotPriceService";
import { fxRateService } from "./FxRateService";
import { priceService } from "./PriceService";
import { withFallback } from "../../lib/rpc/chainRpc";
import { CIRCLE_EURC_BASE_MAINNET, SUPPORTED_FIAT_CODES } from "../../lib/tokens";

const LIVE_ENV = ["NURI_LIVE_CONTRACTS"];
const KNOWN_BASE_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;
const ERC20_ABI = ["function balanceOf(address account) view returns (uint256)"] as const;

function expectFinitePositive(value: unknown) {
  expect(typeof value).toBe("number");
  expect(Number.isFinite(value)).toBe(true);
  expect(value as number).toBeGreaterThan(0);
}

describeLiveIfEnv("pricing live contracts", LIVE_ENV, () => {
  it("returns a valid fresh BTC spot snapshot for EUR", async () => {
    const snapshot = await btcSpotPriceService.getFresh("EUR");

    expect(snapshot.valid).toBe(true);
    expectFinitePositive(snapshot.price);
    expect(Array.isArray(snapshot.sources)).toBe(true);
    expect(snapshot.sources.length).toBeGreaterThan(0);
    expect(snapshot.sources.some((source) => source.ok && typeof source.price === "number")).toBe(
      true,
    );
  });

  it("returns finite positive FX rates for every supported fiat code", async () => {
    const rates = await fxRateService.getRates();

    for (const fiat of SUPPORTED_FIAT_CODES) {
      expectFinitePositive(rates[fiat]);
    }
  });

  it("returns a finite positive historical BTC price", async () => {
    const yesterdayNoonUtc = Math.floor(Date.now() / 1000) - 36 * 60 * 60;
    const price = await priceService.getPriceAt(yesterdayNoonUtc, "EUR");

    expectFinitePositive(price);
  });
});

describeLiveIfEnv("Base and Esplora live contracts", LIVE_ENV, () => {
  it("reads Base native and EURC balances for a known address", async () => {
    const [nativeBalance, eurcBalance] = await withFallback(8453, async (provider) => {
      const token = new ethers.Contract(CIRCLE_EURC_BASE_MAINNET.address, ERC20_ABI, provider);
      return Promise.all([
        provider.getBalance(KNOWN_BASE_ADDRESS),
        token.balanceOf(KNOWN_BASE_ADDRESS) as Promise<bigint>,
      ]);
    });

    expect(typeof nativeBalance).toBe("bigint");
    expect(nativeBalance).toBeGreaterThanOrEqual(0n);
    expect(typeof eurcBalance).toBe("bigint");
    expect(eurcBalance).toBeGreaterThanOrEqual(0n);
  });

  it("returns finite Esplora fee estimates", async () => {
    const response = await fetch(`${MEMPOOL_API_BASE_URL}/v1/fees/recommended`);
    expect(response.ok, `Esplora fees endpoint returned ${response.status}`).toBe(true);
    const fees = (await response.json()) as Record<string, unknown>;

    for (const fee of [fees.fastestFee, fees.halfHourFee, fees.hourFee, fees.economyFee]) {
      expect(typeof fee).toBe("number");
      expect(Number.isFinite(fee)).toBe(true);
      expect(fee).toBeGreaterThanOrEqual(0);
    }
  });
});
