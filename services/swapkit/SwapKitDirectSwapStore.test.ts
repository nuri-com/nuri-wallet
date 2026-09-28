import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
}));

vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));

import { SwapKitDirectSwapStore, type DirectSwapRecord } from "./SwapKitDirectSwapStore";

const RECORD: DirectSwapRecord = {
  txId: "sk_unsigned",
  provider: "lifi",
  routeId: "lifi-eurc-base-usdc-base",
  tracking: "swap_track",
  fromAsset: "EURC_BASE",
  toAsset: "USDC_BASE",
  settleTarget: "0x1111111111111111111111111111111111111111",
  owner: "0x1111111111111111111111111111111111111111",
  amount: 10,
  minReceive: 9.8,
  chainId: 8453,
  createdAt: 1,
};

let stored: unknown = [];

beforeEach(async () => {
  vi.clearAllMocks();
  stored = [];
  mocks.getCacheValue.mockImplementation(async () => structuredClone(stored));
  mocks.setCacheValue.mockImplementation(async (_key, value) => {
    stored = structuredClone(value);
  });
  await SwapKitDirectSwapStore.clear();
  await SwapKitDirectSwapStore.addDurable(RECORD);
});

describe("SwapKitDirectSwapStore.retireUnsignedDurable", () => {
  it("verifies the fail-closed marker before removing the row", async () => {
    const writes: unknown[] = [];
    mocks.setCacheValue.mockImplementation(async (_key, value) => {
      writes.push(structuredClone(value));
      stored = structuredClone(value);
    });

    await SwapKitDirectSwapStore.retireUnsignedDurable(RECORD.txId);

    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual([
      expect.objectContaining({ txId: RECORD.txId, abandonedAt: expect.any(Number) }),
    ]);
    expect(writes[1]).toEqual([]);
    expect(SwapKitDirectSwapStore.list()).toEqual([]);
    expect(stored).toEqual([]);
  });

  it("leaves the verified non-signable marker on disk if removal persistence fails", async () => {
    let writes = 0;
    mocks.setCacheValue.mockImplementation(async (_key, value) => {
      writes += 1;
      if (writes === 2) throw new Error("removal write failed");
      stored = structuredClone(value);
    });

    await expect(SwapKitDirectSwapStore.retireUnsignedDurable(RECORD.txId)).rejects.toThrow(
      "removal write failed",
    );

    expect(stored).toEqual([
      expect.objectContaining({ txId: RECORD.txId, abandonedAt: expect.any(Number) }),
    ]);
  });
});
