import { describe, expect, it } from "vitest";

import { moveSourceAmount, moveSpendAmount } from "./moveSpend";

const ARKADE_TO_ONCHAIN = { fromKey: "arkade", toKey: "onchain" } as const;

describe("moveSpendAmount", () => {
  it("uses the quote's spend when the move has a price", () => {
    // The quote already states the grossed figure; second-guessing it here
    // would reserve the corridor fee twice.
    expect(
      moveSpendAmount({ sourceAmount: 20_000, quotedSendAmount: 20_495, ...ARKADE_TO_ONCHAIN }),
    ).toBe(20_495);
  });

  it("reserves the corridor headroom on an unpriced arkade → on-chain move", () => {
    // This is the Max case that used to pass the sheet and fail after
    // confirmation: the recipient gets 20,000, bitcoinvn takes its spread on
    // top, and funding that invoice charges the Intents fee again.
    const spend = moveSpendAmount({ sourceAmount: 20_000, ...ARKADE_TO_ONCHAIN });
    expect(spend).toBeGreaterThan(20_000);
    expect(spend).toBe(20_562);
  });

  it("does not reserve below the corridor floor", () => {
    // Under the floor the corridor is not offered at all — the Ark offboard
    // runs instead, and reserving a fee it does not charge would refuse a move
    // the wallet can afford.
    expect(moveSpendAmount({ sourceAmount: 3_000, ...ARKADE_TO_ONCHAIN })).toBe(3_000);
  });

  it("leaves every other unpriced pair at the typed amount", () => {
    // on-chain → arkade is a plain MuSig2 send; its miner fee is handled by the
    // transfer service, not by this reservation.
    expect(moveSpendAmount({ sourceAmount: 20_000, fromKey: "onchain", toKey: "arkade" })).toBe(
      20_000,
    );
    expect(moveSpendAmount({ sourceAmount: 20_000 })).toBe(20_000);
  });

  it("treats a missing or zero quote as unpriced", () => {
    expect(
      moveSpendAmount({ sourceAmount: 3_000, quotedSendAmount: null, ...ARKADE_TO_ONCHAIN }),
    ).toBe(3_000);
    expect(
      moveSpendAmount({ sourceAmount: 3_000, quotedSendAmount: 0, ...ARKADE_TO_ONCHAIN }),
    ).toBe(3_000);
  });
});

describe("moveSourceAmount", () => {
  it("takes the exact balance when the typed figure is the balance the sheet states", () => {
    // Card shows 0.995018, the sheet states "1.00", the user types 1.
    expect(moveSourceAmount({ typed: 1, available: 0.995018, whole: false })).toBe(0.995018);
    expect(moveSourceAmount({ typed: 12.35, available: 12.345678, whole: false })).toBe(12.345678);
  });

  it("takes any other figure as typed", () => {
    expect(moveSourceAmount({ typed: 0.5, available: 0.995018, whole: false })).toBe(0.5);
    expect(moveSourceAmount({ typed: 2, available: 0.995018, whole: false })).toBe(2);
    expect(moveSourceAmount({ typed: 1, available: null, whole: false })).toBe(1);
    expect(moveSourceAmount({ typed: 20_000, available: 20_001, whole: true })).toBe(20_000);
  });
});
