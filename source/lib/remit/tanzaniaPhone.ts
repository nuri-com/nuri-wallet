/**
 * Recognising a Tanzanian mobile number in the Bitcoin send screen.
 *
 * The recipient field already takes every Bitcoin rail, so this match has to be
 * the narrowest one that still accepts how people actually write their number:
 * a string only counts once it carries a Tanzanian country code or the national
 * trunk prefix AND lands in a mobile range. Anything looser and a mistyped
 * invoice would start a remittance to a stranger's phone.
 *
 * The ranges are deliberately structural — country code 255, nine subscriber
 * digits, leading 6 or 7 — and not a list of network prefixes. A prefix
 * allowlist copied into the app goes stale the moment the regulator assigns a
 * new one, and the failure it produces is a valid number the wallet refuses.
 * ClickPesa validates the number authoritatively; this only decides which rail
 * the screen is on.
 */

const COUNTRY_CODE = "255";
const SUBSCRIBER_DIGITS = 9;
/** Mobile ranges are 6x and 7x; 2x is the fixed-line block, which is not payable. */
const MOBILE_LEADING = /^[67]/;

/** Everything a person might type between the digits, dropped before matching. */
function stripSeparators(raw: string): string {
  return String(raw || "").replace(/[\s()\-./\p{Cf}]/gu, "");
}

/**
 * The subscriber part — nine digits, no country code, no trunk zero — or null
 * when the input is not a Tanzanian mobile number in any of its written forms.
 */
function subscriberPart(raw: string): string | null {
  const compact = stripSeparators(raw);
  if (!compact) return null;

  const withoutPlus = compact.startsWith("+") ? compact.slice(1) : compact;
  if (!/^\d+$/.test(withoutPlus)) return null;

  // +255712345678 / 255712345678
  if (withoutPlus.startsWith(COUNTRY_CODE)) {
    const rest = withoutPlus.slice(COUNTRY_CODE.length);
    return rest.length === SUBSCRIBER_DIGITS && MOBILE_LEADING.test(rest) ? rest : null;
  }
  // 0712345678 — the national trunk form
  if (withoutPlus.startsWith("0")) {
    const rest = withoutPlus.slice(1);
    return rest.length === SUBSCRIBER_DIGITS && MOBILE_LEADING.test(rest) ? rest : null;
  }
  // 712345678 — bare subscriber digits. Accepted because it is what people read
  // off a contact card, and nine digits opening on 6 or 7 collides with nothing
  // else this field takes.
  if (withoutPlus.length === SUBSCRIBER_DIGITS && MOBILE_LEADING.test(withoutPlus)) {
    return withoutPlus;
  }
  return null;
}

/**
 * The number in the one form the remit service is asked with: E.164, `+255…`.
 * Null when the input is not a Tanzanian mobile number — null is the answer the
 * screen branches on, so no rail is chosen from a half-typed string.
 */
export function normalizeTanzanianMobileNumber(raw: string): string | null {
  const subscriber = subscriberPart(raw);
  return subscriber === null ? null : `+${COUNTRY_CODE}${subscriber}`;
}

export function isTanzanianMobileNumber(raw: string): boolean {
  return normalizeTanzanianMobileNumber(raw) !== null;
}

/** `+255 712 345 678` — the number as the confirmation row shows it back. */
export function formatTanzanianMobileNumber(raw: string): string {
  const subscriber = subscriberPart(raw);
  if (subscriber === null) return String(raw || "").trim();
  const groups = [subscriber.slice(0, 3), subscriber.slice(3, 6), subscriber.slice(6)];
  return `+${COUNTRY_CODE} ${groups.join(" ")}`;
}
