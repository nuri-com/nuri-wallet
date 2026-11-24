import { maxFundAmountSats } from "../../services/swapkit/SwapKitArkadeIntentsCreate";
import { LIGHTNING_TO_BITCOIN_SPREAD_MULTIPLIER } from "../../services/swapkit/LightningToBitcoinLimits";

export type SendSpendRoute = {
  /** A bank swap: spends exactly the accepted option's sats. */
  swapPayout: boolean;
  /** A Lightning invoice, LNURL or mobile-money payout: funds an Arkade lockup. */
  lightning: boolean;
  /** An Arkade balance paying a Bitcoin address, over the Lightning corridor. */
  arkadeToBitcoinAddress: boolean;
  /** The corridor floor; below it the corridor is not offered. */
  corridorMinSats: number;
};

/**
 * What leaves the wallet for an entered amount on the send screen.
 *
 * A Lightning target funds a lockup carrying the amount PLUS the lockup fee; a
 * Bitcoin address paid from Arkade over the corridor adds the provider's spread
 * first. The spread is not known until it quotes, so the observed ~2.2% band is
 * reserved: over-reserving refuses a send the corridor might have taken,
 * under-reserving accepts one it cannot. An on-chain send to an address is a
 * plain transaction whose miner fee is reserved in the balance, so it spends
 * what was entered; reserving the spread there too refused amounts it pays.
 */
export function sendSpendSats(sats: number, route: SendSpendRoute): number {
  if (route.swapPayout) return sats;
  if (route.lightning) return maxFundAmountSats(sats);
  if (route.arkadeToBitcoinAddress && sats >= route.corridorMinSats) {
    return maxFundAmountSats(Math.ceil(sats * LIGHTNING_TO_BITCOIN_SPREAD_MULTIPLIER));
  }
  return sats;
}
