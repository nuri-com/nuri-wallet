// Reads a card's withdrawals from the chain (see lib/wirex/cardWithdrawals).
import { createPublicClient } from "viem";
import { BASE_EURC, BASE_USDC } from "../../config/network";
import {
  type CardBurn,
  type CardWithdrawal,
  cardBurns,
  paidOwnCash,
} from "../../lib/wirex/cardWithdrawals";
import { BASE_VIEM_CHAIN, getBaseViemTransport } from "../../lib/rpc/baseRpc";
import { fetchAssetTransfers } from "../balance/transactions/alchemyTransfers";

/** Every burn of card money by this card account. */
export async function fetchCardBurns(card: string): Promise<CardBurn[]> {
  const transfers = await fetchAssetTransfers({ direction: "from", address: card });
  return cardBurns(transfers, card);
}

// A mined transaction never changes: what it paid and when is read once.
const settled = new Map<string, { toOwnCash: boolean; createdAt: string }>();

/** The card's withdrawals that paid one of `own` (the user's Cash addresses). */
export async function fetchCardWithdrawalsToCash(
  card: string,
  own: readonly string[],
): Promise<CardWithdrawal[]> {
  const burns = await fetchCardBurns(card);
  const client = createPublicClient({
    chain: BASE_VIEM_CHAIN,
    transport: getBaseViemTransport({ batch: true }),
  });
  const ownKey = own
    .map((a) => a.toLowerCase())
    .sort()
    .join("|");
  const read = await Promise.all(
    burns.map(async (burn) => {
      const cacheKey = `${burn.txHash}:${ownKey}`;
      let known = settled.get(cacheKey);
      if (!known) {
        const [receipt, block] = await Promise.all([
          client.getTransactionReceipt({ hash: burn.txHash as `0x${string}` }),
          client.getBlock({ blockNumber: burn.blockNumber }),
        ]);
        known = {
          toOwnCash: paidOwnCash(receipt.logs, own, [BASE_EURC.address, BASE_USDC.address]),
          createdAt: new Date(Number(block.timestamp) * 1000).toISOString(),
        };
        settled.set(cacheKey, known);
      }
      return known.toOwnCash ? { ...burn, createdAt: known.createdAt } : null;
    }),
  );
  return read.filter((w): w is CardWithdrawal => w !== null);
}
