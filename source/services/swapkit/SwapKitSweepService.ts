import { createPublicClient, createWalletClient, encodeFunctionData, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, zeroize } from "../../lib/crypto";
import { getPrivateKey } from "../../lib/secureKeyStorage";
import { getChainTransport } from "../../lib/rpc/chainRpc";
import type { ChainId } from "../../lib/tokens";
import { getSweepViemChain } from "./SwapKitEvmSigner";
import { ethereumFees } from "./ethereumFees";
import type { RegistryToken } from "./SwapKitTokenRegistry";

// What is left of the v1 sweep service: the bounded off-Base ERC-20 transfer
// the v2 sweep uses to fund a convert deposit. Scanning and claiming run in
// SwapKitV2SweepService.

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Shared with the v2 sweep service — the bounded off-Base ERC-20 transfer. */
export async function sendErc20OnChain(
  token: RegistryToken,
  toAddress: `0x${string}`,
  amount: string,
  /** Fires immediately before the transfer is broadcast (the irreversible
   * boundary). Optional so every existing caller keeps its behaviour. */
  onBeforeBroadcast?: () => void | Promise<void>,
): Promise<`0x${string}`> {
  const chain = getSweepViemChain(token.chainId);
  if (!chain) throw new Error(`sweep chain ${token.chainId} is not configured`);
  const keyBytes = await getPrivateKey("ethereum");
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(`0x${bytesToHex(keyBytes)}` as `0x${string}`);
  } finally {
    zeroize(keyBytes);
  }
  // The RPC comes from lib/rpc/chainRpc, not viem's built-in default: the default
  // is an unkeyed public endpoint with no timeout or retries, and this is the
  // transfer that moves the user's money. Gas on the EOA is sponsored by SwapKit
  // before the action. A paid key that is dead from the start fails over to the
  // chain's public node; one that answered and then dies fails the transfer, so
  // nonce/gas reads and the broadcast never split across providers.
  const transport = getChainTransport(
    token.chainId as ChainId,
    { retryCount: 2, timeout: 10_000 },
    { singleProvider: true },
  );
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [toAddress, parseUnits(amount, token.decimals)],
  });
  const gas = await publicClient.estimateGas({
    account,
    to: token.address,
    data,
    gas: 200_000n,
  });
  // Cast per the same viem workaround used in BaseTokenTransferService and
  // SwapKitHtlcActionService: sendTransaction's request generic mis-infers here
  // and demands the EIP-4844 `kzg` field for a plain transfer that carries no
  // blobs. Account and chain are already bound on walletClient.
  // Fees before the STARTED marker: an interrupted read leaves the transfer retryable.
  const fees = await ethereumFees(publicClient, token.chainId);
  await onBeforeBroadcast?.();
  return walletClient.sendTransaction({
    to: token.address,
    data,
    gas,
    ...fees,
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0]);
}
