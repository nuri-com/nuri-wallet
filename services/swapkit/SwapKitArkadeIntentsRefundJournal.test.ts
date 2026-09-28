import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = new Map<string, unknown>();
const mocks = {
  getCacheValue: vi.fn(async (key: string) => cache.get(key) ?? null),
  setCacheValue: vi.fn(async (key: string, value: unknown) => {
    cache.set(key, JSON.parse(JSON.stringify(value)));
  }),
};
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: (key: string) => mocks.getCacheValue(key),
  setCacheValue: (key: string, value: unknown) => mocks.setCacheValue(key, value),
}));

import { journalEntry, loadJournal } from "./SwapKitArkadeIntentsRefundJournal";

const entry = (over: Record<string, unknown> = {}) => ({
  swapPkScriptHex: "5120aa",
  paymentHash: "bb".repeat(32),
  rfqId: "rfq-1",
  startedAtMs: 1_700_000_000_000,
  ...over,
});

beforeEach(() => {
  cache.clear();
  mocks.getCacheValue.mockClear();
  mocks.setCacheValue.mockClear();
});

describe("the refund journal", () => {
  it("keeps one entry per action and fills the txid in afterwards", async () => {
    await journalEntry("action-1", entry());
    await journalEntry("action-2", entry({ rfqId: "rfq-2" }));
    await journalEntry("action-1", { swapPkScriptHex: "5120aa", txid: "txid-1" });

    const journal = await loadJournal();
    expect(Object.keys(journal).sort()).toEqual(["action-1", "action-2"]);
    expect(journal["action-1"]?.txid).toBe("txid-1");
    expect(journal["action-1"]?.rfqId).toBe("rfq-1");
  });

  // A read that failed is not an empty journal. The write replaces the whole
  // record, so a tolerant read would drop every other attempt marker — including
  // one written before a push that already broadcast, which is the only thing
  // that sends a later run looking for that refund's txid instead of concluding
  // there is nothing to return.
  it("refuses to write when the journal cannot be read, and preserves every entry", async () => {
    await journalEntry("action-1", entry());
    await journalEntry("action-2", entry({ rfqId: "rfq-2" }));
    mocks.getCacheValue.mockRejectedValueOnce(new Error("cache unavailable"));

    await expect(journalEntry("action-3", entry({ rfqId: "rfq-3" }))).rejects.toThrow(
      /cache unavailable/,
    );

    const journal = await loadJournal();
    expect(Object.keys(journal).sort()).toEqual(["action-1", "action-2"]);
    expect(mocks.setCacheValue).toHaveBeenCalledTimes(2);
  });

  it("writes again after a failed read", async () => {
    await journalEntry("action-1", entry());
    mocks.getCacheValue.mockRejectedValueOnce(new Error("cache unavailable"));
    await journalEntry("action-2", entry({ rfqId: "rfq-2" })).catch((): void => undefined);

    await journalEntry("action-2", entry({ rfqId: "rfq-2" }));

    expect(Object.keys(await loadJournal()).sort()).toEqual(["action-1", "action-2"]);
  });

  // Reading for a decision is allowed to be tolerant: an unreadable journal
  // means the recovery path falls back to asking the chain, which is the same
  // thing it does for an attempt it has never seen.
  it("reads as empty rather than throwing when only listing", async () => {
    mocks.getCacheValue.mockRejectedValueOnce(new Error("cache unavailable"));

    expect(await loadJournal()).toEqual({});
  });
});
