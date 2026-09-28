// The boarding floor the ACTIVE node declares, read off its info rather than
// stated here.
//
// Arkade applies it per boarding UTXO, not to their combined value. It is the
// node's `utxoMinAmount`, which mainnet lowered from 3,000 to 330 — a figure
// hardcoded in the app refused deposits the node accepts, while the server keeps
// marking a confirmed boarding UTXO `sweep_ready` with no value test at all.
//
// Its own module, and a cache rather than a parameter, because the selection it
// guards is synchronous while the node info arrives asynchronously — and because
// Nuri can be pointed at a custom node (`setCustomArkadeNodeUrl`), whose floor
// may differ: pinning 330 would mark 330-2,999 sat rows actionable on a node
// that still demands 3,000 and have the node reject them mid-sweep.

type NodeAmountFields = {
  /** Floor for an on-chain output — what a boarding UTXO is. */
  utxoMinAmount?: number | string | bigint;
};

/** Last resort only, for when no node info has been read yet. */
export const ARKADE_BOARDING_CLAIM_FALLBACK_MIN_SATS = 330;

let liveMinSats: number | null = null;

function toSats(value: unknown): number {
  const sats = Number(value);
  return Number.isFinite(sats) && sats > 0 ? Math.trunc(sats) : Number.NaN;
}

/**
 * Record the active node's floor. Junk and empty info leave the previous value
 * alone: an unknown floor must not silently become the fallback, which would
 * re-admit amounts a stricter node refuses.
 */
export function primeArkadeBoardingMinimumSats(
  info: NodeAmountFields | number | null | undefined,
): number {
  const raw = typeof info === "object" && info !== null ? info.utxoMinAmount : info;
  const sats = toSats(raw);
  if (Number.isFinite(sats)) liveMinSats = sats;
  return getArkadeBoardingMinimumSats();
}

/** Forget the cached floor, so the next read comes from the node in use. */
export function resetArkadeBoardingMinimumSats(): void {
  liveMinSats = null;
}

export function getArkadeBoardingMinimumSats(): number {
  return liveMinSats ?? ARKADE_BOARDING_CLAIM_FALLBACK_MIN_SATS;
}

export function isArkadeBoardingClaimable(
  value: unknown,
  minSats: number = getArkadeBoardingMinimumSats(),
): boolean {
  const sats = Number(value);
  return Number.isFinite(sats) && sats >= minSats;
}
