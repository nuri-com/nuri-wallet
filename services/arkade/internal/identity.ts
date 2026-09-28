// Internal arkade identity facade. The cached identity lives inside the
// wallet bootstrap; this file exposes the public getters/awaiters used by
// receive flows (LNURL assertion) and the wallet summary.
import type { ArkadeRemoteIdentity } from "../ArkadeRemoteIdentity";
import type { ArkadeReceiveOwner } from "../ArkadeApiService";
import { getCachedArkadeIdentity, getOrCreateWallet } from "./walletCache";

export { getCachedArkadeIdentity } from "./walletCache";

export async function getOrCreateArkadeIdentity(): Promise<ArkadeRemoteIdentity> {
  const cached = getCachedArkadeIdentity();
  if (cached) {
    return cached;
  }
  await getOrCreateWallet();
  const after = getCachedArkadeIdentity();
  if (after) {
    return after;
  }
  throw new Error("arkade identity unavailable");
}

export async function getArkadeReceiveOwner(): Promise<ArkadeReceiveOwner> {
  return (await getOrCreateArkadeIdentity()).getReceiveOwner();
}

type ArkadeSignerAssertion = {
  token: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};

export async function getArkadeLnurlAssertion(
  reason: string,
  allowPrompt: boolean,
): Promise<ArkadeSignerAssertion | null> {
  const identity = await getOrCreateArkadeIdentity();
  if (allowPrompt) {
    return identity.getPrfSigningAssertion(false, reason);
  }
  return identity.getCachedPrfSigningAssertion(reason);
}
