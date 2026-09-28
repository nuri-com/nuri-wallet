import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
  publishSnapshot: vi.fn(),
}));

vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));
vi.mock("../nostr/NostrBackupService", () => ({
  publishSwapKitRecoverySnapshotToNostr: mocks.publishSnapshot,
}));

import { SwapKitOrderStore } from "./SwapKitOrderStore";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setCacheValue.mockResolvedValue(undefined);
  mocks.publishSnapshot.mockResolvedValue(undefined);
});

describe("SwapKitOrderStore", () => {
  it("retains old recoverable rows indefinitely and persists public recovery coordinates", async () => {
    mocks.getCacheValue.mockResolvedValueOnce([
      {
        txId: "old-recoverable-order",
        settleTarget: "0x1111111111111111111111111111111111111111",
        expectedUsdc: 5,
        minEurc: 4.9,
        usdcBaseline: "1000000",
        sats: 10_000,
        arkadeRefundAddress: "ark1localrefund",
        createdAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
        attempts: 1,
        recovery: {
          provider: "satora",
          keyIndex: 7,
          actionId: "wa-7",
          operation: "claim_order",
          externalId: "satora-7",
          status: "RECOVERY_PENDING",
          transactionHashes: [`0x${"a".repeat(64)}`],
        },
      },
    ]);

    await SwapKitOrderStore.hydrate();
    expect(SwapKitOrderStore.list()).toHaveLength(1);
    expect(SwapKitOrderStore.list()[0].recovery).toMatchObject({
      provider: "satora",
      keyIndex: 7,
      actionId: "wa-7",
    });
    expect(SwapKitOrderStore.list()[0].arkadeRefundAddress).toBe("ark1localrefund");

    await SwapKitOrderStore.add(SwapKitOrderStore.list()[0]);

    expect(mocks.setCacheValue).toHaveBeenCalledWith(
      "swapkit:orders:v1",
      expect.arrayContaining([
        expect.objectContaining({
          txId: "old-recoverable-order",
          arkadeRefundAddress: "ark1localrefund",
          recovery: expect.any(Object),
        }),
      ]),
    );
  });

  it("does not drop an order added before the initial hydrate resolves", async () => {
    // Fresh module instance so isHydrated starts false and the race is real.
    vi.resetModules();
    // Storage holds an older row; hydrate replaces `memory` with it, which used
    // to clobber a row added before hydrate finished.
    mocks.getCacheValue.mockResolvedValue([
      {
        txId: "stored-order",
        settleTarget: "0x2222222222222222222222222222222222222222",
        expectedUsdc: 5,
        minEurc: 4.9,
        usdcBaseline: "1000000",
        sats: 10_000,
        createdAt: 1,
        attempts: 0,
      },
    ]);
    const { SwapKitOrderStore: store } = await import("./SwapKitOrderStore");

    // Kick hydrate but do not await it; add immediately.
    void store.hydrate();
    await store.add({
      txId: "raced-order",
      settleTarget: "0x3333333333333333333333333333333333333333",
      expectedUsdc: 5,
      minEurc: 4.9,
      usdcBaseline: "1000000",
      sats: 10_000,
      createdAt: 2,
      attempts: 0,
    });

    // Both survive — the added row is not clobbered by the completing hydrate,
    // and it is persisted (persist() no longer no-ops mid-hydrate).
    const ids = store.list().map((o) => o.txId);
    expect(ids).toContain("raced-order");
    expect(ids).toContain("stored-order");
    expect(mocks.setCacheValue).toHaveBeenCalledWith(
      "swapkit:orders:v1",
      expect.arrayContaining([expect.objectContaining({ txId: "raced-order" })]),
    );
  });
});

// Review 5296394780: the order whose signed deposit is about to be broadcast must be proven on disk.
describe("SwapKitOrderStore.addDurable", () => {
  const recorded = {
    txId: "psbt-order",
    destination: "card" as const,
    settleTarget: "0x4444444444444444444444444444444444444444",
    expectedUsdc: 0,
    minEurc: 9.9,
    usdcBaseline: "0",
    stable: "EURC_BASE" as const,
    sats: 1_000,
    createdAt: 3,
    attempts: 0,
    recovery: {
      status: "FUNDING",
      externallyFundedDeposit: true,
      depositTo: "bc1qdeposit",
      depositAmount: "1000",
      depositTxHash: "f".repeat(64),
      depositRawTx: "0200deadbeef",
    },
  };

  async function freshStore(stored: unknown[] = []) {
    vi.resetModules();
    let disk: unknown = stored;
    mocks.getCacheValue.mockImplementation(async () => disk);
    mocks.setCacheValue.mockImplementation(async (_key: string, value: unknown) => {
      disk = JSON.parse(JSON.stringify(value));
    });
    const { SwapKitOrderStore: store } = await import("./SwapKitOrderStore");
    await store.hydrate();
    return { store, disk: () => disk };
  }

  it("returns only once the exact row, raw transaction included, reads back from storage", async () => {
    const { store, disk } = await freshStore();
    await store.addDurable(recorded);

    // Stored as a top-up even though the caller left the kind out: the resume depends on it.
    expect(disk()).toEqual([{ ...recorded, kind: "card_topup" }]);
    expect(store.list()).toEqual([{ ...recorded, kind: "card_topup" }]);
  });

  it("throws when the storage write fails, and leaves no row behind", async () => {
    const { store } = await freshStore();
    mocks.setCacheValue.mockRejectedValue(new Error("quota exceeded"));

    await expect(store.addDurable(recorded)).rejects.toThrow("quota exceeded");
    expect(store.list()).toEqual([]);
  });

  it("throws when what reads back is not what was written", async () => {
    const { store } = await freshStore();
    // A write that reports success but does not stick.
    mocks.setCacheValue.mockResolvedValue(undefined);
    mocks.getCacheValue.mockResolvedValue([]);

    await expect(store.addDurable(recorded)).rejects.toThrow("Order write could not be verified");
    expect(store.list()).toEqual([]);
  });

  it("throws when the row reads back without its raw transaction", async () => {
    const { store } = await freshStore();
    mocks.setCacheValue.mockResolvedValue(undefined);
    const { depositRawTx: _raw, ...recoveryWithoutRaw } = recorded.recovery;
    mocks.getCacheValue.mockResolvedValue([{ ...recorded, recovery: recoveryWithoutRaw }]);

    await expect(store.addDurable(recorded)).rejects.toThrow("Order write could not be verified");
  });
});

// Review 5296640685: addDurable awaits its write and read-back; an add() or remove() that runs in
// that window must survive it, in memory and on disk.
describe("SwapKitOrderStore mutations interleaved with addDurable", () => {
  const row = (txId: string, createdAt: number) => ({
    txId,
    settleTarget: "0x5555555555555555555555555555555555555555",
    expectedUsdc: 1,
    minEurc: 0.9,
    usdcBaseline: "0",
    sats: 1_000,
    createdAt,
    attempts: 0,
  });
  const recorded = {
    ...row("psbt-order", 10),
    recovery: {
      status: "FUNDING",
      externallyFundedDeposit: true,
      depositTxHash: "f".repeat(64),
      depositRawTx: "0200deadbeef",
    },
  };

  /** Storage whose next write is held until released, so another mutation can be started inside it. */
  async function heldStore(stored: unknown[]) {
    vi.resetModules();
    let disk: unknown = JSON.parse(JSON.stringify(stored));
    let hold: Promise<void> | null = null;
    let release: () => void = () => {};
    mocks.getCacheValue.mockImplementation(async () => disk);
    mocks.setCacheValue.mockImplementation(async (_key: string, value: unknown) => {
      const snapshot = JSON.parse(JSON.stringify(value));
      if (hold) {
        const waiting = hold;
        hold = null;
        await waiting;
      }
      disk = snapshot;
    });
    const { SwapKitOrderStore: store } = await import("./SwapKitOrderStore");
    await store.hydrate();
    return {
      store,
      disk: () => disk as Array<{ txId: string }>,
      holdNextWrite: () => {
        hold = new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      release: () => release(),
    };
  }
  const ids = (rows: Array<{ txId: string }>) => rows.map((r) => r.txId).sort();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps an order added while the verified write is in flight", async () => {
    const h = await heldStore([row("existing", 1)]);
    h.holdNextWrite();
    const durable = h.store.addDurable(recorded);
    await tick();
    const concurrent = h.store.add(row("added-meanwhile", 2));
    await tick();
    h.release();
    await Promise.all([durable, concurrent]);

    expect(ids(h.store.list())).toEqual(["added-meanwhile", "existing", "psbt-order"]);
    expect(ids(h.disk())).toEqual(["added-meanwhile", "existing", "psbt-order"]);
  });

  it("keeps an order removed while the verified write is in flight removed", async () => {
    const h = await heldStore([row("existing", 1), row("to-remove", 2)]);
    h.holdNextWrite();
    const durable = h.store.addDurable(recorded);
    await tick();
    const concurrent = h.store.remove("to-remove");
    await tick();
    h.release();
    await Promise.all([durable, concurrent]);

    expect(ids(h.store.list())).toEqual(["existing", "psbt-order"]);
    expect(ids(h.disk())).toEqual(["existing", "psbt-order"]);
  });

  it("keeps the verified row when an add started first and is still writing", async () => {
    const h = await heldStore([row("existing", 1)]);
    h.holdNextWrite();
    const first = h.store.add(row("added-first", 2));
    await tick();
    const durable = h.store.addDurable(recorded);
    await tick();
    h.release();
    await Promise.all([first, durable]);

    expect(ids(h.store.list())).toEqual(["added-first", "existing", "psbt-order"]);
    expect(ids(h.disk())).toEqual(["added-first", "existing", "psbt-order"]);
  });

  it("lets the next mutation run after a verified write fails", async () => {
    const h = await heldStore([row("existing", 1)]);
    mocks.setCacheValue.mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(h.store.addDurable(recorded)).rejects.toThrow("quota exceeded");
    await h.store.add(row("after-failure", 2));

    expect(ids(h.store.list())).toEqual(["after-failure", "existing"]);
  });
});
