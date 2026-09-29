import { encodeFunctionData, getAddress, parseUnits, type Address } from "viem";
import { isValidEvmAddress } from "../validation";
import { sendUserOperationWithSignatures } from "@zerodev/weighted-validator";
import {
  createCurrentWeightedAccountRuntime,
  createSelfhostSponsoredAaRuntime,
  inspectSelfhostWirexAaReadiness,
  isSuccessfulUserOperationReceipt,
  withTimeout,
} from "./aaSelfhostClient";
import {
  USER_OPERATION_RECEIPT_TIMEOUT_MS,
  USER_OPERATION_RECEIPT_HARD_TIMEOUT_MS,
} from "./aaConstants";

const Erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address", internalType: "address" }],
    outputs: [{ name: "balance", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8", internalType: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export type AaSponsoredTokenTransferInput = {
  walletAddress: string;
  walletPrivateKey: string;
  publicRpcUrl: string;
  bundlerRpcUrl: string;
  paymasterAddress: string;
  recipientAddress: string;
  tokenAddress: string;
  amount: string;
  chainId?: number;
};

export type AaSponsoredTokenTransferProgress = {
  stage: string;
  details?: Record<string, unknown>;
};

export type AaSponsoredTokenTransferResult = {
  ok: true;
  eoaAddress: Address;
  kernelAddress: Address;
  recipientAddress: Address;
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: string;
  rawAmount: string;
  sponsorshipMode: "selfhost_paymaster";
  paymasterAddressUsed: Address;
  publicRpcUrlUsed: string;
  bundlerRpcUrlUsed: string;
  userOperationHash: string;
  transactionHash: string;
  kernelTokenBalanceBefore: string;
  kernelTokenBalanceAfter: string;
  recipientTokenBalanceBefore: string;
  recipientTokenBalanceAfter: string;
  readiness: Awaited<ReturnType<typeof inspectSelfhostWirexAaReadiness>>;
};

const assertSuccessfulReceipt = (receipt: any, context: string): void => {
  if (isSuccessfulUserOperationReceipt(receipt)) return;
  const statusRaw = receipt?.receipt?.status;
  const status = typeof statusRaw === "string" ? statusRaw : String(statusRaw ?? "").trim();
  const reason = String(receipt?.reason || "").trim();
  const txHash = String(receipt?.receipt?.transactionHash || "").trim();
  const details = [status ? `status=${status}` : "", reason ? `reason=${reason}` : "", txHash]
    .filter(Boolean)
    .join(" ");
  throw new Error(`${context}_user_operation_reverted${details ? `:${details}` : ""}`);
};

const normalizePositiveAmount = (value: string): string => {
  const normalized = String(value || "")
    .trim()
    .replace(",", ".");
  if (!normalized || Number(normalized) <= 0) {
    throw new Error("invalid_aa_transfer_amount");
  }
  return normalized;
};

export const sendSponsoredAaTokenTransferSelfhost = async (
  input: AaSponsoredTokenTransferInput,
  onProgress?: (progress: AaSponsoredTokenTransferProgress) => void,
): Promise<AaSponsoredTokenTransferResult> => {
  const emit = (stage: string, details?: Record<string, unknown>) => {
    if (!onProgress) return;
    onProgress({ stage, details });
  };

  const recipientAddressRaw = String(input.recipientAddress || "").trim();
  if (!isValidEvmAddress(recipientAddressRaw)) {
    throw new Error("invalid_aa_transfer_recipient");
  }
  const tokenAddressRaw = String(input.tokenAddress || "").trim();
  if (!isValidEvmAddress(tokenAddressRaw)) {
    throw new Error("invalid_aa_transfer_token");
  }
  const amount = normalizePositiveAmount(input.amount);
  const recipientAddress = getAddress(recipientAddressRaw);
  const tokenAddress = getAddress(tokenAddressRaw);

  emit("initializing", {
    recipientAddress,
    tokenAddress,
    amount,
  });

  const runtime = await createSelfhostSponsoredAaRuntime({
    chainId: input.chainId,
    walletAddress: input.walletAddress,
    walletPrivateKey: input.walletPrivateKey,
    publicRpcUrl: input.publicRpcUrl,
    bundlerRpcUrl: input.bundlerRpcUrl,
    paymasterAddress: input.paymasterAddress,
  });

  const readiness = await inspectSelfhostWirexAaReadiness({
    walletAddress: runtime.walletAddress,
    kernelAddress: runtime.anchorAccount.address,
    publicRpcUrl: runtime.publicRpcUrlUsed,
    paymasterAddress: runtime.paymasterAddressUsed,
  });
  emit("readiness_checked", {
    kernelAddress: runtime.anchorAccount.address,
    sponsorshipMode: readiness.sponsorshipMode,
    paymasterAddressUsed: readiness.paymasterAddressUsed,
    fundsManagementInstalled: readiness.fundsManagementInstalled,
    weightedInitialized: readiness.weightedInitialized,
    kernelDeployed: readiness.kernelDeployed,
  });

  if (!readiness.kernelDeployed) {
    throw new Error("selfhost_kernel_not_deployed");
  }
  if (!readiness.fundsManagementInstalled) {
    throw new Error("wirex_funds_management_not_installed");
  }
  if (!readiness.weightedInitialized) {
    throw new Error("existing_account_not_weighted_validator_initialized");
  }

  const [tokenDecimals, tokenSymbol, kernelTokenBalanceBefore, recipientTokenBalanceBefore] =
    await Promise.all([
      runtime.publicClient.readContract({
        address: tokenAddress,
        abi: Erc20Abi,
        functionName: "decimals",
      }),
      runtime.publicClient.readContract({
        address: tokenAddress,
        abi: Erc20Abi,
        functionName: "symbol",
      }),
      runtime.publicClient.readContract({
        address: tokenAddress,
        abi: Erc20Abi,
        functionName: "balanceOf",
        args: [runtime.anchorAccount.address],
      }),
      runtime.publicClient.readContract({
        address: tokenAddress,
        abi: Erc20Abi,
        functionName: "balanceOf",
        args: [recipientAddress],
      }),
    ]);
  const rawAmount = parseUnits(amount, Number(tokenDecimals));
  if (rawAmount <= 0n) {
    throw new Error("invalid_aa_transfer_amount");
  }
  if ((kernelTokenBalanceBefore as bigint) < rawAmount) {
    throw new Error("aa_token_balance_insufficient");
  }

  emit("token_transfer_prepared", {
    tokenSymbol: String(tokenSymbol || ""),
    tokenDecimals: Number(tokenDecimals),
    rawAmount: rawAmount.toString(),
    kernelTokenBalanceBefore: String(kernelTokenBalanceBefore ?? "0"),
  });

  const { weightedClient } = await createCurrentWeightedAccountRuntime(runtime);
  const callData = await weightedClient.account.encodeCalls([
    {
      to: tokenAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: Erc20Abi,
        functionName: "transfer",
        args: [recipientAddress, rawAmount],
      }),
    },
  ]);
  const userOperationHash = await sendUserOperationWithSignatures(weightedClient, {
    sender: runtime.anchorAccount.address,
    callData,
    signatures: [],
  } as any);

  emit("user_operation_sent", {
    hash: userOperationHash,
    kernelAddress: runtime.anchorAccount.address,
  });

  const receipt: any = await withTimeout(
    weightedClient.waitForUserOperationReceipt({
      hash: userOperationHash,
      timeout: USER_OPERATION_RECEIPT_TIMEOUT_MS,
    }),
    USER_OPERATION_RECEIPT_HARD_TIMEOUT_MS,
    `sponsored_transfer_receipt_timeout_after_${USER_OPERATION_RECEIPT_HARD_TIMEOUT_MS}ms`,
  );
  assertSuccessfulReceipt(receipt, "sponsored_transfer");

  const [kernelTokenBalanceAfter, recipientTokenBalanceAfter] = await Promise.all([
    runtime.publicClient.readContract({
      address: tokenAddress,
      abi: Erc20Abi,
      functionName: "balanceOf",
      args: [runtime.anchorAccount.address],
    }),
    runtime.publicClient.readContract({
      address: tokenAddress,
      abi: Erc20Abi,
      functionName: "balanceOf",
      args: [recipientAddress],
    }),
  ]);

  emit("completed", {
    hash: userOperationHash,
    transactionHash: String(receipt?.receipt?.transactionHash || ""),
    kernelTokenBalanceAfter: String(kernelTokenBalanceAfter ?? "0"),
    recipientTokenBalanceAfter: String(recipientTokenBalanceAfter ?? "0"),
  });

  return {
    ok: true,
    eoaAddress: runtime.walletAddress,
    kernelAddress: runtime.anchorAccount.address,
    recipientAddress,
    tokenAddress,
    tokenSymbol: String(tokenSymbol || ""),
    tokenDecimals: Number(tokenDecimals),
    amount,
    rawAmount: rawAmount.toString(),
    sponsorshipMode: readiness.sponsorshipMode,
    paymasterAddressUsed: runtime.paymasterAddressUsed,
    publicRpcUrlUsed: runtime.publicRpcUrlUsed,
    bundlerRpcUrlUsed: runtime.bundlerRpcUrlUsed,
    userOperationHash,
    transactionHash: String(receipt?.receipt?.transactionHash || ""),
    kernelTokenBalanceBefore: String(kernelTokenBalanceBefore ?? "0"),
    kernelTokenBalanceAfter: String(kernelTokenBalanceAfter ?? "0"),
    recipientTokenBalanceBefore: String(recipientTokenBalanceBefore ?? "0"),
    recipientTokenBalanceAfter: String(recipientTokenBalanceAfter ?? "0"),
    readiness,
  };
};
