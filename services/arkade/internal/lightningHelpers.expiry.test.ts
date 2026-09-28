import { describe, expect, it } from "vitest";
import { assertInvoiceStillPayable, LIGHTNING_FUNDING_EXPIRY_MARGIN_SEC } from "./lightningHelpers";

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;

describe("assertInvoiceStillPayable", () => {
  it("passes an invoice with time to spare", () => {
    expect(() => assertInvoiceStillPayable(NOW_SEC + 3_600, NOW_MS)).not.toThrow();
  });

  // Everything between the decode and the funding — the refund key, the route,
  // the server intent, the passkey prompt — takes real time.
  it("refuses one that expired while the send was being approved", () => {
    expect(() => assertInvoiceStillPayable(NOW_SEC - 1, NOW_MS)).toThrow(/expired/);
  });

  // Funding is not paying: the solver still has to route it. A lockup funded
  // against an invoice that dies first is one nobody can claim, and the user
  // waits out the refund timelock for a payment that never happened.
  it("refuses one too close to expiry for the solver to pay", () => {
    expect(() =>
      assertInvoiceStillPayable(NOW_SEC + LIGHTNING_FUNDING_EXPIRY_MARGIN_SEC - 1, NOW_MS),
    ).toThrow(/too soon/);
  });

  it("accepts one exactly at the margin", () => {
    expect(() =>
      assertInvoiceStillPayable(NOW_SEC + LIGHTNING_FUNDING_EXPIRY_MARGIN_SEC, NOW_MS),
    ).not.toThrow();
  });

  // An invoice that states no expiry is left to the rails that do check it;
  // inventing a deadline here would refuse payments nothing else objects to.
  it.each([[0], [Number.NaN]])("ignores an unusable expiry (%s)", (expiresAt) => {
    expect(() => assertInvoiceStillPayable(expiresAt, NOW_MS)).not.toThrow();
  });
});
