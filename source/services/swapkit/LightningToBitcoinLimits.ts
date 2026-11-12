// The BTC_LN -> BTC corridor's published bounds.
//
// Execution itself lives in SwapKitV2ArkadeToBtcService (the v2 `swap`
// endpoint): there is exactly ONE Arkade -> Bitcoin implementation, and it
// binds its own amounts from the server's quote. These two figures exist only
// for what the SEND SCREEN must decide BEFORE any quote exists — whether the
// rail can be offered at all, and how much of the balance to reserve — so a UI
// that offers the corridor and a service that refuses it cannot disagree.

/**
 * Fallback for the corridor floor, used only until the server has answered
 * once. The live floor moves: bitcoinvn states a fixed fiat order size, so the
 * figure in sats follows the BTC price (6,550 when probed, 7,001 later), and a
 * hardcoded one offers amounts no route takes.
 */
export const LIGHTNING_TO_BITCOIN_MIN_SATS = 6_550;

let liveMinSats: number | null = null;
const listeners = new Set<() => void>();

/** The corridor floor: the server's last answer, or the fallback before any. */
export function getLightningToBitcoinMinSats(): number {
  return liveMinSats ?? LIGHTNING_TO_BITCOIN_MIN_SATS;
}

/** Keep the server's floor. A missing or malformed answer keeps the last good
 * one: an unreadable floor never falls back to a figure the route refuses. */
export function primeLightningToBitcoinMinSats(min: number | null | undefined): void {
  if (typeof min !== "number" || !Number.isSafeInteger(min) || min <= 0) return;
  if (min === liveMinSats) return;
  liveMinSats = min;
  for (const listener of listeners) listener();
}

export function subscribeLightningToBitcoinMinSats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only. */
export function resetLightningToBitcoinMinSatsForTest(): void {
  liveMinSats = null;
  listeners.clear();
}

/**
 * What the provider's spread costs on top of the delivered amount, as a
 * multiplier. Probed live: 20,000 sats settled needs a 20,433 sat deposit, so
 * ~2.17%; rounded up to leave headroom for a move between screen and quote.
 *
 * Only for the send screen's affordability reservation BEFORE a quote exists.
 * The real figure always comes from the quote's own deposit side.
 */
export const LIGHTNING_TO_BITCOIN_SPREAD_MULTIPLIER = 1.025;
