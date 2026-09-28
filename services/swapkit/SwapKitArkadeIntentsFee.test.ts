import { describe, expect, it } from "vitest";

import { maxAcceptedAmountSats, maxFundAmountSats } from "./SwapKitArkadeIntentsCreate";

// What Max types has to be an amount the corridor can actually be asked for:
// the lockup carries the amount plus the published spread, so the funding total
// — not the amount — is what the balance has to cover.
describe("maxAcceptedAmountSats · the fee-aware ceiling", () => {
  const BUDGETS = [0, 1, 2, 3, 100, 999, 1_000, 12_345, 737_148, 21_000_000];

  it("never asks for more than the budget can fund", () => {
    for (const budget of BUDGETS) {
      const accepted = maxAcceptedAmountSats(budget);
      expect(accepted).toBeGreaterThanOrEqual(0);
      if (accepted > 0) expect(maxFundAmountSats(accepted)).toBeLessThanOrEqual(budget);
    }
  });

  it("leaves nothing on the table — one sat more would not fund", () => {
    for (const budget of BUDGETS) {
      const accepted = maxAcceptedAmountSats(budget);
      expect(maxFundAmountSats(accepted + 1)).toBeGreaterThan(budget);
    }
  });

  it("refuses a budget that cannot cover the rounding sat alone", () => {
    expect(maxAcceptedAmountSats(0)).toBe(0);
    expect(maxAcceptedAmountSats(1)).toBe(0);
    expect(maxAcceptedAmountSats(-5)).toBe(0);
  });

  it("is the whole balance minus the spread, not the whole balance", () => {
    // 737_148 sats: the 30 bps spread plus the rounding sat come off the top.
    expect(maxAcceptedAmountSats(737_148)).toBeLessThan(737_148);
    expect(maxFundAmountSats(737_148)).toBeGreaterThan(737_148);
  });
});
