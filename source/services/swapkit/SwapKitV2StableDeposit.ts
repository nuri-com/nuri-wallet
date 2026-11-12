// Which Euro/Dollar orders are funded by a plain transfer to the provider's
// deposit address, and the one sender that makes it. Shared by the live flow
// and the resume rebuild, so a restarted order gets the same funder.
import { sendTokenOnBase } from "../base/BaseTokenTransferService";
import { BTC_LIGHTNING_ASSET, baseStableToken } from "./SwapKitStableAssets";
import type { SwapKitV2StableDeposit } from "./SwapKitV2Executors";

/**
 * The deposit funding of an order, or undefined when it has none. Only a Base
 * stable paid out over Lightning by the provider (a Lightning address through
 * BitcoinVN) is funded this way; every other order keeps its routed calls.
 */
export function stableDepositFor(order: {
  from: string;
  to: string;
}): SwapKitV2StableDeposit | undefined {
  if (order.to !== BTC_LIGHTNING_ASSET) return undefined;
  if (order.from !== "EURC_BASE" && order.from !== "USDC_BASE") return undefined;
  const token = baseStableToken(order.from);
  return {
    asset: token.asset,
    send: async (to, amount, onBeforeBroadcast) =>
      (
        await sendTokenOnBase({
          toAddress: to,
          amount,
          tokenAddress: token.token,
          tokenDecimals: token.decimals,
          awaitReceipt: false,
          onBeforeBroadcast,
        })
      ).hash,
  };
}
