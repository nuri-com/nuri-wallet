import { beforeEach, describe, expect, it, vi } from "vitest";

// The decoder is stubbed so each case can state one invoice fact exactly. The
// amounts below cannot be minted from a real wallet — providers round to whole
// sats — and the rule under test is ours, not the decoder's.
const sections = vi.fn();
vi.mock("light-bolt11-decoder", () => ({
  // Shape as the production decoder returns it: every tag is a section. The
  // top-level `expiry` getter is deliberately absent — reading it is what this
  // module must not do, since builds of the decoder disagree on whether it is a
  // duration or an absolute time.
  decode: () => ({ sections: sections() }),
}));

import { decodeBolt11Facts } from "./lightning";

const PAYMENT_HASH = "ab".repeat(32);
const TIMESTAMP = 1_700_000_000;

function invoiceSections(msats: number, expirySec?: number, timestamp = TIMESTAMP) {
  const base = [
    { name: "payment_hash", value: PAYMENT_HASH },
    { name: "amount", value: msats },
    { name: "timestamp", value: timestamp },
  ];
  return expirySec === undefined ? base : [...base, { name: "expiry", value: expirySec }];
}

beforeEach(() => {
  sections.mockReset();
});

describe("decodeBolt11Facts", () => {
  it("reads a whole-sat amount, and defaults the expiry when the tag is absent", () => {
    sections.mockReturnValue(invoiceSections(500_000));

    expect(decodeBolt11Facts("lnbc1whatever")).toMatchObject({
      paymentHash: PAYMENT_HASH,
      amountSats: 500,
      // BOLT11 leaves the `x` tag optional and defaults it to 3600 seconds.
      expiresAt: TIMESTAMP + 3600,
    });
  });

  // The tag is a duration, and the absolute deadline is the timestamp plus it.
  // A short-lived invoice must not stay payable past its own expiry, and a
  // long-lived one must not be refused an hour in.
  it.each([
    ["a short-lived invoice", 60],
    ["a day-long invoice", 86_400],
    ["a thirty-day invoice", 2_592_000],
  ])("reads the expiry tag of %s", (_label, expirySec) => {
    sections.mockReturnValue(invoiceSections(500_000, expirySec));

    expect(decodeBolt11Facts("lnbc1whatever").expiresAt).toBe(TIMESTAMP + expirySec);
  });

  // Every rail here counts in whole sats and the corridor is exact-out: a
  // 500.5-sat invoice truncated to 500 funds a lockup for an amount the invoice
  // will not settle for, and the difference vanishes where nobody can see it.
  it("refuses an amount that is not a whole number of sats", () => {
    sections.mockReturnValue(invoiceSections(500_500));

    expect(() => decodeBolt11Facts("lnbc1whatever")).toThrow(/whole number of sats/);
  });

  it("refuses an amountless invoice", () => {
    sections.mockReturnValue([
      { name: "payment_hash", value: PAYMENT_HASH },
      { name: "timestamp", value: TIMESTAMP },
    ]);

    expect(() => decodeBolt11Facts("lnbc1whatever")).toThrow(/amount missing or invalid/);
  });
});
