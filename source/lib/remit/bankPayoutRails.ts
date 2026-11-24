/**
 * Which bank payouts the "abroad" picker offers above its countries (#1843).
 *
 * Only rails the opening screen can run right now: a euro SEPA transfer once
 * the Visa & Banking IBAN is there, a UK transfer only where Wirex switched
 * sending to UK accounts on. Nothing is shown as a placeholder: there is no US
 * dollar bank rail yet (ACH is #1556), so USD is never listed.
 */

export type BankPayoutRail = "sepa" | "uk";

export type BankPayoutRailsInput = {
  sepaReady: boolean;
  ukSend: boolean;
};

export function bankPayoutRails({ sepaReady, ukSend }: BankPayoutRailsInput): BankPayoutRail[] {
  const rails: BankPayoutRail[] = [];
  if (sepaReady) rails.push("sepa");
  if (ukSend) rails.push("uk");
  return rails;
}
