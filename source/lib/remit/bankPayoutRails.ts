/**
 * Which bank and card payouts the "abroad" picker offers above its countries
 * (#1843).
 *
 * Only rails the opening screen can run right now: a euro SEPA transfer once
 * the Visa & Banking IBAN is there, a UK transfer only where Wirex switched
 * sending to UK accounts on, and a payout to a Visa or Mastercard once the
 * Visa & Banking account is ready (the existing push-to-card flow, which
 * checks the recipient card, prices and confirms). Nothing is shown as a
 * placeholder: there is no US dollar bank rail yet (ACH is #1556), so USD is
 * never listed.
 */

export type BankPayoutRail = "sepa" | "uk" | "card";

export type BankPayoutRailsInput = {
  sepaReady: boolean;
  ukSend: boolean;
  cardReady: boolean;
};

export function bankPayoutRails({
  sepaReady,
  ukSend,
  cardReady,
}: BankPayoutRailsInput): BankPayoutRail[] {
  const rails: BankPayoutRail[] = [];
  if (sepaReady) rails.push("sepa");
  if (ukSend) rails.push("uk");
  if (cardReady) rails.push("card");
  return rails;
}
