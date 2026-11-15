// Card withdrawal straight onchain, for when the Wirex route is down (#1956).
//
// The card is a Kernel v3.1 smart account whose root is Wirex's execution delay
// policy. Taking money out is two UserOperations: a REQUEST that schedules the
// withdrawal call on the delay policy, then after the delay a FINAL that runs
// it. The hosted route builds both on our Wirex server and submits them through
// a bundler; this module builds the very same operations on the device and the
// owner's own wallet submits them with EntryPoint v0.7 `handleOps`.
//
// Gas: both operations carry maxFeePerGas = 0. EntryPoint v0.7 asks the account
// for gas x maxFeePerGas and has no minimum, so the card account pays nothing
// and needs no ETH. The wallet pays the whole network cost of its own
// transaction, topped up by the app's Base gas dripper.
//
// Mirrors nuri-com/banking-paymentrequired-com src/aa-withdrawal.mjs (the
// direct mode proven on Base mainnet): same accounts, same call data, same
// nonce keys, same gas limits. Pure builders and checks live here; the run with
// the key, the dripper and the durable record lives in
// services/wirex/directWithdraw.ts.

import {
  concatHex,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  parseAbiParameters,
  parseUnits,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { toAccount } from "viem/accounts";
import {
  entryPoint07Abi,
  getUserOperationHash,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createKernelAccount, getCustomNonceKeyFromString } from "@zerodev/sdk";
import { KERNEL_V3_1, VALIDATOR_MODE, VALIDATOR_TYPE } from "@zerodev/sdk/constants";
import { toPermissionValidator } from "@zerodev/permissions";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  createWeightedValidator,
  getValidatorAddress as getWeightedValidatorAddress,
  toECDSASigner as toWeightedEcdsaSigner,
} from "@zerodev/weighted-validator";
import {
  buildCurrentWeightedConfig,
  ContractRegistryAbi,
  ENTRY_POINT,
  patchWeightedValidatorForUserOpSignature,
  readWeightedSigners,
  readWeightedStorage,
  WEIGHTED_VALIDATOR_VERSION,
} from "./aaSelfhostClient";

export type DirectWithdrawAsset = "EURC" | "USDC";
export type DirectRootKind = "weighted-delay" | "legacy-delay";

/** Base Sepolia: the sandbox pays out with `withdrawTo`, mainnet unwraps and transfers. */
const SANDBOX_CHAIN_ID = 84532;

/**
 * The final step needs 2,000,000 call gas. 750,000 validated but ran out inside
 * the call: the outer transaction succeeded, the UserOperation failed, nothing
 * was paid out and the schedule was spent.
 */
export const DIRECT_FINAL_CALL_GAS_LIMIT = 2_000_000n;
export const DIRECT_REQUEST_CALL_GAS_LIMIT = 750_000n;
const PRE_VERIFICATION_GAS = 100_000n;

const TokenRegistryAbi = [
  {
    inputs: [],
    name: "retrieveAllTokensV2",
    outputs: [
      {
        components: [
          { name: "tokenAddress", type: "address" },
          { name: "symbol", type: "string" },
          { name: "decimals", type: "uint256" },
          { name: "isSynthetic", type: "bool" },
          { name: "baseToken", type: "address" },
        ],
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const SyntheticAbi = [
  {
    inputs: [{ name: "amount", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    name: "withdrawTo",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const ExecutionDelayPolicyAbi = [
  {
    inputs: [
      { name: "wallet", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "callData", type: "bytes" },
    ],
    name: "request",
    outputs: [{ name: "", type: "uint48" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "callDataAndNonceHash", type: "bytes32" }],
    name: "operationsPerAccount",
    outputs: [
      { name: "opType", type: "uint8" },
      { name: "status", type: "uint8" },
      { name: "validAfter", type: "uint48" },
      { name: "validUntil", type: "uint48" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const KernelValidationAbi = [
  {
    type: "function",
    name: "rootValidator",
    inputs: [],
    outputs: [{ name: "", type: "bytes21" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "currentNonce",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "installValidations",
    inputs: [
      { name: "vIds", type: "bytes21[]" },
      {
        name: "configs",
        type: "tuple[]",
        components: [
          { name: "nonce", type: "uint32" },
          { name: "hook", type: "address" },
        ],
      },
      { name: "validationData", type: "bytes[]" },
      { name: "hookData", type: "bytes[]" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

const EntryPointNonceAbi = [
  {
    type: "function",
    name: "getNonce",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const BeforeExecutionAbi = parseAbi(["event BeforeExecution()"]);

/**
 * A signer that never holds the key. Building the accounts needs a signer
 * object; signing is done once per step with the wallet key and its signature
 * handed in here, so the same EIP-191 signature over the UserOperation hash is
 * what every validator returns (the server builds them exactly this way).
 */
function presignedSigner(address: Address, signature?: Hex) {
  const refuse = async (): Promise<never> => {
    throw new Error("direct_withdraw_signer_not_presigned");
  };
  return toAccount({
    address,
    signMessage: signature ? async () => signature : refuse,
    signTransaction: refuse,
    signTypedData: refuse,
  });
}

function validatorId(type: Hex, identifier: Hex): string {
  return concatHex([type, pad(identifier, { size: 20, dir: "right" })]).toLowerCase();
}

async function buildKernelAccount(publicClient: any, address: Address, plugins: any): Promise<any> {
  const account: any = await createKernelAccount(publicClient, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_V3_1,
    plugins,
    address,
  });
  // The card account is deployed; never attach factory data to its operations.
  account.getFactoryArgs = async (): Promise<{ factory: undefined; factoryData: undefined }> => ({
    factory: undefined,
    factoryData: undefined,
  });
  return account;
}

/** The card account the wallet owns: the deployed Kernel at the wallet's index-0 address. */
export async function cardAccountAddress(publicClient: any, wallet: Address): Promise<Address> {
  const anchor = await signerToEcdsaValidator(publicClient, {
    signer: presignedSigner(wallet),
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_V3_1,
  });
  const account = await createKernelAccount(publicClient, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_V3_1,
    plugins: { sudo: anchor },
  });
  const code = await publicClient.getCode({ address: account.address });
  if (!code || code === "0x") throw new Error("direct_withdraw_card_account_not_deployed");
  return getAddress(account.address);
}

export type DirectWithdrawContext = {
  kind: DirectRootKind;
  wallet: Address;
  kernelAddress: Address;
  delayPolicyAddress: Address;
  requestAccount: any;
  executeAccount: any;
  installCall: { to: Address; value: bigint; data: Hex } | null;
  executionNonce: (callData: Hex) => Promise<bigint>;
};

/**
 * The two accounts that sign the two steps, read from the card account's own
 * root. A weighted root requests with the weighted validator and executes with
 * the delay policy permission; a delay policy root does both with itself.
 */
export async function buildDirectWithdrawContext(
  publicClient: any,
  walletInput: string,
  registry: Address,
  signature?: Hex,
): Promise<DirectWithdrawContext> {
  const wallet = getAddress(walletInput);
  const kernelAddress = await cardAccountAddress(publicClient, wallet);
  const delayPolicyAddress = getAddress(
    await publicClient.readContract({
      address: registry,
      abi: ContractRegistryAbi,
      functionName: "contractByName",
      args: ["ExecutionDelayPolicy"],
    }),
  );
  const root = String(
    await publicClient.readContract({
      address: kernelAddress,
      abi: KernelValidationAbi,
      functionName: "rootValidator",
    }),
  ).toLowerCase();
  const weightedValidatorAddress = getWeightedValidatorAddress(
    ENTRY_POINT.version,
    WEIGHTED_VALIDATOR_VERSION,
  ) as Address;

  const permissionValidator: any = await toPermissionValidator(publicClient, {
    entryPoint: ENTRY_POINT,
    signer: await toECDSASigner({ signer: presignedSigner(wallet, signature) }),
    kernelVersion: KERNEL_V3_1,
    policies: [toSudoPolicy({ policyAddress: delayPolicyAddress })],
  });
  const permissionId = permissionValidator.getIdentifier() as Hex;

  if (root === validatorId(VALIDATOR_TYPE.SECONDARY, weightedValidatorAddress)) {
    const storage = await readWeightedStorage(
      publicClient,
      kernelAddress,
      weightedValidatorAddress,
    );
    if (!storage || storage.guardianLength <= 0) {
      throw new Error("direct_withdraw_weighted_root_without_guardians");
    }
    const guardians = await readWeightedSigners(
      publicClient,
      kernelAddress,
      weightedValidatorAddress,
      storage.guardianLength,
    );
    const weightedValidator = patchWeightedValidatorForUserOpSignature(
      await createWeightedValidator(publicClient, {
        config: buildCurrentWeightedConfig(wallet, storage, guardians),
        signer: await toWeightedEcdsaSigner({ signer: presignedSigner(wallet, signature) }),
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_1,
        validatorContractVersion: WEIGHTED_VALIDATOR_VERSION,
        validatorAddress: weightedValidatorAddress,
      }),
    );
    const requestAccount = await buildKernelAccount(publicClient, kernelAddress, {
      sudo: weightedValidator,
    });
    const executeAccount = await buildKernelAccount(publicClient, kernelAddress, {
      sudo: weightedValidator,
      regular: permissionValidator,
    });
    const installed = await permissionValidator.isEnabled(kernelAddress);
    return {
      kind: "weighted-delay",
      wallet,
      kernelAddress,
      delayPolicyAddress,
      requestAccount,
      executeAccount,
      installCall: installed
        ? null
        : await installDelayPolicyCall(publicClient, kernelAddress, permissionValidator),
      executionNonce: (callData) =>
        delayPolicyExecutionNonce(publicClient, kernelAddress, permissionId, callData),
    };
  }

  if (root !== validatorId(VALIDATOR_TYPE.PERMISSION, permissionId)) {
    throw new Error("direct_withdraw_unknown_root_validator");
  }
  permissionValidator.address = delayPolicyAddress;
  const account = await buildKernelAccount(publicClient, kernelAddress, {
    sudo: permissionValidator,
  });
  return {
    kind: "legacy-delay",
    wallet,
    kernelAddress,
    delayPolicyAddress,
    requestAccount: account,
    executeAccount: account,
    installCall: null,
    executionNonce: (callData) =>
      account.getNonce({ key: getCustomNonceKeyFromString(keccak256(callData), "0.7") }),
  };
}

async function installDelayPolicyCall(
  publicClient: any,
  kernelAddress: Address,
  permissionValidator: any,
): Promise<{ to: Address; value: bigint; data: Hex }> {
  const nonce = await publicClient.readContract({
    address: kernelAddress,
    abi: KernelValidationAbi,
    functionName: "currentNonce",
  });
  const vId = pad(concatHex([VALIDATOR_TYPE.PERMISSION, permissionValidator.getIdentifier()]), {
    size: 21,
    dir: "right",
  });
  const data = encodeFunctionData({
    abi: KernelValidationAbi,
    functionName: "installValidations",
    args: [
      [vId],
      [{ nonce, hook: zeroAddress }],
      [await permissionValidator.getEnableData(kernelAddress)],
      ["0x"],
    ],
  });
  return { to: kernelAddress, value: 0n, data };
}

// The delay policy nonce is keyed by the withdrawal's own call data: the final
// step for one schedule can run once, and a second one finds the nonce spent.
async function delayPolicyExecutionNonce(
  publicClient: any,
  kernelAddress: Address,
  permissionId: Hex,
  callData: Hex,
): Promise<bigint> {
  const customKey = getCustomNonceKeyFromString(keccak256(callData), "0.7");
  const key = BigInt(
    pad(
      concatHex([
        VALIDATOR_MODE.DEFAULT,
        VALIDATOR_TYPE.PERMISSION,
        pad(permissionId, { size: 20, dir: "right" }),
        pad(toHex(customKey), { size: 2 }),
      ]),
      { size: 24 },
    ),
  );
  return publicClient.readContract({
    address: ENTRY_POINT.address,
    abi: EntryPointNonceAbi,
    functionName: "getNonce",
    args: [kernelAddress, key],
  });
}

export type WithdrawToken = { address: Address; decimals: number; symbol: string };
export type RegistryToken = {
  tokenAddress: string;
  symbol: string;
  decimals: bigint | number;
  isSynthetic: boolean;
  baseToken: string;
};

/** The card pocket (synthetic) and the coin it pays out (base) for one asset, from Wirex's token registry. */
export function withdrawTokenPair(
  tokens: readonly RegistryToken[],
  asset: DirectWithdrawAsset,
): { synthetic: WithdrawToken; base: WithdrawToken } {
  if (!Array.isArray(tokens)) throw new Error("direct_withdraw_token_registry_invalid");
  const bases = tokens.filter(
    (token) => token.isSynthetic === false && String(token.symbol).toUpperCase() === asset,
  );
  if (bases.length !== 1) throw new Error("direct_withdraw_base_token_invalid");
  const base = bases[0];
  const synthetics = tokens.filter(
    (token) =>
      token.isSynthetic === true && getAddress(token.baseToken) === getAddress(base.tokenAddress),
  );
  if (synthetics.length !== 1) throw new Error("direct_withdraw_card_token_invalid");
  const synthetic = synthetics[0];
  const shape = (token: RegistryToken): WithdrawToken => {
    const decimals = Number(token.decimals);
    if (
      !token.symbol ||
      getAddress(token.tokenAddress) === zeroAddress ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255
    ) {
      throw new Error("direct_withdraw_token_invalid");
    }
    return { address: getAddress(token.tokenAddress), decimals, symbol: token.symbol };
  };
  return { synthetic: shape(synthetic), base: shape(base) };
}

export async function readWithdrawTokenPair(
  publicClient: any,
  registry: Address,
  asset: DirectWithdrawAsset,
): Promise<{ synthetic: WithdrawToken; base: WithdrawToken }> {
  const tokenRegistry = await publicClient.readContract({
    address: registry,
    abi: ContractRegistryAbi,
    functionName: "contractByName",
    args: ["TokensRegistry"],
  });
  const tokens = await publicClient.readContract({
    address: tokenRegistry,
    abi: TokenRegistryAbi,
    functionName: "retrieveAllTokensV2",
  });
  return withdrawTokenPair(tokens as RegistryToken[], asset);
}

export type WithdrawCall = { to: Address; value: bigint; data: Hex };

/** The calls the card account runs in the final step: unwrap its pocket and pay the coin to the wallet. */
export function directWithdrawCalls({
  wallet,
  kernelAddress,
  amount,
  synthetic,
  base,
  chainId,
}: {
  wallet: Address;
  kernelAddress: Address;
  amount: string;
  synthetic: WithdrawToken;
  base: WithdrawToken;
  chainId: number;
}): { syntheticAmount: bigint; baseAmount: bigint; calls: WithdrawCall[] } {
  const text = amount.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text) || !/[1-9]/.test(text)) {
    throw new Error("direct_withdraw_amount_invalid");
  }
  const recipient = getAddress(wallet);
  if (recipient === zeroAddress || recipient === getAddress(kernelAddress)) {
    throw new Error("direct_withdraw_recipient_invalid");
  }
  if (synthetic.address === base.address) throw new Error("direct_withdraw_token_invalid");
  const fraction = (text.split(".")[1] || "").replace(/0+$/, "");
  if (fraction.length > Math.min(synthetic.decimals, base.decimals)) {
    throw new Error("direct_withdraw_amount_invalid");
  }
  const syntheticAmount = parseUnits(text, synthetic.decimals);
  const baseAmount = parseUnits(text, base.decimals);
  if (chainId === SANDBOX_CHAIN_ID) {
    return {
      syntheticAmount,
      baseAmount,
      calls: [
        {
          to: synthetic.address,
          value: 0n,
          data: encodeFunctionData({
            abi: SyntheticAbi,
            functionName: "withdrawTo",
            args: [syntheticAmount, recipient],
          }),
        },
      ],
    };
  }
  return {
    syntheticAmount,
    baseAmount,
    calls: [
      {
        to: synthetic.address,
        value: 0n,
        data: encodeFunctionData({
          abi: SyntheticAbi,
          functionName: "withdraw",
          args: [syntheticAmount],
        }),
      },
      {
        to: base.address,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, baseAmount],
        }),
      },
    ],
  };
}

/** An operation the card account pays nothing for: both fee fields are zero. */
export function zeroFeeUserOperation({
  sender,
  nonce,
  callData,
  callGasLimit,
  kind,
}: {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  callGasLimit: bigint;
  kind: DirectRootKind;
}): UserOperation<"0.7"> {
  return {
    sender,
    nonce,
    callData,
    callGasLimit,
    verificationGasLimit: kind === "weighted-delay" ? 2_000_000n : 750_000n,
    preVerificationGas: PRE_VERIFICATION_GAS,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    signature: "0x",
  };
}

export function userOperationHashFor(chainId: number, userOperation: UserOperation<"0.7">): Hex {
  return getUserOperationHash({
    chainId,
    entryPointAddress: ENTRY_POINT.address,
    entryPointVersion: "0.7",
    userOperation,
  });
}

export type PreparedRequest = {
  userOp: UserOperation<"0.7">;
  userOpHash: Hex;
  executionCallData: Hex;
  executionNonce: bigint;
  syntheticAmount: bigint;
  baseAmount: bigint;
  synthetic: WithdrawToken;
  base: WithdrawToken;
};

/** The request step: schedule the withdrawal call on the delay policy. */
export async function prepareDirectRequest(
  publicClient: any,
  ctx: DirectWithdrawContext,
  {
    amount,
    asset,
    chainId,
    registry,
  }: { amount: string; asset: DirectWithdrawAsset; chainId: number; registry: Address },
): Promise<PreparedRequest> {
  const { synthetic, base } = await readWithdrawTokenPair(publicClient, registry, asset);
  const transfer = directWithdrawCalls({
    wallet: ctx.wallet,
    kernelAddress: ctx.kernelAddress,
    amount,
    synthetic,
    base,
    chainId,
  });
  const balance: bigint = await publicClient.readContract({
    address: synthetic.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ctx.kernelAddress],
  });
  if (balance < transfer.syntheticAmount) throw new Error("direct_withdraw_insufficient_balance");
  const executionCallData: Hex = await ctx.executeAccount.encodeCalls(transfer.calls);
  const executionNonce = await ctx.executionNonce(executionCallData);
  const requestData = encodeFunctionData({
    abi: ExecutionDelayPolicyAbi,
    functionName: "request",
    args: [ctx.kernelAddress, executionNonce, executionCallData],
  });
  const callData: Hex = await ctx.requestAccount.encodeCalls([
    ...(ctx.installCall ? [ctx.installCall] : []),
    { to: ctx.delayPolicyAddress, value: 0n, data: requestData },
  ]);
  const userOp = zeroFeeUserOperation({
    sender: ctx.kernelAddress,
    nonce: await ctx.requestAccount.getNonce(),
    callData,
    callGasLimit: DIRECT_REQUEST_CALL_GAS_LIMIT,
    kind: ctx.kind,
  });
  return {
    userOp,
    userOpHash: userOperationHashFor(chainId, userOp),
    executionCallData,
    executionNonce,
    syntheticAmount: transfer.syntheticAmount,
    baseAmount: transfer.baseAmount,
    synthetic,
    base,
  };
}

/** The final step: run the scheduled call. */
export async function prepareDirectFinal(
  ctx: DirectWithdrawContext,
  executionCallData: Hex,
  chainId: number,
): Promise<{ userOp: UserOperation<"0.7">; userOpHash: Hex }> {
  const userOp = zeroFeeUserOperation({
    sender: ctx.kernelAddress,
    nonce: await ctx.executionNonce(executionCallData),
    callData: executionCallData,
    callGasLimit: DIRECT_FINAL_CALL_GAS_LIMIT,
    kind: ctx.kind,
  });
  return { userOp, userOpHash: userOperationHashFor(chainId, userOp) };
}

/**
 * The operation's signature field from the wallet's EIP-191 signature over its
 * hash. A delay policy root takes it behind the 0xff marker; a weighted root
 * has its validator wrap it.
 */
export async function signedUserOperation(
  ctx: DirectWithdrawContext,
  phase: "request" | "final",
  userOp: UserOperation<"0.7">,
  signature: Hex,
): Promise<UserOperation<"0.7">> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("direct_withdraw_signature_invalid");
  if (ctx.kind === "legacy-delay") return { ...userOp, signature: concatHex(["0xff", signature]) };
  const account = phase === "final" ? ctx.executeAccount : ctx.requestAccount;
  const signed: Hex = await account.signUserOperation({ ...userOp, signature: "0x" });
  return { ...userOp, signature: signed };
}

/** EntryPoint v0.7 `handleOps` for one operation, refunds (zero here) to the wallet. */
export function handleOpsCallData(userOp: UserOperation<"0.7">, beneficiary: Address): Hex {
  return encodeFunctionData({
    abi: entryPoint07Abi,
    functionName: "handleOps",
    args: [[toPackedUserOperation(userOp)], beneficiary],
  });
}

/** The delay policy's key for one scheduled withdrawal. */
export function withdrawScheduleHash({
  kernelAddress,
  executionCallData,
  executionNonce,
}: {
  kernelAddress: Address;
  executionCallData: Hex;
  executionNonce: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, bytes, uint256"), [
      getAddress(kernelAddress),
      executionCallData,
      executionNonce,
    ]),
  );
}

export type WithdrawSchedule = { scheduled: boolean; validAfterMs: number; validUntilMs: number };

/** Whether the withdrawal is scheduled and the window in which its final step may run. */
export async function readWithdrawSchedule(
  publicClient: any,
  delayPolicyAddress: Address,
  key: Parameters<typeof withdrawScheduleHash>[0],
): Promise<WithdrawSchedule> {
  const row = await publicClient.readContract({
    address: delayPolicyAddress,
    abi: ExecutionDelayPolicyAbi,
    functionName: "operationsPerAccount",
    args: [withdrawScheduleHash(key)],
  });
  return parseWithdrawSchedule(row);
}

export function parseWithdrawSchedule(row: readonly unknown[]): WithdrawSchedule {
  const status = Number(row?.[1]);
  const seconds = (value: unknown) => {
    const n = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
    return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
  };
  return {
    scheduled: status === 1,
    validAfterMs: seconds(row?.[2]),
    validUntilMs: seconds(row?.[3]),
  };
}

type ReceiptLog = { address: string; topics: readonly Hex[]; data: Hex; logIndex?: number | null };
export type ChainReceipt = {
  status: "success" | "reverted";
  transactionHash: Hex;
  logs: readonly ReceiptLog[];
};

// viem cannot narrow a decoded event from a runtime log shape; callers check
// eventName before reading args.
function decodeLog(abi: readonly unknown[], log: ReceiptLog): { eventName: string; args: any } {
  return decodeEventLog({
    abi: abi as any,
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  }) as unknown as { eventName: string; args: any };
}

/**
 * What a mined `handleOps` did for one operation. The outer transaction can
 * succeed while the operation inside it fails, so only the operation's own
 * event decides; a receipt without it is not this operation's.
 */
export function userOperationOutcome(
  receipt: ChainReceipt,
  { userOpHash, sender }: { userOpHash: Hex; sender: Address },
): "succeeded" | "failed" {
  if (receipt.status !== "success") return "failed";
  const events = receipt.logs.flatMap((log) => {
    if (getAddress(log.address) !== getAddress(ENTRY_POINT.address)) return [];
    try {
      const event = decodeLog(entryPoint07Abi, log);
      return event.eventName === "UserOperationEvent" ? [event.args] : [];
    } catch {
      return [];
    }
  });
  const matches = events.filter(
    (args: any) =>
      String(args.userOpHash).toLowerCase() === userOpHash.toLowerCase() &&
      getAddress(args.sender) === getAddress(sender),
  );
  if (matches.length !== 1) throw new Error("direct_withdraw_receipt_mismatch");
  return (matches[0] as any).success === true ? "succeeded" : "failed";
}

/**
 * The payout inside the final step: exactly the base coin, from the card
 * account to the wallet, for the amount asked. A successful operation without
 * it is not a completed withdrawal.
 */
export function hasSettlementTransfer(
  receipt: ChainReceipt,
  { token, from, to, amount }: { token: Address; from: Address; to: Address; amount: bigint },
): boolean {
  const opens = receipt.logs.findIndex((log) => {
    if (getAddress(log.address) !== getAddress(ENTRY_POINT.address)) return false;
    try {
      return decodeLog(BeforeExecutionAbi, log).eventName === "BeforeExecution";
    } catch {
      return false;
    }
  });
  return receipt.logs.slice(opens < 0 ? 0 : opens + 1).some((log) => {
    if (getAddress(log.address) !== getAddress(token)) return false;
    try {
      const event = decodeLog(erc20Abi, log);
      return (
        event.eventName === "Transfer" &&
        getAddress(event.args.from) === getAddress(from) &&
        getAddress(event.args.to) === getAddress(to) &&
        event.args.value === amount
      );
    } catch {
      return false;
    }
  });
}

/**
 * Whether a failed start of the hosted withdrawal means the route is down: no
 * connection, a timeout, or a server error. A start signs nothing, so only
 * these hand the withdrawal to the direct route; an answered refusal (low
 * balance, bad amount) is the user's answer and stays one.
 */
export function isHostedWithdrawDown(failure: {
  status?: number;
  networkError?: boolean;
}): boolean {
  if (failure.networkError) return true;
  return typeof failure.status === "number" && failure.status >= 500 && failure.status <= 599;
}

// ── The durable record ────────────────────────────────────────────────
// Written the moment before the final step's transaction is broadcast, under
// the same key the hosted route's marker uses, so every existing lock, pending
// row and wipe covers it. A request on its own moves no money: the final step
// does, and only that step needs a record.

export type DirectWithdrawRecord = {
  kind: "direct";
  at: number;
  wallet: Address;
  kernelAddress: Address;
  asset: DirectWithdrawAsset;
  amount: string;
  baseToken: Address;
  baseAmount: string;
  /** Empty when the run finished a schedule an earlier attempt had made. */
  requestTxHash: Hex | "";
  finalTxHash: Hex;
  finalRawTx: Hex;
  finalUserOpHash: Hex;
  /** The final operation's EntryPoint nonce: once the chain has moved past it, the operation can never run. */
  finalOpNonce: string;
  /** When the schedule closes (ms, 0 = never): past it the operation cannot validate. */
  validUntilMs: number;
};

const isHash = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isHex = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);

export function parseDirectWithdrawRecord(raw: string): DirectWithdrawRecord | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed?.kind !== "direct") return null;
  try {
    const record: DirectWithdrawRecord = {
      kind: "direct",
      at: Number(parsed.at) > 0 ? Number(parsed.at) : 0,
      wallet: getAddress(parsed.wallet),
      kernelAddress: getAddress(parsed.kernelAddress),
      asset: parsed.asset === "USDC" ? "USDC" : "EURC",
      amount: String(parsed.amount || ""),
      baseToken: getAddress(parsed.baseToken),
      baseAmount: String(BigInt(parsed.baseAmount)),
      requestTxHash: parsed.requestTxHash || "",
      finalTxHash: parsed.finalTxHash,
      finalRawTx: parsed.finalRawTx,
      finalUserOpHash: parsed.finalUserOpHash,
      finalOpNonce: String(BigInt(parsed.finalOpNonce)),
      validUntilMs: Number(parsed.validUntilMs) > 0 ? Number(parsed.validUntilMs) : 0,
    };
    if (
      !record.amount ||
      (record.requestTxHash !== "" && !isHash(record.requestTxHash)) ||
      !isHash(record.finalTxHash) ||
      !isHash(record.finalUserOpHash) ||
      !isHex(record.finalRawTx) ||
      keccak256(record.finalRawTx).toLowerCase() !== record.finalTxHash.toLowerCase()
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}
