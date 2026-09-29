// Which VTXOs an offboard may actually settle.
//
// The Ark server refuses a settlement input whose batch expiry is further away
// than its `SETTLEMENT_MIN_EXPIRY_GAP`, so a freshly created VTXO cannot exit
// onchain until its remaining life drops below that gap. `Ramps.offboard()`
// settles EVERY VTXO the wallet reports, so one fresh VTXO used to block the
// whole send (`arkade_vtxo_too_fresh_for_settlement`) even when older ones
// covered the amount.
//
// arkd publishes the gap nowhere, so our own arkade server mirrors it from the
// operator config and hands it over in `/arkade/info`
// (`settlement_min_expiry_gap`) — that is the authoritative source and it
// arrives before the first send. An older server that omits the field leaves
// the rejection message as the only source, so one is parsed and persisted
// there too. Until it has been seen from either, nothing is treated as too
// fresh: refusing funds on a guess would be worse than the retry the server
// already forces.

// Static like every other app module (project rule): TransactionCacheService is already in the
// web bundle via the swap services, so laziness here bought nothing and risked the dropped-target
// runtime failure on the PWA.

import { normalizeExpiryMs } from "./settlementExpiryGap";
import { getCacheValue, setCacheValue } from "../../balance/TransactionCacheService";

const GAP_STORAGE_KEY = "arkade:settlement:min-expiry-gap-ms:v1";

let cachedGapMs: number | null = null;
let gapLoaded = false;

export type SettleabilityInput = {
  value?: unknown;
  isSpent?: unknown;
  virtualStatus?: unknown;
};

export type VtxoSettleability<T> = {
  /** Settleable now: an offboard built from these is accepted. */
  settleable: T[];
  /** Settled but still inside the server's min expiry gap. */
  tooFresh: T[];
  tooFreshSats: number;
};

/** The learned gap, or null while it has never been observed. */
export function getSettlementMinExpiryGapMs(): number | null {
  return cachedGapMs;
}

/** Load the persisted gap once per session (a cold start knows nothing else). */
export async function loadSettlementMinExpiryGapMs(): Promise<number | null> {
  if (gapLoaded) return cachedGapMs;
  gapLoaded = true;
  try {
    const stored = await getCacheValue<number>(GAP_STORAGE_KEY);
    const parsed = Number(stored);
    if (Number.isFinite(parsed) && parsed > 0) cachedGapMs = Math.trunc(parsed);
  } catch {
    // Storage unavailable — stay on "unknown", which classifies nothing away.
  }
  return cachedGapMs;
}

/** Remember a gap the server just told us about (via a rejection message). */
export async function rememberSettlementMinExpiryGapMs(gapMs: number): Promise<void> {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return;
  const next = Math.trunc(gapMs);
  gapLoaded = true;
  if (cachedGapMs === next) return;
  cachedGapMs = next;
  try {
    await setCacheValue(GAP_STORAGE_KEY, next);
  } catch {
    // In-memory value still applies for this session.
  }
}

/**
 * The gap as our own arkade server publishes it
 * (`settlement_min_expiry_gap_seconds` on `/arkade/info` and `/health`, mirrored
 * from the operator's arkd config — nuri-server-musig2-v4-arkade#75). Seconds,
 * and `null` when that deployment was never told the value. This is the
 * authoritative source and it arrives before the first send, so a device no
 * longer has to earn the gap with a failed send; the rejection parser stays as
 * the fallback for a server that publishes nothing.
 */
export async function adoptServerSettlementMinExpiryGapSeconds(
  raw: unknown,
): Promise<number | null> {
  if (raw === null || raw === undefined || raw === "") return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const gapMs = Math.trunc(seconds * 1000);
  await rememberSettlementMinExpiryGapMs(gapMs);
  return gapMs;
}

/** Test seam: drop what a previous test/session learned. */
export function resetSettlementMinExpiryGapForTests(): void {
  cachedGapMs = null;
  gapLoaded = false;
}

// SDK 0.5 dropped the `virtualStatus` envelope: batch expiry is now the
// top-level `expiresAt` (a Date) and there is no nested `batchExpiry`. Reading
// only the old shape returned null for every coin, which made every VTXO look
// settleable-with-unknown-gap. The legacy envelope is still read first for
// vtxos cached by an older build.
function batchExpiryMs(vtxo: SettleabilityInput): number | null {
  const status = vtxo.virtualStatus;
  if (typeof status === "object" && status !== null) {
    const legacy = normalizeExpiryMs((status as { batchExpiry?: unknown }).batchExpiry);
    if (legacy !== null) return legacy;
  }
  return normalizeExpiryMs((vtxo as { expiresAt?: unknown }).expiresAt);
}

// Likewise `isPreconfirmed` is a top-level boolean in 0.5.
function isPreconfirmed(vtxo: SettleabilityInput): boolean {
  const status = vtxo.virtualStatus;
  if (typeof status === "object" && status !== null) {
    const state = (status as { state?: unknown }).state;
    if (typeof state === "string") return state === "preconfirmed";
  }
  return Boolean((vtxo as { isPreconfirmed?: unknown }).isPreconfirmed);
}

/**
 * A VTXO the server will accept as a settlement input right now.
 *
 * Preconfirmed VTXOs are not settleable at all (they are not in a batch yet).
 * A settled one is settleable once its batch expiry is within `gapMs` of now.
 * With an unknown gap every unspent VTXO stays eligible — the pre-existing
 * behaviour, where the server has the last word.
 */
export function isVtxoSettleable(
  vtxo: SettleabilityInput,
  gapMs: number | null,
  nowMs: number,
): boolean {
  if (vtxo.isSpent === true) return false;
  if (isPreconfirmed(vtxo)) return false;
  if (gapMs === null) return true;
  const expiry = batchExpiryMs(vtxo);
  // No expiry to judge (recoverable/swept outputs report none) — leave it in.
  if (expiry === null) return true;
  return expiry <= nowMs + gapMs;
}

/** Split a VTXO set into what an offboard can spend and what is still too fresh. */
export function partitionVtxosBySettleability<T extends SettleabilityInput>(
  vtxos: readonly T[] | null | undefined,
  gapMs: number | null = getSettlementMinExpiryGapMs(),
  nowMs: number = Date.now(),
): VtxoSettleability<T> {
  const settleable: T[] = [];
  const tooFresh: T[] = [];
  let tooFreshSats = 0;
  if (!Array.isArray(vtxos)) return { settleable, tooFresh, tooFreshSats };
  for (const vtxo of vtxos) {
    if (!vtxo || typeof vtxo !== "object") continue;
    if (vtxo.isSpent === true) continue;
    if (isVtxoSettleable(vtxo, gapMs, nowMs)) {
      settleable.push(vtxo);
      continue;
    }
    // Preconfirmed VTXOs are already excluded from the shown balance as
    // "finalizing"; only the settled-but-too-fresh ones are new here.
    if (isPreconfirmed(vtxo)) continue;
    tooFresh.push(vtxo);
    const value = Number(vtxo.value);
    if (Number.isFinite(value) && value > 0) tooFreshSats += value;
  }
  return { settleable, tooFresh, tooFreshSats };
}
