import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearV2Moves,
  dismissV2Move,
  forgetV2Move,
  getV2Move,
  listV2Moves,
  noteV2MoveCommitted,
  noteV2MoveNeedsUser,
  noteV2MoveStatus,
  noteV2MoveStep,
  noteV2TransferPhase,
  resolveV2MoveId,
  subscribeV2Moves,
  noteV2MovePaid,
  restoreV2Move,
} from "./SwapKitV2MoveStatus";

describe("SwapKitV2MoveStatus", () => {
  beforeEach(() => clearV2Moves());

  it("starts a move at preparing on the commit handoff", () => {
    noteV2MoveCommitted({ orderId: "ord_1", from: "EURC_BASE", to: "USDC_BASE" });
    expect(getV2Move("ord_1")).toMatchObject({
      phase: "preparing",
      from: "EURC_BASE",
      to: "USDC_BASE",
    });
  });

  it("carries committed leg amounts so a Bitcoin-rail leg can render its row", () => {
    // The Bitcoin rails have no transfer store, so the board reads a swap's BTC
    // leg from the move record — it must carry the sats.
    noteV2MoveCommitted({
      orderId: "ord_btc",
      from: "USDC_BASE",
      to: "BTC_ARKADE",
      sendAmount: 11.02,
      receiveAmount: 18773,
    });
    expect(getV2Move("ord_btc")).toMatchObject({
      to: "BTC_ARKADE",
      sendAmount: 11.02,
      receiveAmount: 18773,
    });
  });

  it("carries the settle target so an incoming Bitcoin-Lightning leg maps to the arkade rail", () => {
    // "Bitcoin Lightning" settles on-chain to the arkade boarding address, so it
    // commits as `to: BTC` — the board tells it apart from a real on-chain send
    // by the settle target, which must survive on the move record.
    noteV2MoveCommitted({
      orderId: "ord_ln",
      from: "USDC_BASE",
      to: "BTC",
      receiveAmount: 18773,
      settleTarget: "bc1qboarding0000000000000000000000000000000",
    });
    expect(getV2Move("ord_ln")).toMatchObject({
      to: "BTC",
      settleTarget: "bc1qboarding0000000000000000000000000000000",
    });
  });

  it("names the wallet step the signer is actually on", () => {
    noteV2MoveCommitted({ orderId: "ord_1" });
    noteV2MoveStep("ord_1", "approving");
    expect(getV2Move("ord_1")?.phase).toBe("approving");
    noteV2MoveStep("ord_1", "executing");
    expect(getV2Move("ord_1")?.phase).toBe("executing");
  });

  it("maps every terminal status to its own phase", () => {
    const cases: Array<[string, string]> = [
      ["COMPLETED", "completed"],
      ["FAILED", "failed"],
      ["EXPIRED", "failed"],
      ["CANCELLED", "failed"],
      ["REFUNDED", "refunded"],
    ];
    for (const [status, phase] of cases) {
      const id = `ord_${status}`;
      noteV2MoveCommitted({ orderId: id });
      noteV2MoveStatus({ orderId: id, status });
      expect(getV2Move(id)?.phase).toBe(phase);
    }
  });

  it("never drags a terminal move back to processing", () => {
    noteV2MoveCommitted({ orderId: "ord_1" });
    noteV2MoveStatus({ orderId: "ord_1", status: "COMPLETED" });
    // A late poll for an order that already completed.
    noteV2MoveStatus({ orderId: "ord_1", status: "IN_FLIGHT" });
    noteV2MoveStep("ord_1", "executing");
    expect(getV2Move("ord_1")?.phase).toBe("completed");
  });

  it("reports a blocked action as something the user must act on", () => {
    noteV2MoveCommitted({ orderId: "ord_1" });
    noteV2MoveStatus({ orderId: "ord_1", status: "AWAITING_ACTION", blockedReason: "needs claim" });
    expect(getV2Move("ord_1")).toMatchObject({
      phase: "action_required",
      blockedReason: "needs claim",
    });
  });

  // Between accept and the passkey prompt the server sets the order up (up to
  // ~20 s on Arkade -> EUR). The user must not leave the app then, so the pill
  // says so until the wallet has actually paid.
  it("stays preparing through server progress until the wallet has paid", () => {
    noteV2MoveCommitted({ orderId: "ord_p", from: "BTC_ARKADE", to: "EURC_BASE" });
    noteV2MoveStatus({ orderId: "ord_p", status: "AWAITING_ACTION" });
    expect(getV2Move("ord_p")?.phase).toBe("preparing");
    noteV2MovePaid("ord_p");
    expect(getV2Move("ord_p")?.phase).toBe("processing");
    noteV2MoveStatus({ orderId: "ord_p", status: "PROCESSING" });
    expect(getV2Move("ord_p")?.phase).toBe("processing");
  });

  // The move store is in memory. After a full app restart the Bitcoin-rail
  // pending row is drawn only from a restored move, so resume must rebuild it
  // with its amounts, without re-raising the pill.
  it("restores an open order as a move with its amounts, pill not re-shown", () => {
    restoreV2Move({
      orderId: "ord_r",
      from: "BTC_ARKADE",
      to: "EURC_BASE",
      sendAmount: 11_106,
      receiveAmount: 7.67,
    });
    expect(getV2Move("ord_r")).toMatchObject({
      phase: "processing",
      sendAmount: 11_106,
      receiveAmount: 7.67,
      dismissed: true,
    });
    noteV2MoveStatus({ orderId: "ord_r", status: "PROCESSING" });
    expect(getV2Move("ord_r")).toMatchObject({ sendAmount: 11_106, dismissed: true });
  });

  it("never overwrites a move this session already knows", () => {
    noteV2MoveCommitted({ orderId: "ord_k", from: "BTC_ARKADE", to: "EURC_BASE", sendAmount: 5 });
    restoreV2Move({ orderId: "ord_k", from: "X", to: "Y", sendAmount: 99 });
    expect(getV2Move("ord_k")).toMatchObject({
      phase: "preparing",
      from: "BTC_ARKADE",
      sendAmount: 5,
    });
  });

  it("clears the blocked state when the action becomes runnable again", () => {
    noteV2MoveCommitted({ orderId: "ord_1" });
    noteV2MoveNeedsUser("ord_1", "locked");
    noteV2MoveStatus({ orderId: "ord_1", status: "IN_FLIGHT" });
    expect(getV2Move("ord_1")).toMatchObject({ phase: "processing", blockedReason: null });
  });

  it("keeps concurrent moves independent and never overwrites one with another", () => {
    noteV2MoveCommitted({ orderId: "ord_a", from: "EURC_BASE", to: "USDC_BASE" });
    noteV2MoveCommitted({ orderId: "ord_b", from: "USDC_BASE", to: "BTC_ARKADE" });
    noteV2MoveStatus({ orderId: "ord_a", status: "COMPLETED" });
    expect(getV2Move("ord_a")?.phase).toBe("completed");
    expect(getV2Move("ord_b")?.phase).toBe("preparing");
    expect(listV2Moves()).toHaveLength(2);
  });

  it("dismissal hides only the presentation, and a new phase re-shows it", () => {
    noteV2MoveCommitted({ orderId: "ord_1" });
    dismissV2Move("ord_1");
    expect(getV2Move("ord_1")?.dismissed).toBe(true);
    // Still tracked, still listed — dismissal is not cancellation.
    expect(listV2Moves()).toHaveLength(1);
    noteV2MoveStep("ord_1", "executing");
    expect(getV2Move("ord_1")?.dismissed).toBe(false);
  });

  it("does not republish an unchanged phase", () => {
    const seen = vi.fn();
    noteV2MoveCommitted({ orderId: "ord_1", status: "IN_FLIGHT" });
    const off = subscribeV2Moves(seen);
    expect(seen).toHaveBeenCalledTimes(1);
    noteV2MoveStatus({ orderId: "ord_1", status: "IN_FLIGHT" });
    expect(seen).toHaveBeenCalledTimes(1);
    noteV2MoveStatus({ orderId: "ord_1", status: "COMPLETED" });
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });

  it("keeps the commit flow's leg details when the sheet's handoff noted the move first", () => {
    // useMoveSwap's handoff runs inside the commit flow's onOrderId, BEFORE the
    // flow notes the same order with its amounts and settle target. Same phase,
    // so it is not news for the pill — but the Bitcoin leg's pending row needs
    // those details, or it renders 0 sats and lands on the wrong rail.
    noteV2MoveCommitted({ orderId: "ord_h", from: "EURC_BASE", to: "BTC" });
    dismissV2Move("ord_h");
    const seen = vi.fn();
    const off = subscribeV2Moves(seen);
    noteV2MoveCommitted({
      orderId: "ord_h",
      from: "EURC_BASE",
      to: "BTC",
      sendAmount: 14.2,
      receiveAmount: 19000,
      settleTarget: "bc1qboarding0000000000000000000000000000000",
    });
    expect(getV2Move("ord_h")).toMatchObject({
      phase: "preparing",
      sendAmount: 14.2,
      receiveAmount: 19000,
      settleTarget: "bc1qboarding0000000000000000000000000000000",
      // A detail merge is not a phase change: a dismissed pill stays dismissed.
      dismissed: true,
    });
    expect(seen).toHaveBeenCalledTimes(2);
    // A bare repeat afterwards neither erases the details nor republishes.
    noteV2MoveCommitted({ orderId: "ord_h", from: "EURC_BASE", to: "BTC" });
    expect(getV2Move("ord_h")?.receiveAmount).toBe(19000);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });

  it("forgets a move once its outcome has been shown", () => {
    noteV2MoveCommitted({ orderId: "ord_1" });
    noteV2MoveStatus({ orderId: "ord_1", status: "COMPLETED" });
    forgetV2Move("ord_1");
    expect(getV2Move("ord_1")).toBeNull();
  });

  it("follows a provisional id to the order that replaced it", () => {
    // The pill can be opened while the swap still has its provisional id; the
    // detail sheet can only load a real order, so the id must resolve to it.
    noteV2MoveCommitted({ orderId: "pending:k1", from: "EURC_BASE", to: "BTC" });
    expect(resolveV2MoveId("pending:k1")).toBe("pending:k1");
    noteV2MoveCommitted({ orderId: "ord_real", replaces: "pending:k1", from: "EURC_BASE" });
    forgetV2Move("pending:k1");
    expect(resolveV2MoveId("pending:k1")).toBe("ord_real");
    expect(resolveV2MoveId("ord_real")).toBe("ord_real");
    clearV2Moves();
    expect(resolveV2MoveId("pending:k1")).toBe("pending:k1");
  });

  it("keeps a provisional pill's acknowledgement on the real order", () => {
    noteV2MoveCommitted({ orderId: "pending:k2" });
    dismissV2Move("pending:k2");
    noteV2MoveCommitted({ orderId: "ord_k2", replaces: "pending:k2" });
    expect(getV2Move("ord_k2")?.dismissed).toBe(true);
  });

  it("tracks a wallet↔card transfer as a transfer, through to its outcome", () => {
    noteV2TransferPhase("transfer:1", "processing");
    expect(getV2Move("transfer:1")).toMatchObject({ kind: "transfer", phase: "processing" });
    noteV2TransferPhase("transfer:1", "completed");
    expect(getV2Move("transfer:1")?.phase).toBe("completed");
  });
});
