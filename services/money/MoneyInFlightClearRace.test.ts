import { beforeEach, describe, expect, it, vi } from "vitest";

// clear() wins over a cache read that was already running for the previous
// identity.
const cache = vi.hoisted(() => ({
  release: null as null | ((rows: unknown) => void),
  writes: [] as unknown[],
}));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: (): (() => void) => () => {} },
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: (): Promise<unknown> =>
    new Promise((resolve) => {
      cache.release = resolve;
    }),
  setCacheValue: async (_key: string, value: unknown): Promise<void> => {
    cache.writes.push(value);
  },
}));

import { MoneyInFlightStore } from "./MoneyInFlightStore";

const OLD = {
  id: "old-wallet-order",
  from: { rail: "wallet", amount: 5, unit: "EUR" },
  to: null as null,
  kind: "swap",
  createdAt: "2026-09-25T10:00:00.000Z",
};

beforeEach(() => {
  MoneyInFlightStore._resetForTests({ cold: true });
  cache.release = null;
  cache.writes = [];
});

describe("clear during hydration", () => {
  it("the previous identity's rows never come back", async () => {
    const hydrating = MoneyInFlightStore.hydrate();
    const clearing = MoneyInFlightStore.clear();
    cache.release?.([OLD]);
    await Promise.all([hydrating, clearing]);
    expect(MoneyInFlightStore.list()).toEqual([]);
    expect(cache.writes.at(-1)).toEqual([]);
  });
});
