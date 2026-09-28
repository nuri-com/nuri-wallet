import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
}));

vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: () => () => {} },
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));

import {
  type PendingBitcoinSend,
  PendingBitcoinSendsStore,
  pendingSendsForRail,
} from "./PendingBitcoinSendsStore";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setCacheValue.mockResolvedValue(undefined);
});

describe("pending bitcoin sends", () => {
  // The two bitcoin rails are two balances and two board rows. A send recorded
  // without its rail can only be shown on both or on neither — the first states
  // a debit the other wallet never took, the second leaves a broadcast send with
  // no sign that it happened.
  it("records which wallet paid, for both bitcoin sources", async () => {
    mocks.getCacheValue.mockResolvedValue([]);
    await PendingBitcoinSendsStore.add({ txid: "aa", amountSats: 1_000, source: "arkade" });
    await PendingBitcoinSendsStore.add({ txid: "bb", amountSats: 2_000, source: "onchain" });

    const rows = await PendingBitcoinSendsStore.list();
    expect(pendingSendsForRail(rows, "arkade")).toMatchObject([{ txid: "aa", amountSats: 1_000 }]);
    expect(pendingSendsForRail(rows, "onchain")).toMatchObject([{ txid: "bb", amountSats: 2_000 }]);
  });

  it("reads a row that names no wallet as an arkade one", () => {
    // Everything persisted before the field existed came from the arkade
    // corridor, which is the only writer there was.
    const rows: PendingBitcoinSend[] = [
      { txid: "cc", amountSats: 500, createdAt: new Date().toISOString() },
    ];
    expect(pendingSendsForRail(rows, "arkade")).toHaveLength(1);
    expect(pendingSendsForRail(rows, "onchain")).toEqual([]);
  });
});
