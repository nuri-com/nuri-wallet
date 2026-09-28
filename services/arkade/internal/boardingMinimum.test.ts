import { afterEach, describe, expect, it } from "vitest";
import {
  ARKADE_BOARDING_CLAIM_FALLBACK_MIN_SATS,
  getArkadeBoardingMinimumSats,
  isArkadeBoardingClaimable,
  primeArkadeBoardingMinimumSats,
  resetArkadeBoardingMinimumSats,
} from "./boardingMinimum";

afterEach(() => {
  resetArkadeBoardingMinimumSats();
});

describe("boarding floor", () => {
  it("falls back to 330 until a node has been read", () => {
    expect(ARKADE_BOARDING_CLAIM_FALLBACK_MIN_SATS).toBe(330);
    expect(getArkadeBoardingMinimumSats()).toBe(330);
    expect(isArkadeBoardingClaimable(329)).toBe(false);
    expect(isArkadeBoardingClaimable(330)).toBe(true);
  });

  it("applies the node's floor to each UTXO, not their combined value", () => {
    primeArkadeBoardingMinimumSats({ utxoMinAmount: 330 });
    expect([100, 100, 100].map((sats) => isArkadeBoardingClaimable(sats))).toEqual([
      false,
      false,
      false,
    ]);
    // /v1/info reports utxoMinAmount 330 on mainnet; the node lowered it from
    // 3,000, and the old hardcoded figure kept a 2,500 sat deposit unclaimable.
    expect(isArkadeBoardingClaimable(2_500)).toBe(true);
  });

  it("honours a custom node whose floor is still 3,000", () => {
    primeArkadeBoardingMinimumSats({ utxoMinAmount: "3000" });
    expect(getArkadeBoardingMinimumSats()).toBe(3_000);
    expect(isArkadeBoardingClaimable(2_500)).toBe(false);
    expect(isArkadeBoardingClaimable(3_000)).toBe(true);
  });

  it("keeps the last good floor when a read comes back empty or unreadable", () => {
    primeArkadeBoardingMinimumSats({ utxoMinAmount: 3_000 });
    primeArkadeBoardingMinimumSats({});
    primeArkadeBoardingMinimumSats(null);
    primeArkadeBoardingMinimumSats({ utxoMinAmount: "n/a" });
    expect(getArkadeBoardingMinimumSats()).toBe(3_000);
    resetArkadeBoardingMinimumSats();
    expect(getArkadeBoardingMinimumSats()).toBe(330);
  });
});
