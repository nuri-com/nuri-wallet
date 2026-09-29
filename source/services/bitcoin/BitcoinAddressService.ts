// Single entry point for "what Bitcoin address should the user receive at".
//
// Delegates to the arkade BtcL2Provider. Returns "" when the boarding address
// cannot be established — callers must abort on that rather than pay anywhere
// else.

// The RECEIVE (boarding) address is deliberately NOT the address the on-chain wallet spends from: it
// is handed out for new deposits and boarded into Arkade, so it normally holds no coins at all. Any
// route that treats the declared Bitcoin address as the FUNDING side — LI.FI's BTC-source rail builds
// the deposit from the sender's UTXOs and refuses an address with none — must declare the MuSig2 send
// source instead, which is also where a refund can be spent without a boarding step.

import { isSendSourceBoundToCredential } from "../../lib/bitcoin/sendSourceBinding";
import { currentWalletCredId } from "../auth/walletCredential";
import { getBtcL2Provider } from "./providers/registry";
import { walletService } from "./WalletService";

export async function getBitcoinReceiveAddress(): Promise<string> {
  return getBtcL2Provider().getReceiveAddress();
}

/**
 * The address the on-chain (MuSig2+CSV) wallet spends from — the same source
 * `sendBitcoinOnchainFromMusig2` funds with. Returns "" when the wallet is not loaded, which callers
 * must treat as "cannot send", never as "pay anywhere else".
 */
export function getBitcoinOnchainSendAddress(): string {
  // The descriptor outlives the identity it was derived for, so an unbound or foreign-credential one
  // must never reach a route: "" makes the caller refuse the move instead of binding it to the
  // previous account's address.
  if (
    !isSendSourceBoundToCredential(walletService.getMusig2DescriptorCredId(), currentWalletCredId())
  ) {
    return "";
  }
  return walletService.getMusig2SendSource()?.address ?? "";
}
