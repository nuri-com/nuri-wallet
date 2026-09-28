export function sanitizeDigits(raw: string): string {
  if (!raw) return "";
  const numeric = raw.replace(/[^0-9]/g, "");
  return numeric.replace(/^0+(?=\d)/, "");
}

/**
 * Sanitize input as a fiat-shaped decimal: digits + at most one dot, max 2 decimal places.
 * Comma is normalized to dot. Leading zeros stripped (except solo "0").
 * Trailing dot is preserved while the user is mid-typing ("12." stays "12.").
 */
export function sanitizeFiatDigits(raw: string): string {
  if (!raw) return "";
  const cleaned = raw.replace(/,/g, ".");
  const match = cleaned.match(/^(\d*)(?:\.(\d*))?/);
  if (!match) return "";
  const rawInt = match[1] || "";
  const hasDot = cleaned.length > rawInt.length && cleaned[rawInt.length] === ".";
  if (!rawInt && !hasDot) return "";
  const intPart = rawInt ? rawInt.replace(/^0+(?=\d)/, "") : "0";
  const decPart = (match[2] || "").replace(/[^0-9]/g, "").slice(0, 2);
  const trailingDot = hasDot && decPart.length === 0;
  if (decPart.length > 0) return `${intPart}.${decPart}`;
  if (trailingDot) return `${intPart}.`;
  return intPart;
}
