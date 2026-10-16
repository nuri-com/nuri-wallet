/**
 * Recognising a Kenyan mobile number in the Bitcoin send screen.
 *
 * Only the international form counts (`+254…` or `254…`). The national trunk
 * form `07…` is already read as a Tanzanian number, and the two countries share
 * that shape, so a number without its country code cannot pick a rail safely.
 *
 * Mobile ranges are 7x and 1x after the country code, nine subscriber digits.
 * ZapRemit validates the number authoritatively; this only decides which rail
 * the screen is on.
 */

const COUNTRY_CODE = "254";
const SUBSCRIBER_DIGITS = 9;
const MOBILE_LEADING = /^[71]/;

function subscriberPart(raw: string): string | null {
  const compact = String(raw || "").replace(/[\s()\-./]/g, "");
  const withoutPlus = compact.startsWith("+") ? compact.slice(1) : compact;
  if (!/^\d+$/.test(withoutPlus) || !withoutPlus.startsWith(COUNTRY_CODE)) return null;
  const rest = withoutPlus.slice(COUNTRY_CODE.length);
  return rest.length === SUBSCRIBER_DIGITS && MOBILE_LEADING.test(rest) ? rest : null;
}

/**
 * The number in the form ZapRemit takes: `254…`, no plus (it refuses `+254…`
 * and `07…`). Null when the input is not a Kenyan mobile number.
 */
export function normalizeKenyanMobileNumber(raw: string): string | null {
  const subscriber = subscriberPart(raw);
  return subscriber === null ? null : `${COUNTRY_CODE}${subscriber}`;
}

/** `+254 712 345 678`, the number as the screen shows it back. */
export function formatKenyanMobileNumber(raw: string): string {
  const subscriber = subscriberPart(raw);
  if (subscriber === null) return String(raw || "").trim();
  const groups = [subscriber.slice(0, 3), subscriber.slice(3, 6), subscriber.slice(6)];
  return `+${COUNTRY_CODE} ${groups.join(" ")}`;
}
