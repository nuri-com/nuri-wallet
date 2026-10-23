/**
 * One hardware key pressed on the amount step of a page with no soft keypad.
 *
 * Returns the amount the key produces, or null when the key is not amount
 * entry (so the caller can leave it to the browser). Only the raw character is
 * mapped here; the page still runs the result through its own
 * `changeAmount`, which owns the rules about a second decimal point and
 * leading zeros. That keeps typed and tapped digits on one path.
 */
export function nextAmountFromKey(
  key: string,
  amount: string,
  options: { decimals: boolean },
): string | null {
  if (key.length === 1 && key >= "0" && key <= "9") return `${amount}${key}`;
  if (key === "." || key === ",") return options.decimals ? `${amount}.` : null;
  if (key === "Backspace" || key === "Delete") return amount.slice(0, -1);
  return null;
}
