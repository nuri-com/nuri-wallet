/**
 * Multi-currency balance service — reads the onchain ERC20 EURC balance the
 * wallet holds on Base.
 */

import { decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits } from "viem";
import { type RpcClient, withFallback } from "../../lib/rpc/chainRpc";
import { BASE_EURC } from "../../config/network";
import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";

/**
 * Read a single ERC20 balanceOf. THROWS on RPC/call failure — callers must
 * decide how to degrade (withFallback failover, or a cached-balance fallback).
 * Swallowing to 0 here would make `withFallback` treat a failed RPC as a real
 * zero and wipe the displayed balance instead of failing over.
 */
async function readBalance(
  client: RpcClient,
  tokenAddress: `0x${string}`,
  walletAddress: string,
  decimals: number,
): Promise<number> {
  const raw = await balanceOf(client, tokenAddress, walletAddress);
  const bal = Number(formatUnits(raw, decimals));
  return Number.isFinite(bal) ? bal : 0;
}

async function balanceOf(
  client: RpcClient,
  tokenAddress: `0x${string}`,
  walletAddress: string,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress as `0x${string}`],
  });
  const { data: out } = await client.call({ to: tokenAddress, data });
  if (!out) throw new Error(`balanceOf returned no data from ${tokenAddress}`);
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: out });
}

/**
 * The same read in raw token units. A ceiling computed from a JS number loses
 * precision on an 18-decimal token, and this value bounds what a router may
 * spend — so the bigint never becomes a float on the way there.
 */
export async function getErc20BalanceUnits(
  chainId: number,
  tokenAddress: `0x${string}`,
  walletAddress: string,
): Promise<bigint> {
  return withFallback(chainId as Parameters<typeof withFallback>[0], (client) =>
    balanceOf(client, tokenAddress, walletAddress),
  );
}

/**
 * The same read on any chain lib/rpc/chainRpc is configured for, with the same
 * primary→fallback failover. For callers that hold a token whose chain is data
 * rather than a constant — a recovery swap picking up funds wherever a route
 * left them.
 */
export async function getErc20Balance(
  chainId: number,
  tokenAddress: `0x${string}`,
  walletAddress: string,
  decimals: number,
): Promise<number> {
  return withFallback(chainId as Parameters<typeof withFallback>[0], (client) =>
    readBalance(client, tokenAddress, walletAddress, decimals),
  );
}

export async function getBaseWalletEurcBalance(address: string): Promise<number> {
  const op = newOp("MultiCurrencyBalanceService", "getBaseWalletEurcBalance", LOG_EMOJI.wallet);
  op.log(`chain=${BASE_EURC.chainId} token=EURC`);
  try {
    const balance = await withFallback(BASE_EURC.chainId, (client) =>
      readBalance(client, BASE_EURC.address, address, BASE_EURC.decimals),
    );
    op.end("OK");
    return balance;
  } catch (e) {
    // Total RPC failure (all fallbacks exhausted): THROW rather than report €0,
    // so the caller keeps the cached balance instead of blanking the wallet.
    op.error("Base wallet EURC balance failed", (e as Error)?.message);
    op.end("ERR");
    throw e instanceof Error ? e : new Error("base_mainnet_eurc_balance_failed");
  }
}
