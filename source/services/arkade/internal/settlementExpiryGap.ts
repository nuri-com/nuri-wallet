// The Ark server refuses a settlement input whose batch expiry is further away
// than its `SETTLEMENT_MIN_EXPIRY_GAP` (arkd config, disabled by default, ~29d
// on mainnet). An offboard is a settlement, so a freshly created VTXO is too
// young to exit onchain until its remaining life drops below that gap — roughly
// a day after it was created. Neither the gap nor a "settleable from" timestamp
// is exposed by `/v1/info`; the only source is the rejection message, which
// carries the gap as a Go duration:
//
//   INVALID_PSBT_INPUT (5): vtxo <outpoint> expires after <now+gap> (minExpiryGap: 695h53m36s)

export class ArkadeVtxoTooFreshError extends Error {
  // Epoch ms from which the offboard can succeed. 0 when the wallet's VTXO
  // expiries could not be read, i.e. the wait is unknown.
  readonly availableAtMs: number;

  constructor(availableAtMs: number) {
    super("arkade_vtxo_too_fresh_for_settlement");
    this.name = "ArkadeVtxoTooFreshError";
    const parsed = Number(availableAtMs);
    this.availableAtMs = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  }
}

export function isArkadeVtxoTooFreshError(error: unknown): error is ArkadeVtxoTooFreshError {
  return (
    error instanceof ArkadeVtxoTooFreshError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "ArkadeVtxoTooFreshError" &&
      Number.isFinite(Number((error as { availableAtMs?: unknown }).availableAtMs)))
  );
}

const GO_DURATION_UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
};

// Go's `time.Duration.String()`, e.g. `695h53m36s`. Sub-millisecond units are
// irrelevant for a multi-day gap, so they are ignored rather than parsed.
export function parseGoDurationMs(value: unknown): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let totalMs = 0;
  let matchedUnit = false;
  const units = /([0-9]+(?:\.[0-9]+)?)(ms|h|m|s)/g;
  let unit = units.exec(raw);
  while (unit) {
    const factor = GO_DURATION_UNIT_MS[unit[2]];
    if (factor) {
      totalMs += Number(unit[1]) * factor;
      matchedUnit = true;
    }
    unit = units.exec(raw);
  }
  return matchedUnit && totalMs > 0 ? Math.trunc(totalMs) : null;
}

export function parseSettlementMinExpiryGapMs(message: unknown): number | null {
  const match = /minExpiryGap:\s*([0-9hms.]+)/i.exec(String(message || ""));
  return match ? parseGoDurationMs(match[1]) : null;
}

/**
 * `batchExpiry` reaches us in milliseconds from the wallet model, but the
 * indexer speaks seconds and that value has been seen raw (vtxoFormat carries
 * the same guard for its debug lines). Judge the magnitude: a seconds timestamp
 * is ~1.7e9 where a ms one is ~1.7e12, so anything under 10_000_000_000 is
 * seconds. Getting this wrong is silent — a seconds value compared against
 * `now + gap` in ms always looks settleable, and the filter stops filtering.
 */
export function normalizeExpiryMs(value: unknown): number | null {
  // SDK 0.5 hands expiry over as a `Date`, and a JSON-cached row brings it back
  // as an ISO string; `Number("2027-01-01T…")` is NaN, so both are converted
  // before the numeric path. Bare epoch numbers (seconds or ms) still work.
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value === "string" && value && !/^\d+$/.test(value.trim())) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw < 10_000_000_000 ? Math.trunc(raw * 1000) : Math.trunc(raw);
}

// The offboard settles every spendable VTXO, so the whole send stays blocked
// until the youngest one — the latest expiry — clears the gap.
export function latestVtxoExpiryMs(vtxosRaw: unknown): number | null {
  if (!Array.isArray(vtxosRaw)) return null;
  let latestMs = 0;
  for (const coin of vtxosRaw) {
    if (typeof coin !== "object" || coin === null) continue;
    // SDK 0.5 moved batch expiry out of `virtualStatus` to a top-level
    // `expiresAt`; the legacy envelope is still read first for older cached
    // rows. Reading only the old shape found no expiry at all, so the send
    // gate lost the value it is meant to block on.
    const status = (coin as { virtualStatus?: unknown }).virtualStatus;
    const legacy =
      typeof status === "object" && status !== null
        ? normalizeExpiryMs((status as { batchExpiry?: unknown }).batchExpiry)
        : null;
    const expiryMs = legacy ?? normalizeExpiryMs((coin as { expiresAt?: unknown }).expiresAt);
    if (expiryMs !== null && expiryMs > latestMs) latestMs = expiryMs;
  }
  return latestMs > 0 ? latestMs : null;
}
