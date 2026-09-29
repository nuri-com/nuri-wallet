// Which home screen a swap asset id belongs to.
//
// The v2 engine speaks in assets (BTC, BTC_ARKADE, BTC_LN, EURC_BASE,
// USDC_BASE); the board speaks in screens. This is the ONLY place that
// translates, so a producer never has to decide which rail its money touches
// and no reader has to infer one from a currency.
import type { MoneyRail } from "./MoneyInFlightStore";

/** The rail an asset id names on its own, ignoring where it settles. */
export function assetRail(asset: string): MoneyRail | null {
  const id = String(asset || "").toUpperCase();
  if (id === "BTC") return "onchain";
  if (id === "BTC_ARKADE" || id === "BTC_LN") return "arkade";
  if (id === "EURC_BASE" || id === "EURE_GNOSIS") return "wallet";
  if (id === "USDC_BASE") return "dollar";
  return null;
}

/** This wallet's own destinations, used to tell an internal move from a send. */
export type OwnDestinations = {
  /** Arkade receive/boarding address. */
  arkade?: string | null;
  /** On-chain receive address. */
  onchain?: string | null;
  /** The EOA that holds the stablecoin balances. */
  evm?: string | null;
  /** The Wirex card account address. */
  card?: string | null;
};

const same = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The rail a move's DESTINATION lands on, or null when the money leaves the app.
 *
 * Both bitcoin rails settle as `to: BTC`, and both stablecoins settle to an
 * address that may be the user's wallet OR their card, so the asset alone
 * cannot answer this — the settle target is what separates the cases. A target
 * belonging to nobody we know is a send OUT: it gets no destination row,
 * because claiming one would state money arriving that is leaving.
 */
export function destinationRail(
  to: string,
  settleTarget: string | null | undefined,
  own: OwnDestinations,
  cardPocket?: "EUR" | "USD" | null,
): MoneyRail | null {
  const id = String(to || "").toUpperCase();
  // An explicit arkade asset is always this wallet's own arkade balance.
  if (id === "BTC_ARKADE" || id === "BTC_LN") return "arkade";
  if (id === "BTC") {
    if (same(settleTarget, own.arkade)) return "arkade";
    if (same(settleTarget, own.onchain)) return "onchain";
    return null;
  }
  const stable = assetRail(id);
  if (stable !== "wallet" && stable !== "dollar") return null;
  // A stable settling to the card account credits the pocket of its currency,
  // not the wallet of the same currency — they are different screens.
  if (same(settleTarget, own.card)) {
    if (cardPocket === "USD") return "visaUsd";
    if (cardPocket === "EUR") return "visa";
    return stable === "dollar" ? "visaUsd" : "visa";
  }
  if (same(settleTarget, own.evm)) return stable;
  // No settle target to judge by (the app's own wallet is the default
  // destination for a wallet-settled swap) — the asset's own rail stands.
  return settleTarget ? null : stable;
}
