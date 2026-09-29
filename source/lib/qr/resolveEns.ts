/**
 * ENS name → address. ENS lives on Ethereum mainnet only; the resolved address
 * is then usable on any EVM chain, so the chain never comes from the lookup —
 * it comes from the caller: a prefix (`gno:vitalik.eth`) picks the swap chain,
 * a bare name has no chain and is sent on Base like a bare `0x…`.
 */

import { withFallback } from "../rpc/chainRpc";

// ponytail: ethers resolves ENS natively (registry + resolver + wildcard).
// Nothing to hand-roll, no new dependency, no ABI.
const ENS_NAME = /^[a-z0-9-]([a-z0-9-.]*[a-z0-9-])?\.eth$/i;

export const isEnsName = (value: string): boolean => ENS_NAME.test(value.trim());

/**
 * Resolves `name.eth` to a checksummed 0x address, or null when the name has
 * no address record. Throws only if every RPC is unreachable — callers must
 * distinguish "no such name" (null) from "we could not check" (throw), because
 * silently treating an outage as a bad name loses a valid payment.
 */
export async function resolveEnsName(name: string): Promise<string | null> {
  const value = name.trim();
  if (!isEnsName(value)) return null;
  return await withFallback(1, (provider) => provider.resolveName(value));
}
