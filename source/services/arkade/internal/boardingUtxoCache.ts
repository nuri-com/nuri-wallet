// One shared, short-lived read of the wallet's boarding UTXOs.
//
// `wallet.getBoardingUtxos()` is NOT one HTTP call: the SDK loops the wallet's
// boarding tapscripts and issues a separate `getCoins(address)` per address
// (see `getBoardingUtxosForSigners`), so a wallet with two boarding addresses
// costs two Esplora requests per read.
//
// Three callers each did that read independently, on their own timers:
//   - the wallet summary (15s balance poll)
//   - the boarding ownership proof (20s unlock monitor)
//   - the unlock monitor's summary call, in the SAME pass as the proof
// So one monitor tick asked mempool.space for the same unchanged UTXO set twice
// within milliseconds, and the whole set of pollers produced ~30 requests a
// minute for data that changes when a Bitcoin block arrives. mempool.space
// rate-limits per IP, so the app generated the 429s that then broke the
// boarding read the Arkade claim depends on.
//
// A few seconds of sharing collapses the duplication without making the data
// meaningfully staler: confirmations arrive on block cadence, not per second.
// The sweep path passes `forceFresh` so the transaction it signs is always
// built from a live read — never from a cached snapshot.
import { logArkadeWalletSignTrace } from "./logging";

/** Shared window. Long enough to collapse one monitor pass, far below a block. */
export const BOARDING_UTXO_CACHE_TTL_MS = 8_000;

type BoardingUtxoReader<T> = { getBoardingUtxos: () => Promise<T[]> };

let cachedAtMs = 0;
let cachedRows: unknown[] | null = null;
let cacheOwnerKey: string | null = null;
let inFlight: Promise<unknown[]> | null = null;
// Scope of the in-flight read, tracked separately from `cacheOwnerKey`: that one
// is only set once a read SUCCEEDS, so keying the join on it meant two
// simultaneous cold-cache callers each issued their own request — the exact case
// this exists to collapse (the unlock monitor's summary and ownership proof fire
// together on the same tick, before anything is cached).
let inFlightOwnerKey: string | null = null;

/** Drop the cache — call whenever the wallet identity/instance changes. */
export function resetBoardingUtxoCache(reason = "reset"): void {
  cachedAtMs = 0;
  cachedRows = null;
  cacheOwnerKey = null;
  inFlight = null;
  inFlightOwnerKey = null;
  logArkadeWalletSignTrace("boarding_utxo_cache_reset", { reason });
}

/**
 * The wallet's boarding UTXOs, shared across callers for a few seconds.
 *
 * @param wallet    anything exposing `getBoardingUtxos()`
 * @param ownerKey  cache scope; a different value refuses the cached rows, so a
 *                  second wallet can never read the first one's UTXOs
 * @param options   `forceFresh` bypasses and refills the cache
 */
export async function readBoardingUtxosShared<T>(
  wallet: BoardingUtxoReader<T>,
  ownerKey: string,
  options?: { forceFresh?: boolean; reason?: string },
): Promise<T[]> {
  const now = Date.now();
  const scope = String(ownerKey || "").trim() || "unscoped";
  const fresh = options?.forceFresh === true;
  const sameOwner = cacheOwnerKey === scope;

  if (!fresh && sameOwner && cachedRows && now - cachedAtMs < BOARDING_UTXO_CACHE_TTL_MS) {
    logArkadeWalletSignTrace("boarding_utxo_cache_hit", {
      reason: options?.reason || "read",
      ageMs: now - cachedAtMs,
      rows: cachedRows.length,
    });
    return cachedRows as T[];
  }

  // Coalesce concurrent readers onto one request rather than firing N.
  if (!fresh && inFlight && inFlightOwnerKey === scope) {
    logArkadeWalletSignTrace("boarding_utxo_cache_join", {
      reason: options?.reason || "read",
    });
    return inFlight as Promise<T[]>;
  }

  const run = (async () => {
    const rows = await wallet.getBoardingUtxos();
    const list = Array.isArray(rows) ? rows : [];
    // Only a successful read replaces the cache. A failure must not install an
    // empty set — an empty boarding list is indistinguishable from "this wallet
    // owns nothing", which is what strands a sweep.
    cachedRows = list;
    cachedAtMs = Date.now();
    cacheOwnerKey = scope;
    return list as unknown[];
  })();

  inFlight = run;
  inFlightOwnerKey = scope;
  try {
    return (await run) as T[];
  } finally {
    if (inFlight === run) {
      inFlight = null;
      inFlightOwnerKey = null;
    }
  }
}
