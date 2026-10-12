// lib/wirex/cardPayout.ts
// Pure helpers for push to card. Wirex pays a card from ONE balance token; the
// one in the card's currency avoids an exchange, otherwise the largest one
// pays and Wirex converts.
import type { WirexTokenBalance } from "../../services/wirex/WirexService";

export type PayoutCurrency = "EUR" | "USD";
export type PayoutDebitToken = { tokenAddress: string; tokenSymbol: string; balance: number };

const TOKENS_BY_CURRENCY: Record<PayoutCurrency, Set<string>> = {
  EUR: new Set(["WEUR", "EURC", "EURE"]),
  USD: new Set(["WUSD", "USDC"]),
};

/** Whether a balance token is held in the card's own currency (no exchange). */
export function isPayoutCurrencyToken(token: PayoutDebitToken, currency: PayoutCurrency): boolean {
  return TOKENS_BY_CURRENCY[currency].has(token.tokenSymbol.toUpperCase());
}

/**
 * Every funded token that can pay the card, in the order to try them: the
 * card's own currency first, then the others (Wirex converts), largest first
 * within each. Dust never hides a funded alternative: the quote decides.
 */
export function payoutDebitCandidates(
  balances: WirexTokenBalance[],
  currency: PayoutCurrency,
): PayoutDebitToken[] {
  const usable: PayoutDebitToken[] = [];
  for (const b of balances) {
    const amount = Number(b.balance);
    if (!b.tokenAddress || !b.tokenSymbol || !Number.isFinite(amount) || amount <= 0) continue;
    usable.push({ tokenAddress: b.tokenAddress, tokenSymbol: b.tokenSymbol, balance: amount });
  }
  const byBalance = (a: PayoutDebitToken, b: PayoutDebitToken) => b.balance - a.balance;
  const same = usable.filter((x) => isPayoutCurrencyToken(x, currency)).sort(byBalance);
  const other = usable.filter((x) => !isPayoutCurrencyToken(x, currency)).sort(byBalance);
  return [...same, ...other];
}

// A card number as typed: digits only, grouped in fours for reading.
export function formatCardNumberInput(text: string): string {
  return text
    .replace(/\D/g, "")
    .slice(0, 19)
    .replace(/(\d{4})(?=\d)/g, "$1 ");
}

// Visa and Mastercard numbers pass the Luhn check; anything else is a typo
// that Wirex would refuse after the user already waited for it.
export function isPlausibleCardNumber(text: string): boolean {
  const digits = text.replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
