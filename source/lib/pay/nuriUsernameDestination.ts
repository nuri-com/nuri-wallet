/**
 * The address a Nuri username is paid at from the Bitcoin send sheet.
 *
 * The sheet opened from the on-chain row pays from the on-chain (MuSig2)
 * wallet, which can only build a spend to a Bitcoin address: it takes the
 * user's co-signed on-chain address. Everywhere else it pays from Arkade and
 * takes their Arkade address. Their `@nuri.com` Lightning address cannot
 * receive yet, so it is never picked. Null when the user lists no address for
 * that rail.
 */
import { isArkAddress, isValidBitcoinAddressMainnet } from "../bitcoin/address";
import type { PayRecipient } from "./resolvePayRecipient";

export function nuriUsernameDestination(
  recipient: Pick<PayRecipient, "arkadeAddress" | "onchainAddress"> | null,
  sendSource: "arkade" | "onchain",
): string | null {
  if (!recipient) return null;
  if (sendSource === "onchain") {
    const address = recipient.onchainAddress;
    return address && isValidBitcoinAddressMainnet(address) ? address : null;
  }
  const address = recipient.arkadeAddress;
  return address && isArkAddress(address) ? address : null;
}
