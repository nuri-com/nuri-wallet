// This wallet's own Bitcoin destinations, in the shape the in-flight store
// needs: the arkade boarding address money lands on, and the on-chain address
// the MuSig2 wallet holds.
//
// Money arriving is only OUR money when it lands on one of these. Without them
// a send to someone else's address is indistinguishable from an internal move
// (both commit as BTC_LN -> BTC), and the board would draw "arriving" on a
// screen while the sats were leaving for good.
import { getBitcoinOnchainSendAddress, getBitcoinReceiveAddress } from "./BitcoinAddressService";

export async function ownBitcoinDestinations(known?: { arkade?: string }): Promise<{
  arkade: string | null;
  onchain: string | null;
}> {
  // A caller that already read the wallet's own receive address passes it in:
  // the read is a full wallet summary, and the address it returns is the same.
  const arkade = known?.arkade || (await getBitcoinReceiveAddress().catch(() => ""));
  let onchain = "";
  try {
    onchain = getBitcoinOnchainSendAddress();
  } catch {}
  return { arkade: arkade || null, onchain: onchain || null };
}
