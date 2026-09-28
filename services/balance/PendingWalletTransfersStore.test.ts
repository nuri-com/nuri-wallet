import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
}));

vi.mock("../events/AppEventBusService", () => ({
  EventBus: {
    emit: vi.fn(),
    on: (event: string, handler: (payload: unknown) => void) => {
      mocks.handlers.set(event, handler);
      return () => mocks.handlers.delete(event);
    },
  },
}));
vi.mock("./TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));

import {
  PendingWalletTransfersStore,
  pendingTransfersForFiat,
  startPendingWalletTransfers,
  stopPendingWalletTransfers,
} from "./PendingWalletTransfersStore";

const emit = (event: string, payload: unknown) => mocks.handlers.get(event)?.(payload);
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.getCacheValue.mockResolvedValue(null);
  mocks.setCacheValue.mockResolvedValue(undefined);
  stopPendingWalletTransfers();
  await PendingWalletTransfersStore.clear();
  startPendingWalletTransfers();
});

describe("pending wallet transfers", () => {
  // The producers' own payload. They state the figure as `amountFiat` — a store
  // that reads `amount` alone records none of them, and the money leaves the
  // balance with nothing on screen to say where it went.
  it("records an ordinary wallet send, as the sender announces it", async () => {
    emit("wallet:pendingTransfer", {
      amountFiat: 12.5,
      txHash: "0xabc",
      kind: "wallet_transfer",
    });
    await settled();

    expect(await PendingWalletTransfersStore.list()).toMatchObject([
      { amount: 12.5, txHash: "0xabc", kind: "wallet_transfer" },
    ]);
  });

  // The dollar transfer into the card has to be watched like any other broadcast
  // — PendingTransferSettleWatcher only sees rows registered here, and its
  // `wallet:transferSettled` is what takes the card's optimistic credit back on
  // a revert. What keeps it off the EURO wallet's surfaces is the asset, so the
  // store has to carry it.
  it("records the currency a transfer is denominated in", async () => {
    emit("wallet:pendingTransfer", {
      amountFiat: 74.6,
      txHash: "0xusd",
      source: "base-mainnet",
      fiat: "USD",
    });
    await settled();

    expect(await PendingWalletTransfersStore.list()).toMatchObject([
      { amount: 74.6, txHash: "0xusd", fiat: "USD" },
    ]);
  });

  // Every producer that predates the dollar rail means euros and says nothing.
  it("leaves a row that named no currency on the euro rail", async () => {
    emit("wallet:pendingTransfer", { amountFiat: 12.5, txHash: "0xeur" });
    await settled();

    expect((await PendingWalletTransfersStore.list())[0]?.fiat).toBe("EUR");
  });

  it("records a top-up, keeping the kind and source the producer stated", async () => {
    emit("wallet:pendingTransfer", {
      amountFiat: 30,
      orderId: "sk_topup",
      kind: "card_topup",
      source: "swapkit_topup",
    });
    await settled();

    expect(await PendingWalletTransfersStore.list()).toMatchObject([
      { amount: 30, orderId: "sk_topup", kind: "card_topup", source: "swapkit_topup" },
    ]);
  });

  it("still accepts the older `amount` spelling", async () => {
    emit("wallet:pendingTransfer", { amount: 7, txHash: "0xdef" });
    await settled();

    expect(await PendingWalletTransfersStore.list()).toMatchObject([{ amount: 7 }]);
  });

  it("replaces a re-announced transfer instead of listing it twice", async () => {
    emit("wallet:pendingTransfer", { amountFiat: 5, orderId: "sk_1" });
    await settled();
    emit("wallet:pendingTransfer", { amountFiat: 6, orderId: "sk_1" });
    await settled();

    expect(await PendingWalletTransfersStore.list()).toMatchObject([{ amount: 6 }]);
  });

  it("keeps both legs of one swap (out + in) and clears both by orderId", async () => {
    // A stable→stable swap announces two rows under one orderId: a debit on the
    // source rail and a credit on the destination rail. They must coexist, and
    // a re-announce of a leg replaces only that leg.
    emit("wallet:pendingTransfer", {
      amountFiat: 1,
      orderId: "sk_swap",
      fiat: "EUR",
      direction: "out",
    });
    emit("wallet:pendingTransfer", {
      amountFiat: 1.14,
      orderId: "sk_swap",
      fiat: "USD",
      direction: "in",
    });
    await settled();
    expect(await PendingWalletTransfersStore.list()).toHaveLength(2);

    // Re-announce the out leg — replaces it, does not add a third row.
    emit("wallet:pendingTransfer", {
      amountFiat: 1,
      orderId: "sk_swap",
      fiat: "EUR",
      direction: "out",
    });
    await settled();
    expect(await PendingWalletTransfersStore.list()).toHaveLength(2);

    // Terminal clear by orderId (no direction) removes BOTH legs.
    emit("wallet:clearPendingTransfer", { txHash: null, orderId: "sk_swap" });
    await settled();
    expect(await PendingWalletTransfersStore.list()).toEqual([]);
  });

  it("drops a row when its transfer is cleared or its receipt lands", async () => {
    emit("wallet:pendingTransfer", { amountFiat: 5, orderId: "sk_1" });
    emit("wallet:pendingTransfer", { amountFiat: 9, txHash: "0xaaa" });
    await settled();

    emit("wallet:clearPendingTransfer", { txHash: null, orderId: "sk_1" });
    await settled();
    emit("wallet:transferSettled", { txHash: "0xaaa" });
    await settled();

    expect(await PendingWalletTransfersStore.list()).toEqual([]);
  });

  it("keeps SwapKit rows past the generic TTL until tracker reconciliation clears them", async () => {
    const stale = "2020-01-01T00:00:00.000Z";
    await PendingWalletTransfersStore.add({
      amount: 10,
      orderId: "sk_slow_payout",
      txHash: null,
      source: "swapkit",
      createdAt: stale,
      kind: "wallet_transfer",
      fiat: "EUR",
    });
    await PendingWalletTransfersStore.add({
      amount: 11,
      orderId: "ordinary-stale",
      txHash: null,
      source: "other",
      createdAt: stale,
      kind: "wallet_transfer",
      fiat: "EUR",
    });

    await PendingWalletTransfersStore.prune();

    expect(await PendingWalletTransfersStore.list()).toMatchObject([
      { orderId: "sk_slow_payout", source: "swapkit" },
    ]);
  });

  it("ignores an announcement with no amount to show", async () => {
    emit("wallet:pendingTransfer", { txHash: "0xnope" });
    await settled();

    expect(await PendingWalletTransfersStore.list()).toEqual([]);
  });

  // The dollar rail is its own balance at the same address. A row without a
  // currency was listed on the euro rail and written as euros, so a USDC spend
  // debited a balance it never touched and its own rail showed nothing.
  it("keeps the stablecoin each transfer actually spent", async () => {
    emit("wallet:pendingTransfer", { amountFiat: 25, txHash: "0xusd", fiat: "USD" });
    emit("wallet:pendingTransfer", { amountFiat: 12, txHash: "0xeur", fiat: "EUR" });
    await settled();

    const rows = await PendingWalletTransfersStore.list();
    expect(pendingTransfersForFiat(rows, "USD")).toMatchObject([{ amount: 25, txHash: "0xusd" }]);
    expect(pendingTransfersForFiat(rows, "EUR")).toMatchObject([{ amount: 12, txHash: "0xeur" }]);
  });

  it("keeps a row that states no currency on the euro rail", async () => {
    // Persisted before the field existed, and euro by construction: no dollar
    // producer could write one.
    emit("wallet:pendingTransfer", { amountFiat: 8, txHash: "0xold" });
    await settled();

    const rows = (await PendingWalletTransfersStore.list()).map(({ fiat, ...rest }) => rest);
    expect(pendingTransfersForFiat(rows, "EUR")).toMatchObject([{ amount: 8 }]);
    expect(pendingTransfersForFiat(rows, "USD")).toEqual([]);
  });
});
