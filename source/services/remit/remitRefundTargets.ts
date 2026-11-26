/**
 * The user's own refund targets for a Remit payout order (nuri-expo #2058):
 * their `<name>@nuri.com` Lightning address and their Base wallet address.
 * Read from local account state only; anything missing is left out and the
 * service falls back to the verified payer.
 */

import { nuriLightningAddress } from "../../lib/pay/nuriUsername";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { authStateManager } from "../auth/AuthStateService";
import type { RemitRefundTargets } from "./RemitService";

export async function ownRemitRefundTargets(): Promise<RemitRefundTargets> {
  const username = authStateManager.getState().walletUsername?.trim() || "";
  const baseAddress = await getEthereumAddress().catch((): null => null);
  return {
    lightningAddress: username ? nuriLightningAddress(username) : null,
    baseAddress,
  };
}
