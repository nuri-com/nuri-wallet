import { mainnet } from "viem/chains";

type FeeReader = {
  getFeeHistory(args: { blockCount: number; rewardPercentiles: number[] }): Promise<{
    reward?: bigint[][];
  }>;
  getBlock(): Promise<{ baseFeePerGas?: bigint | null }>;
  estimateMaxPriorityFeePerGas(): Promise<bigint>;
};

export type EthereumFees =
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | Record<string, never>;

/**
 * Ethereum RPCs answer eth_maxPriorityFeePerGas with 0 when the base fee is
 * low, and a zero-tip transaction waits in the mempool until a builder takes
 * it for free (a sweep approval and swap each sat ~1.5 min on 2026-10-09). On
 * Ethereum the tip is the median tip of the last 10 blocks, never below the
 * RPC suggestion; maxFee is 2x the current base fee plus that tip. Other
 * chains, or any failed read, keep viem's own estimate (empty object).
 */
export async function ethereumFees(client: FeeReader, chainId: number): Promise<EthereumFees> {
  if (chainId !== mainnet.id) return {};
  try {
    const [history, block] = await Promise.all([
      client.getFeeHistory({ blockCount: 10, rewardPercentiles: [50] }),
      client.getBlock(),
    ]);
    const tips = (history.reward ?? [])
      .map((row) => BigInt(row?.[0] ?? 0n))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let tip = tips.length ? tips[Math.floor(tips.length / 2)] : 0n;
    const suggested = await client.estimateMaxPriorityFeePerGas().catch(() => 0n);
    if (suggested > tip) tip = suggested;
    const baseFee = BigInt(block.baseFeePerGas ?? 0n);
    if (baseFee <= 0n) return {};
    return { maxFeePerGas: baseFee * 2n + tip, maxPriorityFeePerGas: tip };
  } catch {
    return {};
  }
}
