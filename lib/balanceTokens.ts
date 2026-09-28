import type { BalanceToken } from "../types/shared";

/**
 * Tokenize a fiat balance (e.g. EUR, USD) into renderable tokens.
 * Handles negative values, leading zeros, decimal point, and digit grouping after the 2nd fractional digit.
 */
export function tokenizeFiatBalance(amount: number): {
  tokens: BalanceToken[];
  isNegative: boolean;
} {
  const isNegative = amount < 0;
  const absoluteValue = Math.abs(amount);
  const formatted = absoluteValue.toFixed(2);
  const [integerPart, fractionalPartRaw = ""] = formatted.split(".");

  const tokens: BalanceToken[] = [];
  let leading = true;

  for (const [index, char] of integerPart.split("").entries()) {
    const isLeadingZero = leading && char === "0";
    tokens.push({
      key: `int-${index}`,
      type: "digit",
      char,
      leading: isLeadingZero,
    });
    if (char !== "0") leading = false;
  }

  tokens.push({ key: "dot", type: "dot", char: "." });

  const fractionalChars = fractionalPartRaw.split("");
  const firstTwo = fractionalChars.slice(0, 2);
  const remainder = fractionalChars.slice(2);

  for (const [index, char] of firstTwo.entries()) {
    const isLeadingZero = leading && char === "0";
    tokens.push({
      key: `frac2-${index}`,
      type: "digit",
      char,
      leading: isLeadingZero,
    });
    if (char !== "0") leading = false;
  }

  if (remainder.length > 0) {
    tokens.push({ key: "spacer-first-rem", type: "spacer" });
  }

  for (const [index, char] of remainder.entries()) {
    const isLeadingZero = leading && char === "0";
    tokens.push({
      key: `fracR-${index}`,
      type: "digit",
      char,
      leading: isLeadingZero,
    });
    if (char !== "0") leading = false;
    const isEndOfGroup = (index + 1) % 3 === 0 && index !== remainder.length - 1;
    if (isEndOfGroup) {
      tokens.push({ key: `spacer-rem-${index}`, type: "spacer" });
    }
  }

  return { tokens, isNegative };
}

/**
 * Tokenize a sats balance (integer) into renderable tokens.
 * No decimal point, no spacers — just digits with leading zero detection.
 */
export function tokenizeSatsBalance(sats: number): {
  tokens: BalanceToken[];
  isNegative: boolean;
} {
  const safeSats = Number.isFinite(sats) ? Math.trunc(sats) : 0;
  const isNegative = safeSats < 0;
  const absoluteValue = Math.abs(safeSats);
  const digits = absoluteValue.toString();

  const tokens: BalanceToken[] = [];
  let leading = true;

  for (const [index, char] of digits.split("").entries()) {
    const isLeadingZero = leading && char === "0";
    tokens.push({
      key: `int-${index}`,
      type: "digit",
      char,
      leading: isLeadingZero,
    });
    if (char !== "0") leading = false;
  }

  return { tokens, isNegative };
}
