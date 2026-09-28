import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOptimisticMoves,
  parkOptimisticMove,
  rememberOptimisticMove,
  settleOptimisticMove,
  takeEarlySettlement,
  takeOptimisticMove,
} from "./pendingOptimisticMoves";

beforeEach(() => {
  clearOptimisticMoves();
});

describe("pendingOptimisticMoves", () => {
  it("hands both sides of a transfer back when it reverts", () => {
    // The regression: a top-up debited the wallet and credited the card on
    // broadcast, the Base transfer was mined reverted, and neither move was
    // taken back — both balances kept a promise the chain refused.
    rememberOptimisticMove("wallet", "0xABC", 3);
    rememberOptimisticMove("card", "0xABC", 7);
    expect(takeOptimisticMove("wallet", "0xabc")).toBe(3);
    expect(takeOptimisticMove("card", "0xabc")).toBe(7);
  });

  it("forgets an entry once claimed", () => {
    rememberOptimisticMove("card", "0xabc", 7);
    takeOptimisticMove("card", "0xabc");
    expect(takeOptimisticMove("card", "0xabc")).toBeNull();
  });

  it("keeps overlapping transfers apart", () => {
    rememberOptimisticMove("card", "0xaaa", 1);
    rememberOptimisticMove("card", "0xbbb", 2);
    expect(takeOptimisticMove("card", "0xbbb")).toBe(2);
    expect(takeOptimisticMove("card", "0xaaa")).toBe(1);
  });

  it("ignores a move with nothing to revert", () => {
    rememberOptimisticMove("card", "0xabc", null);
    rememberOptimisticMove("card", null, 7);
    rememberOptimisticMove("card", "   ", 7);
    expect(takeOptimisticMove("card", "0xabc")).toBeNull();
    expect(takeOptimisticMove("card", null)).toBeNull();
  });

  it("drops everything on session teardown", () => {
    rememberOptimisticMove("card", "0xabc", 7);
    clearOptimisticMoves();
    expect(takeOptimisticMove("card", "0xabc")).toBeNull();
  });
});

// Review 5294728655 #3: a direct swap announces its outcome before its caller can park the card
// credit. Either order has to end with the credit settled exactly once.
describe("settling a card credit whose outcome may arrive first", () => {
  it("hands the parked handle to a settlement that arrives after it", () => {
    expect(parkOptimisticMove("card", "sk_1", 7)).toBeNull();
    expect(settleOptimisticMove("card", "sk_1", false)).toBe(7);
    // Taken: nothing is left for a second settlement.
    expect(settleOptimisticMove("card", "sk_1", false)).toBeNull();
    expect(takeEarlySettlement("card", "sk_1")).toBe(false);
  });

  it("keeps an outcome that arrives before the credit, for the credit to read", () => {
    expect(settleOptimisticMove("card", "sk_2", true)).toBeNull();
    expect(parkOptimisticMove("card", "sk_2", 9)).toBe(true);
    // The credit read it, so nothing was parked and nothing is left behind.
    expect(takeOptimisticMove("card", "sk_2")).toBeNull();
    expect(takeEarlySettlement("card", "sk_2")).toBeNull();
  });

  it("lets the caller see a settled order before crediting at all", () => {
    settleOptimisticMove("card", "sk_3", false);
    expect(takeEarlySettlement("card", "sk_3")).toBe(false);
    expect(takeEarlySettlement("card", "sk_3")).toBeNull();
  });

  it("forgets early outcomes on session teardown", () => {
    settleOptimisticMove("card", "sk_4", true);
    clearOptimisticMoves();
    expect(takeEarlySettlement("card", "sk_4")).toBeNull();
  });
});
