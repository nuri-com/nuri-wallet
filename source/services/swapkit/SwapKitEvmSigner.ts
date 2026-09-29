import { createPublicClient, createWalletClient, encodeFunctionData, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, avalanche, base, bsc, gnosis, mainnet, optimism, polygon } from "viem/chains";
import { bytesToHex, zeroize } from "../../lib/crypto";
import { getPrivateKey } from "../../lib/secureKeyStorage";
import { getBaseViemTransport } from "../../lib/rpc/baseRpc";
import { getChainRpcUrl } from "../../lib/rpc/chainRpc";
import type { ChainId } from "../../lib/tokens";
import type { ParsedSwapActionTx } from "./SwapKitService";
import { swapGasLimit } from "./swapGasLimit";
import {
  assertEvmCallBoundToRoute,
  type SwapKitV2EvmRouteBinding,
} from "./SwapKitV2EvmRouteBinding";

/**
 * Decode a DIRECT ERC-20 spend out of raw calldata, or null when the call is
 * something else.
 *
 * `approve` bounds what a spender MAY take later; these two move the wallet's
 * tokens NOW, to a recipient named in the calldata itself. The server builds
 * this calldata and the wallet never decoded it, so an `execute_evm_call`
 * carrying `transfer(attacker, balance)` was simulated and broadcast with
 * nothing checking the amount or the destination.
 *
 *   transfer(address,uint256)          0xa9059cbb  — two words
 *   transferFrom(address,address,uint256) 0x23b872dd — three words
 *
 * `transferFrom` is included because it can move THIS wallet's tokens whenever
 * a spender allowance exists. Bounded lanes refuse both outright.
 */
function decodeErc20Spend(
  data: string,
): { kind: "transfer" | "transferFrom"; from?: string; to: string; amount: bigint } | null {
  const hex = String(data || "").toLowerCase();
  const body = hex.slice(10);
  if (!/^[0-9a-f]*$/.test(body)) return null;
  if (hex.startsWith("0xa9059cbb") && body.length === 128) {
    return {
      kind: "transfer",
      to: `0x${body.slice(24, 64)}`,
      amount: BigInt(`0x${body.slice(64, 128)}`),
    };
  }
  if (hex.startsWith("0x23b872dd") && body.length === 192) {
    return {
      kind: "transferFrom",
      from: `0x${body.slice(24, 64)}`,
      to: `0x${body.slice(88, 128)}`,
      amount: BigInt(`0x${body.slice(128, 192)}`),
    };
  }
  return null;
}

/**
 * Decode `approve(address,uint256)` out of raw calldata, or null when the call
 * is something else. The wallet must be able to see the SIZE of an allowance it
 * is about to sign even when the server sent no approval metadata alongside it.
 *
 * Selector `0x095ea7b3` = keccak("approve(address,uint256)"), followed by two
 * 32-byte words: the spender (right-aligned) and the amount.
 */
function decodeErc20Approval(data: string): { spender: string; amount: bigint } | null {
  const hex = String(data || "").toLowerCase();
  if (!hex.startsWith("0x095ea7b3")) return null;
  const body = hex.slice(10);
  // Exactly two words. A longer or shorter payload is not a plain approval and
  // must not be waved through by a partial read of it.
  if (body.length !== 128) return null;
  if (!/^[0-9a-f]+$/.test(body)) return null;
  return {
    spender: `0x${body.slice(24, 64)}`,
    amount: BigInt(`0x${body.slice(64, 128)}`),
  };
}

// The chains scanned by swap_sweep. One signer executes the same guarded
// server-prepared action on any of them; adding a chain no longer needs a new
// signer or tracker branch.
const CHAINS = new Map<number, Chain>(
  [mainnet, base, arbitrum, optimism, polygon, bsc, avalanche, gnosis].map((chain) => [
    chain.id,
    chain,
  ]),
);

export const SWAPKIT_SWEEP_CHAIN_IDS = [...CHAINS.keys()];

/** The viem chain for a sweep chain id, for callers that build their own client. */
export const getSweepViemChain = (chainId: number): Chain | undefined => CHAINS.get(chainId);

// The server labels a scanned balance with its own short chain name
// ("arbitrum") or with viem's display name ("Arbitrum One"), depending on which
// scanner produced it, and some items carry no chainId at all. Both spellings
// map here so a label-only item is still resolvable.
const SWEEP_CHAIN_IDS_BY_LABEL = new Map<string, number>([
  ...[...CHAINS.entries()].map(([id, chain]) => [chain.name.toLowerCase(), id] as const),
  ...[...CHAINS.entries()].map(
    ([id, chain]) => [chain.name.toLowerCase().replace(/[^a-z0-9]/g, ""), id] as const,
  ),
  ["ethereum", mainnet.id],
  ["arbitrum", arbitrum.id],
  ["optimism", optimism.id],
  ["polygon", polygon.id],
  ["gnosis", gnosis.id],
  ["base", base.id],
  ["bsc", bsc.id],
  ["avalanche", avalanche.id],
]);

/** The sweep chain id for a server chain label, or undefined when unknown. */
export const getSweepChainIdByLabel = (label: string): number | undefined =>
  SWEEP_CHAIN_IDS_BY_LABEL.get(label.trim().toLowerCase()) ??
  SWEEP_CHAIN_IDS_BY_LABEL.get(
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ""),
  );

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

async function loadAccount(): Promise<ReturnType<typeof privateKeyToAccount>> {
  const keyBytes = await getPrivateKey("ethereum");
  try {
    return privateKeyToAccount(`0x${bytesToHex(keyBytes)}` as `0x${string}`);
  } finally {
    zeroize(keyBytes);
  }
}

/** How long a simulation may wait for the chain to show the previous step. */
export const SIMULATION_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 3_000, 4_000];

/**
 * Run the pre-sign simulation, retrying while it fails. A revert right after
 * an approval is almost always a node that has not applied it yet; a call that
 * is genuinely bad still fails after the last retry and is refused as before.
 */
export async function simulateUntilStateCatchesUp<T>(
  simulate: () => Promise<T>,
  delays: readonly number[] = SIMULATION_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await simulate();
    } catch (error) {
      if (attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

export async function signAndBroadcastSwapKitEvmTx(
  parsed: ParsedSwapActionTx,
  bounds?: {
    maxApprovalUnits?: bigint;
    /** SWEEP LANE ONLY. Sweep calldata is server-built and never decoded, so an
     * approvalless action could ride a leftover allowance and spend past the
     * detected balance — the sweep opts into refusing it. Bounded ORDER flows
     * must NOT set this: the server now emits an explicit `approve` as its own
     * `execute_evm_call` with raw calldata and no `approval` metadata, and that
     * server-authoritative action must be signed, not refused. */
    requireApprovalBound?: boolean;
    onBroadcast?: (hash: `0x${string}`) => void | Promise<void>;
    onBeforeBroadcast?: () => void | Promise<void>;
    /** EVM-SOURCE orders: bind every call to the accepted route's contracts
     * (see SwapKitV2EvmRouteBinding). Requires maxApprovalUnits. */
    route?: SwapKitV2EvmRouteBinding;
    /** Fires only when an allowance transaction is actually sent — the status
     * pill says "Approving…" for a route that approves, and never for one that
     * does not. A no-op when the existing allowance already matches. */
    onApproving?: () => void;
  },
): Promise<{ hash: `0x${string}` }> {
  const chain = CHAINS.get(parsed.chainId);
  if (!chain) throw new Error(`SwapKit sweep chain ${parsed.chainId} is not configured.`);

  const account = await loadAccount();
  if (parsed.from && parsed.from.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`Sweep action is bound to signer ${parsed.from}, not this wallet.`);
  }
  // parseSwapActionTx binds WHICH token may be approved; nothing bounded HOW
  // MUCH. The calldata that follows is server-built and never decoded, so any
  // allowance above the swept balance is spendable beyond it. The ceiling comes
  // from the read-only scan's detected amount, persisted on the order.
  // A DIRECT ERC-20 spend moves money now, to a recipient named only in
  // server-built calldata. No route emits one (deposits are funded through
  // send_asset, pulls through approve + router), so every bounded lane refuses
  // it outright rather than trying to judge its recipient.
  if (
    (bounds?.maxApprovalUnits != null || bounds?.requireApprovalBound || bounds?.route) &&
    decodeErc20Spend(parsed.data)
  ) {
    throw new Error("A bounded order never signs a raw ERC-20 transfer; refusing this calldata.");
  }
  if (parsed.approval && bounds?.route) {
    // Metadata approvals bypass calldata decoding; a route-bound order only
    // signs server calls it can decode.
    throw new Error("A route-bound order does not accept approval metadata; refusing it.");
  }
  if (parsed.approval) {
    if (bounds?.maxApprovalUnits == null) {
      throw new Error("Sweep approval has no detected-amount bound.");
    }
    if (parsed.approval.amount > bounds.maxApprovalUnits) {
      throw new Error("Sweep approval exceeds the detected balance.");
    }
  } else if (bounds?.requireApprovalBound) {
    // The sweep lane. parseSwapActionTx pins the chain, the target and the
    // approvable token, but the calldata itself is server-built and never
    // decoded — so the approval is the only place an AMOUNT can be bounded. An
    // action carrying no approval would either call the token directly or ride
    // an allowance left over from an earlier route, in both cases spending past
    // the detected balance with nothing checking it. Refuse rather than sign
    // calldata whose size this wallet cannot see.
    throw new Error("Sweep action carries no approval to bound; refusing to sign it.");
  } else if (bounds?.maxApprovalUnits != null) {
    // BOUNDED ORDER LANE. The server emits its `approve` as a plain
    // `execute_evm_call` with raw calldata and NO `approval` metadata, so the
    // branch above never sees it. Decode the calldata itself.
    const rawApproval = decodeErc20Approval(parsed.data);
    if (rawApproval && rawApproval.amount > bounds.maxApprovalUnits) {
      throw new Error(
        `Approval calldata exceeds the accepted deposit: ${rawApproval.amount} > ${bounds.maxApprovalUnits}`,
      );
    }
    if (bounds.route) {
      assertEvmCallBoundToRoute(
        { chainId: parsed.chainId, to: parsed.to, data: parsed.data },
        bounds.route,
        bounds.maxApprovalUnits,
        account.address,
      );
    }
  } else if (bounds?.route) {
    throw new Error("A route-bound EVM call needs the accepted ceiling; refusing to sign it.");
  }

  // Base has its own configured transport; every other sweep chain takes the
  // RPC from lib/rpc/chainRpc rather than viem's built-in default. A bare
  // http() falls back to the chain's public endpoint with no timeout and no
  // retries — on Arbitrum that is what turns a sweep into three "attempt ended
  // without any funds moving" failures, which the server then blocks for 6h.
  const rpcUrl = parsed.chainId === base.id ? undefined : getChainRpcUrl(parsed.chainId as ChainId);
  const transport =
    parsed.chainId === base.id
      ? getBaseViemTransport()
      : http(rpcUrl, { retryCount: 2, timeout: 10_000 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const send = (tx: { to: `0x${string}`; data: `0x${string}`; gas: bigint }) =>
    walletClient.sendTransaction({
      account,
      chain,
      ...tx,
    } as unknown as Parameters<typeof walletClient.sendTransaction>[0]);

  // Exact server-requested allowance for the contract called next. The parser
  // already guarantees spender === transaction target and native value === 0.
  if (parsed.approval) {
    const approval = parsed.approval;
    const sendApprove = async (amount: bigint): Promise<void> => {
      const data = encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [approval.spender, amount],
      });
      const gas = await publicClient.estimateGas({
        account,
        to: approval.token,
        data,
      });
      const approveHash = await send({ to: approval.token, data, gas });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (receipt.status !== "success") {
        throw new Error(`Sweep approval reverted onchain: ${approveHash}`);
      }
    };

    const allowanceCall = await publicClient.call({
      to: approval.token,
      data: encodeFunctionData({
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [account.address, approval.spender],
      }),
    });
    const allowance = BigInt(allowanceCall.data ?? "0x0");
    if (allowance !== approval.amount) {
      bounds?.onApproving?.();
      if (allowance !== 0n) await sendApprove(0n);
      await sendApprove(approval.amount);
    }
  }

  // Simulate the exact server action immediately before signing it.
  //
  // Retried briefly: the step before this one is usually the approval, and on
  // Base its receipt can come back before every RPC node has applied it. The
  // simulation then runs against state with no allowance, reverts, and the
  // swap was refused within a second of an approval that had landed. Nothing
  // is signed until a simulation passes, so retrying costs nothing.
  //
  // The estimate always runs, even with a provider advisory: the advisory
  // alone was too low for an OKX-routed swap and ran it out of gas.
  const gas = await simulateUntilStateCatchesUp(async () => {
    await publicClient.call({
      account: account.address,
      to: parsed.to,
      data: parsed.data,
      value: 0n,
    });
    const estimated = await publicClient.estimateGas({
      account,
      to: parsed.to,
      data: parsed.data,
    });
    return swapGasLimit(parsed.gasLimit, estimated);
  });
  await bounds?.onBeforeBroadcast?.();
  const hash = await send({ to: parsed.to, data: parsed.data, gas });
  await bounds?.onBroadcast?.(hash);
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Sweep action reverted onchain: ${hash}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Sweep action reverted onchain:")) {
      throw error;
    }
    // sendTransaction already returned the network-assigned hash. A public RPC
    // may lag or time out while reading the receipt; losing the hash here makes
    // the parent rebuild and sign the action again. Return it so swap_track can
    // reconcile the one broadcast instead of risking a duplicate.
    console.log(
      `[SwapKitEvmSigner] receipt unavailable after broadcast hash=${hash} err=${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { hash };
}
