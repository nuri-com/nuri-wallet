// Pre-quote amount bounds for a move, from the server's `swap_limits`.
//
// The app never works out a provider's minimum itself: the server states each
// route's published band and this module only (1) folds the bands of the v2
// pairs one move would quote into the least restrictive bound — the smallest
// floor and the largest ceiling, because the move is possible if ANY route takes
// it — and (2) re-expresses that bound in the move's own unit (sats for the
// Bitcoin rails). A bound that any route leaves open (null) stays open: nothing
// is ruled out that some route might accept, and no number is invented.
import { SATS_PER_BTC } from "../../lib/bitcoin/convert";
import type { SwapKitV2LimitsResponse } from "./SwapKitV2Service";

/** A move's bound in the move's unit (sats for Bitcoin, whole tokens else). */
export type SwapAmountBounds = { min: number | null; max: number | null };

const BTC_UNIT_ASSETS = new Set(["BTC", "BTC_LN", "BTC_ARKADE"]);

/** Exact decimal BTC string -> integer sats, rounded outward so a floor never
 * drops below and a ceiling never rises above what the provider stated. */
function btcToSats(value: string, round: "up" | "down"): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const frac = match[2] ?? "";
  const whole = Number(match[1]) * SATS_PER_BTC + Number(frac.slice(0, 8).padEnd(8, "0"));
  const remainder = /[1-9]/.test(frac.slice(8));
  const sats = remainder && round === "up" ? whole + 1 : whole;
  return Number.isSafeInteger(sats) && sats > 0 ? sats : null;
}

function inMoveUnit(asset: string, value: string | null, round: "up" | "down"): number | null {
  if (value == null) return null;
  if (BTC_UNIT_ASSETS.has(asset)) return btcToSats(value, round);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Fold the pair answers into one bound in the move's unit. A missing answer
 * (old server, network error) is `null` and leaves both bounds open — the move
 * behaves exactly as it did before `swap_limits` existed.
 */
export function foldSwapAmountBounds(
  answers: ReadonlyArray<SwapKitV2LimitsResponse | null>,
): SwapAmountBounds {
  if (answers.length === 0 || answers.some((answer) => answer == null)) {
    return { min: null, max: null };
  }
  const pick = (key: "min" | "max"): number | null => {
    const values = (answers as SwapKitV2LimitsResponse[]).map((answer) =>
      inMoveUnit(answer.from, answer[key], key === "min" ? "up" : "down"),
    );
    if (values.some((value) => value == null)) return null;
    const numbers = values as number[];
    return key === "min" ? Math.min(...numbers) : Math.max(...numbers);
  };
  return { min: pick("min"), max: pick("max") };
}

/** What the CTA says instead of pricing: the amount is outside every route. */
export type SwapBoundBlock = { kind: "min" | "max"; value: number } | null;

export function swapBoundBlock(
  amount: number,
  bounds: SwapAmountBounds | null | undefined,
): SwapBoundBlock {
  if (!bounds || !(amount > 0)) return null;
  if (bounds.min != null && amount < bounds.min) return { kind: "min", value: bounds.min };
  if (bounds.max != null && amount > bounds.max) return { kind: "max", value: bounds.max };
  return null;
}
