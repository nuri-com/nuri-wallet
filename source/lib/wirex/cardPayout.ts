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

export function pickPayoutDebitToken(
  balances: WirexTokenBalance[],
  currency: PayoutCurrency,
): PayoutDebitToken | null {
  const usable: PayoutDebitToken[] = [];
  for (const b of balances) {
    const amount = Number(b.balance);
    if (!b.tokenAddress || !b.tokenSymbol || !Number.isFinite(amount) || amount <= 0) continue;
    usable.push({ tokenAddress: b.tokenAddress, tokenSymbol: b.tokenSymbol, balance: amount });
  }
  const largest = (list: PayoutDebitToken[]) =>
    list.reduce<PayoutDebitToken | null>((a, b) => (!a || b.balance > a.balance ? b : a), null);
  const same = usable.filter((x) => TOKENS_BY_CURRENCY[currency].has(x.tokenSymbol.toUpperCase()));
  return largest(same) ?? largest(usable);
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
