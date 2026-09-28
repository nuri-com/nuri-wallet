import { beforeEach, describe, expect, it, vi } from "vitest";

// The sheet closes when the user accepts the quote, so nothing is on screen to
// refetch when the order completes. These are the rules that make the numbers
// move anyway, without ever moving them twice.
const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  eurBalance: null as number | null,
  usdBalance: null as number | null,
  eurDebit: vi.fn(),
  usdDebit: vi.fn(),
  revertArkade: vi.fn(),
}));

vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: mocks.emit, on: () => () => {} },
}));
vi.mock("../balance/WalletBalanceStore", () => ({
  walletBalanceStore: {
    getSnapshot: () => ({ balanceEur: mocks.eurBalance }),
    applyOptimisticDebit: mocks.eurDebit,
  },
}));
vi.mock("../balance/UsdcBalanceStore", () => ({
  usdcBalanceStore: {
    getSnapshot: () => ({ balanceUsd: mocks.usdBalance }),
    applyOptimisticDebit: mocks.usdDebit,
  },
}));
vi.mock("../bitcoin/BitcoinBalanceStore", () => ({
  bitcoinBalanceStore: { revertArkadeOutgoingBalance: mocks.revertArkade },
}));

import {
  applyV2TerminalBalances,
  clearV2MoveAccounting,
  noteV2MoveBaseline,
} from "./SwapKitV2MoveAccounting";

const creditsFor = (moveId: string) =>
  mocks.emit.mock.calls.filter(
    (call) =>
      call[0] === "wallet:optimisticCredit" && (call[1] as { moveId?: string })?.moveId === moveId,
  );

describe("SwapKitV2MoveAccounting", () => {
  beforeEach(() => {
    clearV2MoveAccounting();
    mocks.emit.mockClear();
    mocks.eurDebit.mockClear();
    mocks.usdDebit.mockClear();
    mocks.revertArkade.mockClear();
    mocks.eurBalance = 100;
    mocks.usdBalance = 50;
  });

  it("moves BOTH legs on COMPLETED, each against its own rail", () => {
    noteV2MoveBaseline({
      orderId: "ord_1",
      from: "EURC_BASE",
      to: "USDC_BASE",
      sendAmount: 10,
      receiveAmount: 11,
    });
    applyV2TerminalBalances({ orderId: "ord_1", from: "EURC_BASE", to: "USDC_BASE" }, "COMPLETED");

    expect(mocks.eurDebit).toHaveBeenCalledWith(10);
    expect(mocks.usdDebit).not.toHaveBeenCalled();
    expect(creditsFor("ord_1")).toHaveLength(1);
    expect(creditsFor("ord_1")[0][1]).toMatchObject({ amount: 11, asset: "USDC_BASE" });
  });

  it("does not conflate USDC with EURC", () => {
    noteV2MoveBaseline({
      orderId: "ord_1",
      from: "USDC_BASE",
      to: "EURC_BASE",
      sendAmount: 20,
      receiveAmount: 18,
    });
    applyV2TerminalBalances({ orderId: "ord_1", from: "USDC_BASE", to: "EURC_BASE" }, "COMPLETED");

    expect(mocks.usdDebit).toHaveBeenCalledWith(20);
    expect(mocks.eurDebit).not.toHaveBeenCalled();
    expect(creditsFor("ord_1")[0][1]).toMatchObject({ asset: "EURC_BASE" });
  });

  it("is idempotent across a duplicate terminal event", () => {
    noteV2MoveBaseline({
      orderId: "ord_1",
      from: "EURC_BASE",
      to: "USDC_BASE",
      sendAmount: 10,
      receiveAmount: 11,
    });
    applyV2TerminalBalances({ orderId: "ord_1", from: "EURC_BASE", to: "USDC_BASE" }, "COMPLETED");
    applyV2TerminalBalances({ orderId: "ord_1", from: "EURC_BASE", to: "USDC_BASE" }, "COMPLETED");

    expect(mocks.eurDebit).toHaveBeenCalledTimes(1);
    expect(creditsFor("ord_1")).toHaveLength(1);
  });

  it("skips a leg the ledger already published", () => {
    noteV2MoveBaseline({
      orderId: "ord_1",
      from: "EURC_BASE",
      to: "USDC_BASE",
      sendAmount: 10,
      receiveAmount: 11,
    });
    // A refetch landed first: the euro spend and the dollar arrival are both
    // already in the displayed figures.
    mocks.eurBalance = 90;
    mocks.usdBalance = 61;
    applyV2TerminalBalances({ orderId: "ord_1", from: "EURC_BASE", to: "USDC_BASE" }, "COMPLETED");

    expect(mocks.eurDebit).not.toHaveBeenCalled();
    expect(creditsFor("ord_1")).toHaveLength(0);
  });

  // Two moves out of the same wallet, neither settled. The first one's debit
  // moves the displayed figure; the second must not read that as the ledger
  // having published ITS spend, or one of the two completed moves silently
  // never appears.
  it("keeps concurrent moves out of one rail independent", () => {
    noteV2MoveBaseline({
      orderId: "ord_a",
      from: "EURC_BASE",
      to: "USDC_BASE",
      sendAmount: 10,
      receiveAmount: 11,
    });
    noteV2MoveBaseline({
      orderId: "ord_b",
      from: "EURC_BASE",
      to: "USDC_BASE",
      sendAmount: 10,
      receiveAmount: 11,
    });

    applyV2TerminalBalances({ orderId: "ord_a", from: "EURC_BASE", to: "USDC_BASE" }, "COMPLETED");
    // The store applied the first debit and the first credit.
    mocks.eurBalance = 90;
    mocks.usdBalance = 61;
    applyV2TerminalBalances({ orderId: "ord_b", from: "EURC_BASE", to: "USDC_BASE" }, "COMPLETED");

    expect(mocks.eurDebit).toHaveBeenCalledTimes(2);
    expect(creditsFor("ord_a")).toHaveLength(1);
    expect(creditsFor("ord_b")).toHaveLength(1);
  });

  it("still skips a concurrent move's leg when the LEDGER moved on top of ours", () => {
    noteV2MoveBaseline({
      orderId: "ord_a",
      from: "EURC_BASE",
      to: "USDC_BASE",
      sendAmount: 10,
      receiveAmount: 11,
    });
    noteV2MoveBaseline({
      orderId: "ord_b",
      from: "EURC_BASE",
      to: "USDC_BASE",
      sendAmount: 10,
      receiveAmount: 11,
    });
    applyV2TerminalBalances({ orderId: "ord_a", from: "EURC_BASE", to: "USDC_BASE" }, "COMPLETED");
    // Our own debit (−10) PLUS the ledger publishing the second spend (−10).
    mocks.eurBalance = 80;
    mocks.usdBalance = 72;
    applyV2TerminalBalances({ orderId: "ord_b", from: "EURC_BASE", to: "USDC_BASE" }, "COMPLETED");

    expect(mocks.eurDebit).toHaveBeenCalledTimes(1);
    expect(creditsFor("ord_b")).toHaveLength(0);
  });

  it("reverts only this order's credit on a non-completed terminal", () => {
    for (const status of ["FAILED", "REFUNDED", "EXPIRED", "CANCELLED"]) {
      clearV2MoveAccounting();
      mocks.emit.mockClear();
      mocks.eurDebit.mockClear();
      applyV2TerminalBalances({ orderId: "ord_x", from: "EURC_BASE", to: "USDC_BASE" }, status);
      expect(mocks.emit).toHaveBeenCalledWith("wallet:revokeOptimisticCredit", {
        moveId: "ord_x",
      });
      expect(mocks.eurDebit).not.toHaveBeenCalled();
    }
  });

  it("gives held sats back when a Bitcoin-spending move fails", () => {
    applyV2TerminalBalances({ orderId: "ord_1", from: "BTC_ARKADE", to: "USDC_BASE" }, "FAILED");
    expect(mocks.revertArkade).toHaveBeenCalledWith("v2_move_failed");
  });

  it("leaves the card credit to the card's own terminal event", () => {
    noteV2MoveBaseline({
      orderId: "ord_1",
      from: "BTC_ARKADE",
      to: "EURC_BASE",
      sendAmount: 30000,
      receiveAmount: 25,
    });
    applyV2TerminalBalances(
      { orderId: "ord_1", from: "BTC_ARKADE", to: "EURC_BASE", destination: "card" },
      "COMPLETED",
    );
    expect(creditsFor("ord_1")).toHaveLength(0);
  });

  it("applies nothing optimistic for an order with no session baseline", () => {
    // After a restart the authoritative read is the only truth.
    applyV2TerminalBalances(
      { orderId: "ord_restart", from: "EURC_BASE", to: "USDC_BASE" },
      "COMPLETED",
    );
    expect(mocks.eurDebit).not.toHaveBeenCalled();
    expect(creditsFor("ord_restart")).toHaveLength(0);
  });
});
