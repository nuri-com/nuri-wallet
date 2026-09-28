// The service boundary is the one door every receive path goes through, so
// the corridor's bounds are enforced there rather than in a sheet that may or
// may not be mounted. These tests pin that contract.
import { describe, expect, it } from "vitest";

import {
  ARKADE_RECEIVE_MAX_SATS,
  ARKADE_RECEIVE_MIN_SATS,
  ArkadeReceiveAmountError,
  checkReceiveAmountSats,
} from "./receiveLimits";

describe("ArkadeReceiveAmountError", () => {
  it("names the bound it broke, so a caller can render it", () => {
    const err = new ArkadeReceiveAmountError("below_min", 501);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ArkadeReceiveAmountError");
    expect(err.problem).toBe("below_min");
    expect(err.amountSats).toBe(501);
    expect(err.minSats).toBe(ARKADE_RECEIVE_MIN_SATS);
    expect(err.maxSats).toBe(ARKADE_RECEIVE_MAX_SATS);
    expect(err.message).toContain(String(ARKADE_RECEIVE_MIN_SATS));
  });

  it("distinguishes above_max", () => {
    const err = new ArkadeReceiveAmountError("above_max", 50_000);
    expect(err.problem).toBe("above_max");
    expect(err.message).toContain(String(ARKADE_RECEIVE_MAX_SATS));
  });

  it("is distinguishable from a network failure", () => {
    const err: unknown = new ArkadeReceiveAmountError("below_min", 100);
    expect(err instanceof ArkadeReceiveAmountError).toBe(true);
    expect(new Error("fetch failed") instanceof ArkadeReceiveAmountError).toBe(false);
  });
});

describe("the guard the service applies", () => {
  // Mirrors ArkadeLightningReceiveService.createArkadeLightningInvoice: the
  // amounts that reach the solver are exactly those that pass this predicate.
  function wouldReachSolver(amountSats: number): boolean {
    if (!Number.isFinite(amountSats) || amountSats <= 0) return false;
    return checkReceiveAmountSats(amountSats) === null;
  }

  it("blocks the amounts the solver refuses", () => {
    expect(wouldReachSolver(501)).toBe(false);
    expect(wouldReachSolver(50_000)).toBe(false);
    expect(wouldReachSolver(0)).toBe(false);
    expect(wouldReachSolver(-1)).toBe(false);
  });

  it("lets a normal receive through", () => {
    expect(wouldReachSolver(505)).toBe(true);
    expect(wouldReachSolver(1_000)).toBe(true);
    expect(wouldReachSolver(49_830)).toBe(true);
  });
});
