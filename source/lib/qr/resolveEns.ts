/**
 * ENS name → address. ENS lives on Ethereum mainnet only; the resolved address
 * is then usable on any EVM chain, so the chain never comes from the lookup —
 * it comes from the caller: a prefix (`gno:vitalik.eth`) picks the swap chain,
 * a bare name has no chain and is sent on Base like a bare `0x…`.
 */

import { normalize } from "viem/ens";
import { ENS_UNIVERSAL_RESOLVER, withFallback } from "../rpc/chainRpc";

// viem resolves ENS through the mainnet Universal Resolver (resolver lookup,
// wildcard and offchain CCIP-Read included).
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
  return await withFallback(1, (client) =>
    client.getEnsAddress({
      name: normalize(value),
      universalResolverAddress: ENS_UNIVERSAL_RESOLVER,
    }),
  );
}
