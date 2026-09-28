// Which Bitcoin rail a v2 move's leg belongs to.
//
// A move can have Bitcoin on BOTH sides (arkade/Lightning -> on-chain, on-chain
// -> arkade). The board's pending rows used to ask once whether the move as a
// whole spends or receives Bitcoin; with Bitcoin on both sides that answered
// "neither" and the move drew no row at all, so an arkade -> BTC transfer
// showed nothing on the arkade balance screen while the sats were in flight.
// Each rail asks about its OWN leg here instead.
export type BtcRail = "arkade" | "onchain";

/** The rail an asset id names, or null when the asset is not Bitcoin. On-chain
 * BTC is the onchain rail; arkade and Lightning are both the arkade wallet. */
export const btcAssetRail = (asset: string): BtcRail | null => {
  const id = String(asset || "").toUpperCase();
  if (id === "BTC") return "onchain";
  if (id === "BTC_ARKADE" || id === "BTC_LN") return "arkade";
  return null;
};

/** This wallet's own Bitcoin destinations, used to tell an internal move from a
 * send to someone else. */
export type OwnBtcAddresses = {
  /** The arkade receive/boarding address. */
  arkade?: string | null;
  /** The on-chain receive address. */
  onchain?: string | null;
};

const same = (a?: string | null, b?: string | null): boolean => !!a && !!b && a.trim() === b.trim();

/**
 * The leg `rail` draws for this move: "out" when it pays, "in" when it
 * receives, null when the move does not touch it.
 *
 * An INCOMING Bitcoin leg is only ours when the money actually lands in this
 * wallet. Both Bitcoin rails commit as `to: BTC`, so the settle target is what
 * separates the cases:
 *   - it is the arkade boarding address -> the arkade rail (the sats board in);
 *   - it is the on-chain receive address -> the on-chain rail;
 *   - it is anyone else's address -> a send OUT, so no rail credits anything.
 * `to: BTC_ARKADE` is always this wallet's own arkade balance.
 */
export function btcMoveRailLeg(
  move: { from: string; to: string; settleTarget?: string | null },
  rail: BtcRail,
  own?: OwnBtcAddresses | string | null,
): "out" | "in" | null {
  const ownAddresses: OwnBtcAddresses =
    own == null ? {} : typeof own === "string" ? { arkade: own } : own;
  const fromRail = btcAssetRail(move.from);
  // The paying rail never depends on the recipient: this wallet spent it.
  if (fromRail === rail) return "out";

  const toAsset = String(move.to || "").toUpperCase();
  if (toAsset === "BTC_ARKADE" || toAsset === "BTC_LN") {
    return rail === "arkade" ? "in" : null;
  }
  if (toAsset !== "BTC") return null;
  // Plain BTC: credit only the rail whose own address receives it. A send to an
  // external address credits nothing — claiming an incoming row there would
  // state money arriving that is leaving.
  if (same(move.settleTarget, ownAddresses.arkade)) return rail === "arkade" ? "in" : null;
  if (same(move.settleTarget, ownAddresses.onchain)) return rail === "onchain" ? "in" : null;
  return null;
}
