import { beforeEach, describe, expect, it, vi } from "vitest";

// Taner, #1361 review 5318630782 item 2: the first version of the hold used the
// balance store's SINGLE global slot, so it closed the simple race and left
// three real ones:
//
//   - a second Arkade order OVERWROTE the first one's hold;
//   - ANY order finishing cleared the hold, freeing sats another order still
//     had committed;
//   - nothing survived a restart.
//
// Reservations are now per order, additive, persisted, and released only by
// the order that made them.
const m = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  hold: vi.fn(),
  clear: vi.fn(),
  failWrites: false,
}));

vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (key: string) => m.cache.get(key) ?? null,
  setCacheValue: async (key: string, value: unknown) => {
    if (m.failWrites) throw new Error("disk full");
    m.cache.set(key, value);
  },
}));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: (): (() => void) => () => {} },
}));

import { SatsReservationsStore } from "./SatsReservationsStore";

beforeEach(async () => {
  m.cache.clear();
  m.failWrites = false;
  SatsReservationsStore._resetForTests();
});

describe("two Arkade orders in flight hold BOTH amounts", () => {
  it("adds rather than overwrites", async () => {
    await SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 10_000 });
    await SatsReservationsStore.reserve({ orderId: "ord_b", rail: "arkade", sats: 7_000 });
    expect(SatsReservationsStore.totalFor("arkade")).toBe(17_000);
  });

  it("releases only the order that finished", async () => {
    await SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 10_000 });
    await SatsReservationsStore.reserve({ orderId: "ord_b", rail: "arkade", sats: 7_000 });
    await SatsReservationsStore.release("ord_a");
    // ord_b is still in flight: its sats stay committed.
    expect(SatsReservationsStore.totalFor("arkade")).toBe(7_000);
    await SatsReservationsStore.release("ord_b");
    expect(SatsReservationsStore.totalFor("arkade")).toBe(0);
  });

  it("re-arming the same order does not hold its sats twice", async () => {
    // A resume, a retry and a second status poll all re-arm the same order.
    await SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 10_000 });
    await SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 10_000 });
    expect(SatsReservationsStore.totalFor("arkade")).toBe(10_000);
  });

  it("keeps the two Bitcoin rails apart", async () => {
    await SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 10_000 });
    await SatsReservationsStore.reserve({ orderId: "ord_c", rail: "onchain", sats: 4_000 });
    expect(SatsReservationsStore.totalFor("arkade")).toBe(10_000);
    expect(SatsReservationsStore.totalFor("onchain")).toBe(4_000);
  });
});

describe("a restart brings the reservations back", () => {
  it("re-derives the same total from the persisted ledger", async () => {
    await SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 10_000 });
    await SatsReservationsStore.reserve({ orderId: "ord_b", rail: "arkade", sats: 7_000 });
    expect(SatsReservationsStore.totalFor("arkade")).toBe(17_000);

    // Relaunch: a fresh module instance, in-memory state gone, same cache on
    // disk. This is the case the first version lost entirely — the committed
    // sats read as spendable again after restarting mid-swap.
    vi.resetModules();
    const reloaded = (await import("./SatsReservationsStore")).SatsReservationsStore;
    expect(reloaded.totalFor("arkade")).toBe(0); // nothing read yet
    await reloaded.hydrate();
    expect(reloaded.totalFor("arkade")).toBe(17_000);

    // And the reloaded ledger still releases per order.
    await reloaded.release("ord_a");
    expect(reloaded.totalFor("arkade")).toBe(7_000);
  });
});

describe("nonsense is never reserved", () => {
  it("refuses zero, NaN, negatives and a missing order id", async () => {
    await SatsReservationsStore.reserve({ orderId: "ord_x", rail: "arkade", sats: 0 });
    await SatsReservationsStore.reserve({ orderId: "ord_x", rail: "arkade", sats: Number.NaN });
    await SatsReservationsStore.reserve({ orderId: "ord_x", rail: "arkade", sats: -5 });
    await SatsReservationsStore.reserve({ orderId: "", rail: "arkade", sats: 100 });
    expect(SatsReservationsStore.list()).toHaveLength(0);
  });
});

describe("a reservation that cannot be written is not a reservation", () => {
  it("throws, so the caller can refuse to fund", async () => {
    // The hold exists to survive a crash. Swallowing the write error let
    // funding broadcast against a hold that was never durable, and after a
    // restart those committed sats read as spendable again.
    m.failWrites = true;
    await expect(
      SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 10_000 }),
    ).rejects.toThrow(/disk full/);
  });

  it("leaves NO in-memory reservation the disk does not know about", async () => {
    m.failWrites = true;
    await SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 10_000 }).catch(
      () => {},
    );
    expect(SatsReservationsStore.totalFor("arkade")).toBe(0);
    expect(SatsReservationsStore.list()).toHaveLength(0);
  });

  it("restores the previous amount when re-arming an existing order fails", async () => {
    await SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 10_000 });
    m.failWrites = true;
    await SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 99_999 }).catch(
      () => {},
    );
    expect(SatsReservationsStore.totalFor("arkade")).toBe(10_000);
  });

  it("keeps the hold when a RELEASE cannot be written", async () => {
    // Releasing is the safe direction — an unwritten release must not free the
    // sats in memory either, or a crash would restore a hold already reported
    // as gone.
    await SatsReservationsStore.reserve({ orderId: "ord_a", rail: "arkade", sats: 10_000 });
    m.failWrites = true;
    await SatsReservationsStore.release("ord_a").catch(() => {});
    expect(SatsReservationsStore.totalFor("arkade")).toBe(10_000);
  });
});
