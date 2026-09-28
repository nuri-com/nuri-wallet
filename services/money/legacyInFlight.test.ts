import { beforeEach, describe, expect, it, vi } from "vitest";

// Rows an older build left in its own pending lists survive the update: they
// are copied into the one list the screens read, once, without overwriting
// anything the one list already holds.
const HASH = `0x${"cd".repeat(32)}`;
const mocks = vi.hoisted(() => ({
  purchases: [] as unknown[],
  sends: [] as unknown[],
  transfers: [] as unknown[],
}));

vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: (): (() => void) => () => {} },
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (): Promise<null> => null,
  setCacheValue: async (): Promise<void> => {},
}));
vi.mock("../app/PendingPurchasesStore", () => ({
  PendingPurchasesStore: {
    hydrate: async (): Promise<void> => {},
    list: (): unknown[] => mocks.purchases,
  },
}));
vi.mock("../bitcoin/PendingBitcoinSendsStore", () => ({
  PendingBitcoinSendsStore: { list: async (): Promise<unknown[]> => mocks.sends },
}));
vi.mock("../balance/PendingWalletTransfersStore", () => ({
  PendingWalletTransfersStore: { list: async (): Promise<unknown[]> => mocks.transfers },
}));

import { _resetLegacyAdoptionForTests, adoptLegacyInFlight } from "./legacyInFlight";
import { MoneyInFlightStore } from "./MoneyInFlightStore";
import { inFlightRowsFor } from "./inFlightRows";

const NOW = "2026-09-25T10:00:00.000Z";

beforeEach(() => {
  MoneyInFlightStore._resetForTests();
  _resetLegacyAdoptionForTests();
  mocks.purchases = [];
  mocks.sends = [];
  mocks.transfers = [];
});

describe("rows pending across the update", () => {
  it("every old list's active row shows on its screen after the update", async () => {
    mocks.purchases = [
      { id: "mtid_1", createdAt: Date.parse(NOW), amountSats: 5000, amountFiat: 4 },
    ];
    mocks.sends = [{ txid: "a".repeat(64), amountSats: 1200, createdAt: NOW, source: "onchain" }];
    mocks.transfers = [
      { amount: 7, createdAt: NOW, txHash: HASH, kind: "card_topup", fiat: "USD" },
      { amount: 3, createdAt: NOW, orderId: "ord_x", kind: "wallet_transfer", direction: "out" },
      {
        amount: 2.9,
        createdAt: NOW,
        orderId: "ord_x",
        kind: "wallet_transfer",
        direction: "in",
        fiat: "USD",
      },
    ];
    await adoptLegacyInFlight();
    const records = MoneyInFlightStore.list();
    expect(records.map((r) => r.id).sort()).toEqual(
      ["a".repeat(64), HASH, "mtid_1", "ord_x"].sort(),
    );
    expect(
      inFlightRowsFor(records, ["onchain"])
        .map((r) => r.direction)
        .sort(),
    ).toEqual(["in", "out"]);
    expect(inFlightRowsFor(records, ["visaUsd"])).toHaveLength(1);
    // One order's two old rows are one record with both ends.
    const order = records.find((r) => r.id === "ord_x");
    expect(order?.from?.rail).toBe("wallet");
    expect(order?.to?.rail).toBe("dollar");
  });

  it("an old top-up row without a direction is restored as money arriving", async () => {
    mocks.purchases = [{ id: "ord_t", createdAt: Date.parse(NOW), amountSats: 0, amountFiat: 5 }];
    mocks.transfers = [
      {
        amount: 5,
        createdAt: NOW,
        orderId: "ord_t",
        kind: "wallet_transfer",
        source: "swapkit_topup",
      },
      {
        amount: 2,
        createdAt: NOW,
        orderId: "ord_s",
        kind: "wallet_transfer",
        source: "swapkit_sweep",
      },
      { amount: 4, createdAt: NOW, orderId: "ord_o", kind: "wallet_transfer", source: "swapkit" },
    ];
    await adoptLegacyInFlight();
    const byId = new Map(MoneyInFlightStore.list().map((r) => [r.id, r]));
    expect(byId.get("ord_t")?.to?.rail).toBe("wallet");
    expect(byId.get("ord_t")?.from).toBeNull();
    expect(byId.get("ord_s")?.to?.rail).toBe("wallet");
    expect(byId.get("ord_o")?.from?.rail).toBe("wallet");
    expect(byId.get("ord_o")?.to).toBeNull();
  });

  it("never overwrites a record the one list already holds", async () => {
    await MoneyInFlightStore.start({
      id: "ord_x",
      from: { rail: "wallet", amount: 3, unit: "EUR" },
      to: { rail: "visaUsd", amount: 3.4, unit: "USD" },
      kind: "swap",
      createdAt: NOW,
    });
    mocks.transfers = [{ amount: 3, createdAt: NOW, orderId: "ord_x", kind: "wallet_transfer" }];
    await adoptLegacyInFlight();
    expect(MoneyInFlightStore.list()).toHaveLength(1);
    expect(MoneyInFlightStore.list()[0].to?.rail).toBe("visaUsd");
  });

  it("copies once per run", async () => {
    mocks.sends = [{ txid: "b".repeat(64), amountSats: 900, createdAt: NOW }];
    await adoptLegacyInFlight();
    await MoneyInFlightStore.finish("b".repeat(64));
    await adoptLegacyInFlight();
    expect(MoneyInFlightStore.list()).toHaveLength(0);
  });
});
