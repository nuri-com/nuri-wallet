import { describe, expect, it } from "vitest";

import { checkRemitInvoice, remitPressOutcome } from "./remitInvoiceGuard";

// The corridor funds a lockup carrying the invoice PLUS its spread, so the
// balance comparison is never against the bare invoice amount.
const fundingSatsFor = (sats: number) => Math.ceil(sats * 1.02);

const base = {
  acceptedSats: 2500,
  maxSpendableSats: 100_000,
  minSats: 500,
  maxSats: 50_000,
  fundingSatsFor,
};

describe("checkRemitInvoice", () => {
  it("admits the invoice the user accepted", () => {
    expect(checkRemitInvoice({ ...base, invoiceSats: 2500 })).toBeNull();
  });

  it("admits an invoice cheaper than the quote", () => {
    // The payout is fixed at the shilling figure, so a cheaper invoice just
    // means the user pays less for the same delivery.
    expect(checkRemitInvoice({ ...base, invoiceSats: 2400 })).toBeNull();
  });

  it("refuses an invoice above the accepted quote even when the balance covers it", () => {
    // The regression this module exists for: affordability is not consent.
    // 3000 sats is comfortably inside a 100 000 sat balance, and every check
    // that only asks "can they pay it?" dispatches it without a word.
    expect(checkRemitInvoice({ ...base, invoiceSats: 3000 })).toBe("exceeds_accepted_quote");
  });

  it("refuses an amountless or undecodable invoice", () => {
    expect(checkRemitInvoice({ ...base, invoiceSats: 0 })).toBe("amount_missing");
    expect(checkRemitInvoice({ ...base, invoiceSats: Number.NaN })).toBe("amount_missing");
  });

  it("holds the invoice to the corridor's own band", () => {
    expect(checkRemitInvoice({ ...base, acceptedSats: 100, invoiceSats: 100 })).toBe(
      "below_corridor_minimum",
    );
    expect(checkRemitInvoice({ ...base, acceptedSats: 60_000, invoiceSats: 60_000 })).toBe(
      "above_corridor_maximum",
    );
  });

  it("refuses what the wallet cannot fund, spread included", () => {
    // 2500 alone fits in 2540; 2500 + the 2% spread does not.
    expect(checkRemitInvoice({ ...base, invoiceSats: 2500, maxSpendableSats: 2540 })).toBe(
      "exceeds_balance",
    );
  });

  it("does not gate on a balance it does not know yet", () => {
    expect(checkRemitInvoice({ ...base, invoiceSats: 2500, maxSpendableSats: null })).toBeNull();
  });
});

describe("remitPressOutcome", () => {
  it("never pays on the first press, whatever the invoice costs", () => {
    // The regression: an invoice cheaper than, equal to, or dearer than the
    // quote all reach the same first press, and that press is labelled as
    // fetching a price. Only the second press may pay.
    expect(remitPressOutcome(false)).toBe("show_price");
  });

  it("pays once an invoice has been shown at its own price", () => {
    expect(remitPressOutcome(true)).toBe("pay");
  });

  it("keeps the price comparison out of the decision", () => {
    // Each of these was previously the difference between showing and paying.
    for (const invoiceSats of [2400, 2500, 3000]) {
      const refusal = checkRemitInvoice({ ...base, invoiceSats });
      // Whatever the guard says about the price, the first press still shows.
      expect(remitPressOutcome(false)).toBe("show_price");
      expect(refusal === null || refusal === "exceeds_accepted_quote").toBe(true);
    }
  });
});
