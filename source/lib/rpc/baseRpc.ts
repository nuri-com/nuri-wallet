import { http, type Transport } from "viem";
import { base, baseSepolia } from "viem/chains";
import { BASE_CHAIN_ID, BASE_RPC_URL, IS_MAINNET } from "../../config/network";
import { getChainFallbackRpcUrl, type StickyFallbackOptions, stickyFallback } from "./chainRpc";

// ── Base, network-aware (APP_NETWORK: mainnet 8453 / testnet 84532) ────
// The single Base RPC/chain/transport the app uses. Alchemy is the primary and
// also serves alchemy_getAssetTransfers (transfer-history scanning, fetched
// directly from getBaseRpcUrl()). Network selection is owned by config/network
// — nothing here hardcodes a chain/RPC.
export const BASE_VIEM_CHAIN = IS_MAINNET ? base : baseSepolia;

/** Retries on Alchemy before failing over: viem's own http() default. */
const PRIMARY_RETRY_COUNT = 3;

export function getBaseRpcUrl(): string {
  return BASE_RPC_URL;
}

/**
 * Alchemy first, then the public Base node. A dead or throttled Alchemy key
 * degrades Base sends, card top-up, sweeps and SwapKit legs instead of
 * stopping them. The primary sets its own retry budget, so a brief Alchemy
 * 429/5xx is retried on Alchemy before the public node is tried. Once a client
 * has failed over it stays on the public node, so a send's nonce read and
 * broadcast never split across providers (stickyFallback). Signing operations
 * pass `singleProvider` and share one transport between their public and
 * wallet clients, so a primary that answered and then dies mid-operation
 * fails the operation instead of broadcasting via the public node. Reverts and
 * user rejections never fail over.
 */
export function getBaseViemTransport(
  config?: Parameters<typeof http>[1],
  options?: StickyFallbackOptions,
): Transport {
  const primary = http(BASE_RPC_URL, { retryCount: PRIMARY_RETRY_COUNT, ...config });
  const publicUrl = getChainFallbackRpcUrl(BASE_CHAIN_ID);
  if (!publicUrl) return primary;
  return stickyFallback(primary, http(publicUrl, config), options);
}
