/**
 * Multi-chain RPC configuration — primary + fallback URLs per chain, with timeout.
 */

import { ethers } from "ethers";
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

function makeProvider(url: string): ethers.JsonRpcProvider {
  const fetchReq = new ethers.FetchRequest(url);
  fetchReq.timeout = RPC_REQUEST_TIMEOUT_MS;
  return new ethers.JsonRpcProvider(fetchReq);
}

/**
 * Get an ethers provider for the given chain.
 * Tries the primary RPC first; if it fails, falls back to the secondary.
 * Throws if the chain has no configured RPC.
 *
 * Note: this returns a provider, not a tested connection. The fallback
 * logic is in `withFallback` for actual calls.
 */
export function getChainProvider(chainId: ChainId): ethers.JsonRpcProvider {
  const config = CHAIN_RPC[chainId];
  if (!config) throw new Error(`No RPC configured for chain ${chainId}`);
  return makeProvider(config.primary);
}

/**
 * Execute an async operation with RPC fallback.
 * Runs `fn` with the primary provider; if it throws, retries with the fallback.
 */
export async function withFallback<T>(
  chainId: ChainId,
  fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
): Promise<T> {
  const config = CHAIN_RPC[chainId];
  if (!config) throw new Error(`No RPC configured for chain ${chainId}`);

  try {
    return await fn(makeProvider(config.primary));
  } catch (primaryErr) {
    if (!config.fallback) throw primaryErr;
    return await fn(makeProvider(config.fallback));
  }
}
