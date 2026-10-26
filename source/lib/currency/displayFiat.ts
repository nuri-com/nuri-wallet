// Pure figure helpers for the display (home) currency. A figure that is a
// CONVERSION into it goes through `toHomeFiat`; a missing rate yields null, and
// null is written as the unknown placeholder — never a made-up number.

import { groupAmount } from "../formatting";
import { CURRENCIES, type FiatCode } from "../tokens";

/** Fiat rates relative to USD, as FxRateService returns them. */
export type FiatRates = Partial<Record<FiatCode, number>>;

/** A figure nobody has read yet — a zero and an unknown mean opposite things. */
export const UNKNOWN_FIGURE = "\u2014";

const validRate = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * `amount` held in `from`, expressed in `to`. Same currency needs no rate; any
 * other pair needs both real rates, else null.
 */
export function convertFiat(
  amount: number | null,
  from: FiatCode,
  to: FiatCode,
  rates: FiatRates | null | undefined,
): number | null {
  if (amount === null || !Number.isFinite(amount)) return null;
  // Nothing is nothing in every currency — an empty balance needs no rate.
  if (from === to || amount === 0) return amount;
  const fromRate = rates?.[from];
  const toRate = rates?.[to];
  if (!validRate(fromRate) || !validRate(toRate)) return null;
  return amount * (fromRate / toRate);
}

/**
 * A BTC price quoted in `rateCurrency`, expressed in `home`. Null while no rate
 * has been read, or when it is in another currency and FX is unavailable.
 */
export function btcRateInHome(
  rate: number | null,
  rateCurrency: FiatCode | null,
  home: FiatCode,
  rates: FiatRates | null | undefined,
): number | null {
  if (!validRate(rate ?? undefined) || !rateCurrency) return null;
  const converted = convertFiat(rate, rateCurrency, home, rates);
  return validRate(converted ?? undefined) ? converted : null;
}

/** A BTC price and the currency it is quoted in, as BtcFiatRateStore holds it. */
export type BtcQuote = { rate: number | null; currency: FiatCode | null };

const SATS_PER_BTC = 100_000_000;

/** Sats expressed in `target`. Null without a rate (or FX, across currencies). */
export function satsToFiatIn(
  sats: number,
  target: FiatCode,
  btc: BtcQuote,
  rates: FiatRates | null | undefined,
): number | null {
  const rate = btcRateInHome(btc.rate, btc.currency, target, rates);
  return rate === null ? null : (sats / SATS_PER_BTC) * rate;
}

/** An amount held in `held`, expressed in whole sats. Null when unknown. */
export function fiatToSatsFrom(
  amount: number,
  held: FiatCode,
  btc: BtcQuote,
  rates: FiatRates | null | undefined,
): number | null {
  const rate = btcRateInHome(btc.rate, btc.currency, held, rates);
  return rate === null ? null : Math.round((amount / rate) * SATS_PER_BTC);
}

/** Sum of every part, or null as soon as one part is unknown. */
export function sumKnown(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null || !Number.isFinite(value))) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/** Two decimals, no grouping — the compact list writing. */
export const ungroupedFiat = (value: number): string =>
  Math.max(0, Number.isFinite(value) ? value : 0).toFixed(2);

const digits = (value: number, grouped: boolean) =>
  grouped ? groupAmount(Math.max(0, value)) : ungroupedFiat(value);

/**
 * One fiat figure. `code` writes the ISO code ("USD 1 240.00") — rows and
 * sheets; `glyph` writes the symbol ("$ 1 240.00") — the 3xl balance region.
 * `grouped: false` is the compact list writing ("USD 1240.00").
 */
export function formatFiat(
  value: number | null,
  currency: FiatCode,
  opts: { style?: "code" | "glyph"; grouped?: boolean } = {},
): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN_FIGURE;
  const prefix = opts.style === "glyph" ? CURRENCIES[currency].fiatSymbol : currency;
  return `${prefix} ${digits(value, opts.grouped ?? true)}`;
}

/**
 * A held balance's list line: its own currency, plus "≈ <home>" when the home
 * currency differs and the conversion is known. An unread balance is the
 * unknown mark, never a 0: only a balance nobody has read is unknown, and a
 * real zero still prints as zero.
 */
export function heldWithHome(
  value: number | null,
  held: FiatCode,
  home: FiatCode,
  rates: FiatRates | null | undefined,
): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN_FIGURE;
  const own = formatFiat(value, held, { grouped: false });
  if (held === home) return own;
  const converted = convertFiat(value, held, home, rates);
  return converted === null
    ? own
    : `${own} \u2248 ${formatFiat(converted, home, { grouped: false })}`;
}
