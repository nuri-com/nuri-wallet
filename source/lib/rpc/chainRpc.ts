/**
 * Multi-chain RPC configuration — primary + fallback URLs per chain, with timeout.
 */

import {
  createPublicClient,
  createTransport,
  type EIP1193RequestFn,
  http,
  shouldThrow,
  type Transport,
} from "viem";
import { mainnet } from "viem/chains";
import { RPC_REQUEST_TIMEOUT_MS } from "../../config/constants";
import { ALCHEMY_API_KEY } from "../../config/network";
import type { ChainId } from "../tokens";

interface RpcConfig {
  primary: string;
  fallback?: string;
}

// Alchemy's per-network subdomain. The paid key is the PRIMARY on every chain;
// the public endpoint stays as the fallback `withFallback` fails over to, so an
// Alchemy outage degrades instead of stopping a swap.
const alchemy = (subdomain: string) => `https://${subdomain}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

/** ENS lives on mainnet; its lookups go through this contract on chain 1. */
export const ENS_UNIVERSAL_RESOLVER = mainnet.contracts.ensUniversalResolver.address;

const CHAIN_RPC: Partial<Record<ChainId, RpcConfig>> = {
  1: {
    primary: alchemy("eth-mainnet"),
    fallback: "https://ethereum-rpc.publicnode.com",
  },
  10: {
    primary: alchemy("opt-mainnet"),
    fallback: "https://optimism-rpc.publicnode.com",
  },
  100: {
    primary: alchemy("gnosis-mainnet"),
    fallback: "https://gnosis-rpc.publicnode.com",
  },
  137: {
    primary: alchemy("polygon-mainnet"),
    fallback: "https://polygon-bor-rpc.publicnode.com",
  },
  42161: {
    primary: alchemy("arb-mainnet"),
    fallback: "https://arbitrum-one-rpc.publicnode.com",
  },
  8453: {
    primary: alchemy("base-mainnet"),
    fallback: "https://base-rpc.publicnode.com",
  },
  84532: {
    primary: alchemy("base-sepolia"),
    fallback: "https://base-sepolia.publicnode.com",
  },
};

export function getChainRpcUrl(chainId: ChainId): string | undefined {
  return CHAIN_RPC[chainId]?.primary;
}

export function getChainFallbackRpcUrl(chainId: ChainId): string | undefined {
  return CHAIN_RPC[chainId]?.fallback;
}

export interface StickyFallbackOptions {
  /**
   * One state-dependent operation (nonce/gas/simulation reads, then a
   * broadcast): the first provider that ANSWERS owns the whole operation. Once
   * the primary has answered, a later primary failure is thrown instead of
   * failing over, so a transaction prepared from the primary's pending state is
   * never broadcast through the secondary. The caller's retry starts a fresh
   * operation (new transport), which can then begin on the secondary.
   */
  singleProvider?: boolean;
}

/**
 * Primary first, then the secondary, and once it has failed over it STAYS on
 * the secondary. viem's fallback() restarts at the primary on every JSON-RPC
 * request, so one sendTransaction could read the nonce from one provider and
 * broadcast to the other (different pending nonces and mempools). With
 * `singleProvider` the choice is shared by every client built from the
 * returned transport and locked once the primary answers (see
 * StickyFallbackOptions); build one such transport per operation. Reverts and
 * user rejections never fail over (viem's shouldThrow).
 */
export function stickyFallback(
  primary: Transport,
  secondary: Transport,
  { singleProvider = false }: StickyFallbackOptions = {},
): Transport {
  // singleProvider: the choice lives on the transport VALUE, so the public and
  // wallet clients of one operation (built from the same transport) share it.
  // Default: per client instance, so a long-lived transport (wagmi) gives each
  // new client a fresh try at the primary.
  const shared = { current: "primary" as "primary" | "secondary", primaryAnswered: false };
  return ({ chain, timeout, ...rest }) => {
    const state = singleProvider
      ? shared
      : { current: "primary" as "primary" | "secondary", primaryAnswered: false };
    const first = primary({ ...rest, chain, timeout, retryCount: 0 });
    const second = secondary({ ...rest, chain, timeout, retryCount: 0 });
    const request = async ({ method, params }: { method: string; params?: unknown }) => {
      const args = { method, params } as Parameters<typeof first.request>[0];
      if (state.current === "primary") {
        try {
          const result = await first.request(args);
          state.primaryAnswered = true;
          return result;
        } catch (err) {
          if (shouldThrow(err as Error)) throw err;
          if (singleProvider && state.primaryAnswered) throw err;
          state.current = "secondary";
        }
      }
      return second.request(args);
    };
    return createTransport({
      key: "fallback",
      name: "Sticky Fallback",
      type: "fallback",
      retryCount: 0,
      request: request as EIP1193RequestFn,
    });
  };
}

/**
 * Primary-then-public transport for wallet/public clients that cannot use
 * withFallback (they hold one transport across several calls). The primary
 * keeps its own retry budget, so a brief 429/5xx is retried there; the public
 * node is used only once the primary has thrown (see stickyFallback). Pass
 * `singleProvider` for a signing operation and share the one transport between
 * its public and wallet clients.
 */
export function getChainTransport(
  chainId: ChainId,
  config?: Parameters<typeof http>[1],
  options?: StickyFallbackOptions,
): Transport {
  const rpc = CHAIN_RPC[chainId];
  const primary = http(rpc?.primary, { retryCount: 3, ...config });
  if (!rpc?.fallback) return primary;
  return stickyFallback(primary, http(rpc.fallback, config), options);
}

// One attempt per URL: a failure moves to the fallback URL instead of retrying
// the same endpoint, so an outage costs one timeout, not several.
function makeClient(url: string) {
  return createPublicClient({
    transport: http(url, { timeout: RPC_REQUEST_TIMEOUT_MS, retryCount: 0 }),
  });
}

/** A read-only client for one chain's RPC. */
export type RpcClient = ReturnType<typeof makeClient>;

/**
 * Execute an async operation with RPC fallback.
 * Runs `fn` with the primary client; if it throws, retries with the fallback.
 */
export async function withFallback<T>(
  chainId: ChainId,
  fn: (client: RpcClient) => Promise<T>,
): Promise<T> {
  const config = CHAIN_RPC[chainId];
  if (!config) throw new Error(`No RPC configured for chain ${chainId}`);

  try {
    return await fn(makeClient(config.primary));
  } catch (primaryErr) {
    if (!config.fallback) throw primaryErr;
    return await fn(makeClient(config.fallback));
  }
}
