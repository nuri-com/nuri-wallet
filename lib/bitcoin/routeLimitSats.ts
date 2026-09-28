// A SwapKit route limit, in sats.
//
// The same field arrives in two shapes: `minSats` (already sats) and `min`
// (whose unit is whatever `unit`/`asset` says — commonly BTC on the Bitcoin
// rails). Truncating the BTC shape reads 0.0001 as zero, which is how a
// 10 000-sat floor became a fallback and the UI offered amounts the corridor
// would refuse at creation. Converted in one place so every rail applies the
// same rule.
import { SATS_PER_BTC } from "./convert";

type RouteLimitLike = {
  min?: number | string | null;
  max?: number | string | null;
  minSats?: number | string | null;
  maxSats?: number | string | null;
  unit?: string | null;
  asset?: string | null;
} | null;

function numeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isBtcDenominated(limits: RouteLimitLike): boolean {
  const unit = String(limits?.unit || "").toUpperCase();
  const asset = String(limits?.asset || "").toUpperCase();
  return unit === "BTC" || (unit === "" && (asset === "BTC" || asset === "BTC_LN"));
}

/**
 * The floor in sats, rounded UP: a minimum rounded down is a minimum the
 * provider will still refuse.
 */
export function routeMinSats(limits: RouteLimitLike): number | null {
  const sats = numeric(limits?.minSats);
  if (sats != null) return Math.ceil(sats);
  const raw = numeric(limits?.min);
  if (raw == null) return null;
  return Math.ceil(isBtcDenominated(limits) ? raw * SATS_PER_BTC : raw);
}

/** The ceiling in sats, rounded DOWN, for the same reason in reverse. */
export function routeMaxSats(limits: RouteLimitLike): number | null {
  const sats = numeric(limits?.maxSats);
  if (sats != null) return Math.floor(sats);
  const raw = numeric(limits?.max);
  if (raw == null) return null;
  return Math.floor(isBtcDenominated(limits) ? raw * SATS_PER_BTC : raw);
}
