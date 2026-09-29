/**
 * The check that stands between a minted invoice and the wallet paying it.
 *
 * The screen prices a shilling amount with `quote_tzs` and the user accepts THAT
 * figure. The invoice is minted afterwards and states its own amount, which is
 * what actually leaves the balance — so an invoice that comes back for more than
 * the accepted quote is a price the user never agreed to. Affordability is not
 * consent, and the passkey prompt is an identity check, not a price confirmation.
 *
 * Pure and separate from the screen so the refusal is testable on its own: the
 * case that matters is an invoice ABOVE the accepted quote but still inside the
 * balance, which every affordability check by itself waves through.
 */

export type RemitInvoiceRefusal =
  | "amount_missing"
  | "below_corridor_minimum"
  | "above_corridor_maximum"
  | "exceeds_accepted_quote"
  | "exceeds_balance";

export type RemitInvoiceCheck = {
  /** The amount written inside the minted invoice. */
  invoiceSats: number;
  /** The figure the user accepted on screen, from the quote. */
  acceptedSats: number;
  /** What the wallet may actually spend, or null while it is unknown. */
  maxSpendableSats: number | null;
  /** The corridor's own band, which the invoice must also sit inside. */
  minSats: number;
  maxSats: number;
  /**
   * What the lockup for this invoice really costs, corridor spread included.
   * Comparing the bare invoice amount against the balance admitted amounts the
   * corridor's own funding check then refused.
   */
  fundingSatsFor: (sats: number) => number;
};

/** Null when the invoice may be paid; otherwise why it may not. */
export function checkRemitInvoice(check: RemitInvoiceCheck): RemitInvoiceRefusal | null {
  const { invoiceSats, acceptedSats, maxSpendableSats, minSats, maxSats, fundingSatsFor } = check;

  if (!Number.isFinite(invoiceSats) || invoiceSats <= 0) return "amount_missing";
  if (invoiceSats < minSats) return "below_corridor_minimum";
  if (invoiceSats > maxSats) return "above_corridor_maximum";
  // The whole point of this module. A cheaper invoice than quoted is fine — the
  // payout is fixed at the shilling figure, so the user simply pays less for it
  // — but a dearer one is a different price and needs a fresh decision.
  if (Number.isFinite(acceptedSats) && acceptedSats > 0 && invoiceSats > acceptedSats) {
    return "exceeds_accepted_quote";
  }
  if (maxSpendableSats !== null && fundingSatsFor(invoiceSats) > maxSpendableSats) {
    return "exceeds_balance";
  }
  return null;
}

/**
 * What a press on the phone rail's button may do.
 *
 * The first press is labelled as fetching a price, and a button that says price
 * must never move money — whatever the price turns out to be. So the outcome
 * hangs on one thing only: whether an invoice has already been minted and shown.
 * Deciding it by comparing the invoice against the quote is what let a cheap or
 * exactly-quoted invoice pay straight from the quote button.
 */
export function remitPressOutcome(hasShownInvoice: boolean): "show_price" | "pay" {
  return hasShownInvoice ? "pay" : "show_price";
}
