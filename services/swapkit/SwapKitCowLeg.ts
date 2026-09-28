// Whether a route's CoW leg exists at all.
//
// The leg sells the hub's USDC for the stable the route settles. On a
// USDC-settling route both sides are USDC — a leg the accepted route does not
// contain — so a request to sign one is not the route the user accepted. Shared
// so the in-session loop and the resumed tracker cannot answer differently
// depending on whether the app restarted.
import { BASE_USDC } from "../../config/network";

export function assertCowLegBelongsToRoute(buyTokenAddress: string): void {
  if (String(buyTokenAddress || "").toLowerCase() === BASE_USDC.address.toLowerCase()) {
    throw new Error("A USDC order has no USDC→EURC leg to sign.");
  }
}
