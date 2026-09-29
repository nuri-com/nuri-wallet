/**
 * Multi-currency balance service — reads the onchain ERC20 EURC balance the
 * wallet holds on Base.
 */

import { ethers } from "ethers";
import { withFallback } from "../../lib/rpc/chainRpc";
import { BASE_EURC } from "../../config/network";
import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

/**
 * Read a single ERC20 balanceOf. THROWS on RPC/call failure — callers must
 * decide how to degrade (withFallback failover, or a cached-balance fallback).
 * Swallowing to 0 here would make `withFallback` treat a failed RPC as a real
 * zero and wipe the displayed balance instead of failing over.
 */
async function readBalance(
  provider: ethers.JsonRpcProvider,
  tokenAddress: `0x${string}`,
  walletAddress: string,
  decimals: number,
): Promise<number> {
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const raw: bigint = await contract.balanceOf(walletAddress);
  const bal = Number(ethers.formatUnits(raw, decimals));
  return Number.isFinite(bal) ? bal : 0;
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
  return withFallback(chainId as Parameters<typeof withFallback>[0], async (provider) => {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return (await contract.balanceOf(walletAddress)) as bigint;
  });
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
  return withFallback(chainId as Parameters<typeof withFallback>[0], (provider) =>
    readBalance(provider, tokenAddress, walletAddress, decimals),
  );
}

export async function getBaseWalletEurcBalance(address: string): Promise<number> {
  const op = newOp("MultiCurrencyBalanceService", "getBaseWalletEurcBalance", LOG_EMOJI.wallet);
  op.log(`chain=${BASE_EURC.chainId} token=EURC`);
  try {
    const balance = await withFallback(BASE_EURC.chainId, (provider) =>
      readBalance(provider, BASE_EURC.address, address, BASE_EURC.decimals),
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
