// The BTC_LN -> BTC corridor's published bounds.
//
// Execution itself lives in SwapKitV2ArkadeToBtcService (the v2 `swap`
// endpoint): there is exactly ONE Arkade -> Bitcoin implementation, and it
// binds its own amounts from the server's quote. These two figures exist only
// for what the SEND SCREEN must decide BEFORE any quote exists — whether the
// rail can be offered at all, and how much of the balance to reserve — so a UI
// that offers the corridor and a service that refuses it cannot disagree.

/**
 * bitcoinvn's own floor for the BTC_LN -> BTC pair, probed live at ~6,550 sats
 * (the corridor 400s below it).
 */
export const LIGHTNING_TO_BITCOIN_MIN_SATS = 6_550;

/**
 * What the provider's spread costs on top of the delivered amount, as a
 * multiplier. Probed live: 20,000 sats settled needs a 20,433 sat deposit, so
 * ~2.17%; rounded up to leave headroom for a move between screen and quote.
 *
 * Only for the send screen's affordability reservation BEFORE a quote exists.
 * The real figure always comes from the quote's own deposit side.
 */
export const LIGHTNING_TO_BITCOIN_SPREAD_MULTIPLIER = 1.025;
