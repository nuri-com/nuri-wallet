import { groupCount } from "./formatting";
export const truncateDecimalString = (value: string, decimals: number): string => {
  const [intPart, fracPart = ""] = String(value).split(".");
  if (decimals <= 0) return intPart;
  const frac = fracPart.padEnd(decimals, "0").slice(0, decimals);
  return `${intPart}.${frac}`;
};

export const parseEurAmount = (text: string): number => {
  const digitsOnly = String(text || "").replace(/[^0-9]/g, "");
  const euros = Number.parseInt(digitsOnly || "0", 10);
  if (!Number.isFinite(euros)) return 0;
  return euros;
};

export const parseFiatAmount = (value: unknown): number => {
  const parsed = Number.parseFloat(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

export const formatEuro = (value: number): string => `EUR ${value.toFixed(2)}`;

export const formatSats = (value: number): string => groupCount(value);

export const toSatsFromBtcAmount = (value: unknown): number => {
  const btc = Number.parseFloat(String(value || "").trim());
  if (!Number.isFinite(btc) || btc <= 0) return 0;
  return Math.max(0, Math.round(btc * 100_000_000));
};

export const truncateBalanceToCents = (value: number): number => {
  const truncated = truncateDecimalString(String(value), 2);
  return Number(truncated);
};

/**
 * An amount re-expressed for the rail that is about to carry it, written the
 * way that rail's keypad holds a figure. The rail's own contract decides it:
 * sats have no sub-unit and carry whole units, every fiat rail carries cents.
 * Deciding by MAGNITUDE instead rounded 2340.49 euro to 2340 before the move
 * was quoted, because the figure happened to be four digits long.
 */
export const carriedAmountText = (value: number, whole: boolean): string =>
  whole ? String(Math.round(value)) : value.toFixed(2);

/**
 * A stablecoin amount as the decimal string a transfer carries: every decimal
 * the token has (6 for EURC/USDC), cut — never rounded up — so a full balance
 * such as 0.995018 goes out whole and a figure can never exceed what is held.
 * The 8-place detour only absorbs binary float noise before the cut.
 */
export const stableAmountText = (value: number): string => {
  const [whole, fraction = ""] = Math.max(0, value).toFixed(8).split(".");
  const kept = fraction.slice(0, 6).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
};

export const formatBalance = (amount: number) => {
  const [whole, decimal] = amount.toFixed(2).split(".");
  return { whole, decimal };
};

/**
 * Prefill for an amount carried in by a payment QR. The exact string is what
 * gets sent; the display is capped to 2 decimals. The balance plays no part:
 * an amount above it is still shown, and the send screen blocks its CTA with
 * the over-balance hint (#1486). Clearing it left the user with an empty field
 * and no reason why.
 */
export const scannedAmountPrefill = (
  scanned: string | null | undefined,
): { exact: string | null; display: string } => {
  const numeric = scanned != null ? Number(scanned) : 0;
  if (scanned == null || !Number.isFinite(numeric) || numeric <= 0) {
    return { exact: null, display: "" };
  }
  return { exact: scanned, display: truncateDecimalString(scanned, 2) };
};
