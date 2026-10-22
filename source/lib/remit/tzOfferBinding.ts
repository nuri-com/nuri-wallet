// lib/remit/tzOfferBinding.ts
// A Tanzanian payout order states one offer per stable (an EURC amount and
// address, a USDC amount and address). The offer the user was shown belongs to
// the stable it was priced for: once another balance pays, it is no offer at
// all, never the old figure under the new token's name.
import type { TzStablePayment } from "../../services/remit/RemitService";

export type BoundTzOffer = { stable: "EURC" | "USDC"; offer: TzStablePayment };

/** The offer to show and pay for `stable`, or null when it was priced for another. */
export function tzOfferFor(
  bound: BoundTzOffer | null,
  stable: "EURC" | "USDC",
): TzStablePayment | null {
  return bound && bound.stable === stable ? bound.offer : null;
}
