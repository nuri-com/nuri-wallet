import { ethers } from "ethers";
import { http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { BASE_RPC_URL, IS_MAINNET } from "../../config/network";

// ── Base, network-aware (APP_NETWORK: mainnet 8453 / testnet 84532) ────
// The single Base RPC/chain/transport the app uses. Alchemy serves both eth_*
// traffic and alchemy_getAssetTransfers (transfer-history scanning). Network
// selection is owned by config/network — nothing here hardcodes a chain/RPC.
export const BASE_VIEM_CHAIN = IS_MAINNET ? base : baseSepolia;

export function getBaseRpcUrl(): string {
  return BASE_RPC_URL;
}

export function getBaseViemTransport(config?: Parameters<typeof http>[1]) {
  return http(BASE_RPC_URL, config);
}

export function getBaseEthersProvider() {
  return new ethers.JsonRpcProvider(BASE_RPC_URL);
}
