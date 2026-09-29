import { getErc20Balance } from "../balance/MultiCurrencyBalanceService";
import { getBaseMainnetErc20Balance } from "../base/BaseTokenTransferService";
import { BASE_MAINNET_CHAIN_ID } from "./SwapKitService";
import type { SwapKitStableToken } from "./SwapKitStableAssets";

// What is left of the v1 direct EVM swap service: the settle event the v2
// tracker emits and the home screen listens to, and the live balance read the
// v2 stable↔stable service uses. Every swap runs on SwapKit v2.

/**
 * A direct EVM swap reached a terminal state: `{ txId, destination, ok }`.
 * Listeners are the balances a swap can settle ON — they hold optimistic
 * figures that only this outcome can confirm or take back.
 */
export const DIRECT_SWAP_SETTLED_EVENT = "swap:directSettled";

export type DirectSwapSettled = {
  txId: string;
  destination?: "card";
  /** Terminal COMPLETED. False is a terminal failure, never "not yet". */
  ok: boolean;
};

/**
 * The live balance of one side of the pair. Base keeps its dedicated transport
 * (Alchemy, which the Base service needs elsewhere); every other chain reads
 * through the shared per-chain RPC with the same failover.
 */
export async function readDirectSwapBalance(
  source: SwapKitStableToken,
  address: string,
): Promise<number> {
  if (source.chainId === BASE_MAINNET_CHAIN_ID) {
    const units = await getBaseMainnetErc20Balance(source.token, address as `0x${string}`);
    return Number(units) / 10 ** source.decimals;
  }
  return getErc20Balance(source.chainId, source.token, address, source.decimals);
}
