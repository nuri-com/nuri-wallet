import type { UnifiedTransaction } from "../arkade/ArkadeTransactionHistoryService";
import type { AddressTx } from "../../types/bitcoin";

/**
 * The timestamps (unix seconds) the Bitcoin activity rows read a fiat price
 * at, for rows restored from the history cache. Mirrors the rows' own rule:
 * only settled rows carry a fiat line (a confirmed Arkade row at its
 * timestamp, a confirmed onchain row at its block time).
 */
export function cachedHistoryPriceStamps(
  arkade: readonly UnifiedTransaction[] | null | undefined,
  onchain: readonly AddressTx[] | null | undefined,
): number[] {
  const stamps = new Set<number>();
  for (const atx of Array.isArray(arkade) ? arkade : []) {
    if (atx?.status === "confirmed" && atx.timestamp) {
      stamps.add(Math.floor(atx.timestamp / 1000));
    }
  }
  for (const tx of Array.isArray(onchain) ? onchain : []) {
    const blockTime = tx?.status?.confirmed ? tx.status.block_time : undefined;
    if (blockTime) stamps.add(blockTime);
  }
  return Array.from(stamps);
}
