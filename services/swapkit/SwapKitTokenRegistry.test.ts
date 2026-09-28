import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
  getChainRpcUrl: vi.fn(),
}));

vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));
vi.mock("../../lib/rpc/chainRpc", () => ({
  getChainRpcUrl: mocks.getChainRpcUrl,
}));

import { __resetTokenRegistryCache, resolveCanonicalToken } from "./SwapKitTokenRegistry";

const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARBITRUM_TBTC = "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40";
const okResponse = (body: unknown) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  __resetTokenRegistryCache();
  mocks.getCacheValue.mockResolvedValue(null);
  mocks.setCacheValue.mockResolvedValue(undefined);
  mocks.getChainRpcUrl.mockReturnValue("https://rpc.example");
  vi.useRealTimers();
});

describe("resolveCanonicalToken", () => {
  it("returns the registry's contract for an exact symbol match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ address: ARBITRUM_USDC, decimals: 6, symbol: "USDC" })),
    );

    await expect(resolveCanonicalToken(42161, "USDC")).resolves.toMatchObject({
      address: ARBITRUM_USDC,
      decimals: 6,
      chainId: 42161,
    });
  });

  it("refuses a fuzzy symbol match, the same guard the server applies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ address: ARBITRUM_USDC, decimals: 6, symbol: "USDC.e" })),
    );

    await expect(resolveCanonicalToken(42161, "USDC")).resolves.toBeNull();
  });

  it("retries after a transient outage instead of caching the miss for a day", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(okResponse({ address: ARBITRUM_USDC, decimals: 6, symbol: "USDC" }));
    vi.stubGlobal("fetch", fetchMock);

    // The outage resolves to null and is remembered only briefly...
    await expect(resolveCanonicalToken(42161, "USDC")).resolves.toBeNull();
    // ...so once it clears, the very next scan resolves the token again rather
    // than refusing valid balances until the positive TTL expires.
    vi.setSystemTime(Date.now() + 61_000);
    await expect(resolveCanonicalToken(42161, "USDC")).resolves.toMatchObject({
      address: ARBITRUM_USDC,
    });
    vi.useRealTimers();
  });

  it("falls back to the pinned Arbitrum tBTC contract before a first successful registry lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(resolveCanonicalToken(42161, "tBTC")).resolves.toMatchObject({
      address: ARBITRUM_TBTC,
      decimals: 18,
      chainId: 42161,
      symbol: "tBTC",
    });
  });

  it("falls back to the last confirmed address while the registry is unreachable", async () => {
    mocks.getCacheValue.mockResolvedValue({
      chainId: 42161,
      address: ARBITRUM_USDC,
      decimals: 6,
      symbol: "USDC",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(resolveCanonicalToken(42161, "USDC")).resolves.toMatchObject({
      address: ARBITRUM_USDC,
    });
  });
});
