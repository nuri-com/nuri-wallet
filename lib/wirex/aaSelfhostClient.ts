import {
  concatHex,
  createPublicClient,
  formatEther,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isValidEvmAddress } from "../validation";
import { WIREX_CONTRACT_REGISTRY_TESTNET, WIREX_PARTNER_ID_TESTNET } from "../../config/network";
import { baseSepolia } from "viem/chains";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createKernelAccount, createKernelAccountClient, KernelV3_1AccountAbi } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import {
  createWeightedKernelAccountClient,
  createWeightedValidator,
  getValidatorAddress,
  toECDSASigner as toWeightedEcdsaSigner,
  WeightedValidatorContractVersion,
  type WeightedValidatorConfig,
} from "@zerodev/weighted-validator";

export type WeightedSignerState = {
  encodedPublicKey: Hex;
  weight: number;
};

export type WeightedStorageState = {
  totalWeight: number;
  threshold: number;
  delay: number;
  guardianLength: number;
};

export type SelfhostWirexContractAddresses = {
  fundsManagementAddress: Address;
  accountsAddress: Address;
  executionDelayPolicyAddress: Address;
};

export type SelfhostSponsoredRuntimeInput = {
  chainId?: number;
  walletAddress: string;
  walletPrivateKey: string;
  publicRpcUrl: string;
  bundlerRpcUrl: string;
  paymasterAddress: string;
};

export type SelfhostSponsoredRuntime = {
  walletAddress: Address;
  walletPrivateKey: Hex;
  publicRpcUrlUsed: string;
  bundlerRpcUrlUsed: string;
  paymasterAddressUsed: Address;
  publicClient: any;
  kernelPublicClient: any;
  signer: any;
  anchorAccount: any;
  weightedValidatorAddress: Address;
  createAaClient: (targetAccount: any) => any;
  createWeightedAaClient: (targetAccount: any) => any;
};

export type SelfhostAaReadiness = {
  walletAddress: Address;
  kernelAddress: Address;
  publicRpcUrlUsed: string;
  sponsorshipMode: "selfhost_paymaster";
  paymasterAddressUsed: Address;
  kernelDeployed: boolean;
  kernelBalanceWei: string;
  kernelBalanceEth: string;
  weightedValidatorAddress: Address;
  fundsManagementAddress: Address;
  fundsManagementInstalled: boolean;
  accountsAddress: Address;
  executionDelayPolicyAddress: Address;
  weightedInitialized: boolean;
  weightedSignerCount: number;
  weightedThreshold: number;
  weightedDelay: number;
};

// Self-host/debug bootstrap runs only on Base Sepolia (chain-gated below), so it
// always targets the testnet registry regardless of APP_NETWORK. The prod
// register-calldata verifier passes the active-network registry explicitly.
export const CONTRACT_REGISTRY = WIREX_CONTRACT_REGISTRY_TESTNET as Address;
// Self-host/debug bootstrap is Sepolia-only, so it always uses the testnet
// partner id. The prod register-calldata verifier uses the active-network id.
export const PARTNER_ID = WIREX_PARTNER_ID_TESTNET as Hex;
export const ENTRY_POINT = getEntryPoint("0.7");
export const PAYMASTER_VERIFICATION_GAS_LIMIT = 300_000n;
export const PAYMASTER_POST_OP_GAS_LIMIT = 300_000n;
export const WEIGHTED_VALIDATOR_VERSION = WeightedValidatorContractVersion.V0_0_2_PATCHED;
export const WEIGHTED_DEFAULT_THRESHOLD = 100;
export const WEIGHTED_DEFAULT_SIGNER_WEIGHT = 100;
export const FUNDS_MANAGEMENT_MODULE_TYPE = 2n;
export const FUNDS_MANAGEMENT_INIT_DATA = concatHex([
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
]);

export const ContractRegistryAbi = [
  {
    inputs: [{ internalType: "string", name: "name", type: "string" }],
    name: "contractByName",
    outputs: [{ internalType: "address", name: "proxy", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const WeightedValidatorReadAbi = [
  {
    type: "function",
    name: "weightedStorage",
    inputs: [{ name: "kernel", type: "address", internalType: "address" }],
    outputs: [
      { name: "totalWeight", type: "uint24", internalType: "uint24" },
      { name: "threshold", type: "uint24", internalType: "uint24" },
      { name: "delay", type: "uint48", internalType: "uint48" },
      { name: "guardianLength", type: "uint32", internalType: "uint32" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "guardian",
    inputs: [
      { name: "guardianIndex", type: "uint256", internalType: "uint256" },
      { name: "kernel", type: "address", internalType: "address" },
    ],
    outputs: [
      { name: "guardianType", type: "bytes1", internalType: "bytes1" },
      { name: "weight", type: "uint24", internalType: "uint24" },
      { name: "encodedPublicKey", type: "bytes", internalType: "bytes" },
    ],
    stateMutability: "view",
  },
] as const;

export const WeightedValidatorReadAbiLegacy = [
  {
    type: "function",
    name: "weightedStorage",
    inputs: [{ name: "kernel", type: "address", internalType: "address" }],
    outputs: [
      { name: "totalWeight", type: "uint24", internalType: "uint24" },
      { name: "threshold", type: "uint24", internalType: "uint24" },
      { name: "guardianLength", type: "uint32", internalType: "uint32" },
    ],
    stateMutability: "view",
  },
] as const;

export const isZeroDevHost = (value: string): boolean =>
  /(^|[/.])zerodev\./i.test(String(value || ""));

export const isPrivateKeyHex = (value: string): boolean =>
  /^(0x)?[a-fA-F0-9]{64}$/.test(String(value || "").trim());

export const normalizePrivateKey = (value: string): Hex => {
  const raw = String(value || "").trim();
  if (!isPrivateKeyHex(raw)) {
    throw new Error("invalid_private_key");
  }
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  return normalized.toLowerCase() as Hex;
};

export const assertSelfhostUrl = (value: string, errorCode: string): string => {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(errorCode);
  }
  if (isZeroDevHost(normalized)) {
    throw new Error("selfhost_zerodev_endpoint_forbidden");
  }
  return normalized;
};

export const normalizeSelfhostPaymasterAddress = (value: string): Address => {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error("missing_selfhost_paymaster_address");
  }
  if (!isValidEvmAddress(normalized)) {
    throw new Error("invalid_selfhost_paymaster_address");
  }
  return getAddress(normalized);
};

export const toNumberSafe = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "bigint") {
    if (value <= 0n) return 0;
    return Number(value);
  }
  const asText = String(value || "").trim();
  if (!asText) return 0;
  try {
    if (asText.startsWith("0x")) {
      return Number(BigInt(asText));
    }
    return Number(asText);
  } catch {
    return 0;
  }
};

export const normalizeEncodedSigner = (value: unknown): Hex => {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw.startsWith("0x") || raw.length < 4) {
    throw new Error("invalid_weighted_signer_key");
  }
  return raw as Hex;
};

export const toWeightedConfigPublicKey = (encodedPublicKey: Hex): any => {
  if (encodedPublicKey.length === 42) {
    return encodedPublicKey as Address;
  }
  return encodedPublicKey as any;
};

export const normalizeConfigSigners = (
  signers: Array<{ publicKey: any; weight: number }>,
): Array<{ publicKey: any; weight: number }> => {
  const map = new Map<string, { publicKey: any; weight: number }>();
  for (const signer of signers) {
    const key = String(signer.publicKey || "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    const nextWeight = Math.max(1, toNumberSafe(signer.weight));
    const previous = map.get(key);
    if (!previous || previous.weight < nextWeight) {
      map.set(key, { publicKey: signer.publicKey, weight: nextWeight });
    }
  }
  return Array.from(map.values());
};

export const buildCurrentWeightedConfig = (
  walletAddress: Address,
  state: WeightedStorageState,
  currentSigners: WeightedSignerState[],
): WeightedValidatorConfig => {
  const signers = normalizeConfigSigners([
    ...currentSigners.map((entry) => ({
      publicKey: toWeightedConfigPublicKey(entry.encodedPublicKey),
      weight: entry.weight,
    })),
    {
      publicKey: walletAddress,
      weight: WEIGHTED_DEFAULT_SIGNER_WEIGHT,
    },
  ]);

  const totalWeight = signers.reduce((acc, entry) => acc + entry.weight, 0);
  if (totalWeight <= 0) {
    throw new Error("weighted_config_total_weight_zero");
  }

  const thresholdRaw = state.threshold || WEIGHTED_DEFAULT_THRESHOLD;
  const threshold = Math.max(1, Math.min(thresholdRaw, totalWeight));

  return {
    threshold,
    delay: Math.max(0, toNumberSafe(state.delay)),
    signers,
  };
};

export const patchWeightedValidatorForUserOpSignature = <T>(validator: T): T => {
  if (!validator || typeof validator !== "object") return validator;

  const anyValidator = validator as any;
  if (anyValidator.__nuriSignaturePatchApplied) return validator;
  anyValidator.__nuriSignaturePatchApplied = true;

  const normalizeUserOperationForWeightedSigning = (value: any): any => {
    if (!value || typeof value !== "object") return value;
    if (
      value.signature === undefined ||
      value.signature === null ||
      String(value.signature || "").trim() === ""
    ) {
      return {
        ...value,
        signature: "0x",
      };
    }
    return value;
  };

  if (typeof anyValidator.getStubSignature === "function") {
    const originalGetStubSignature = anyValidator.getStubSignature.bind(anyValidator);
    anyValidator.getStubSignature = async (userOperation: any) =>
      await originalGetStubSignature(normalizeUserOperationForWeightedSigning(userOperation));
  }

  if (typeof anyValidator.signUserOperation === "function") {
    const originalSignUserOperation = anyValidator.signUserOperation.bind(anyValidator);
    anyValidator.signUserOperation = async (userOperation: any) =>
      await originalSignUserOperation(normalizeUserOperationForWeightedSigning(userOperation));
  }

  return validator;
};

export const resolveSelfhostWirexContractAddresses = async (
  publicClient: any,
  // Defaults to the testnet registry (self-host debug path). The prod verifier
  // passes the active-network registry (config/network WIREX_CONTRACT_REGISTRY).
  registry: Address = CONTRACT_REGISTRY,
): Promise<SelfhostWirexContractAddresses> => {
  const [fundsManagementAddress, accountsAddress, executionDelayPolicyAddress] = await Promise.all([
    publicClient.readContract({
      address: registry,
      abi: ContractRegistryAbi,
      functionName: "contractByName",
      args: ["FundsManagement"],
    }),
    publicClient.readContract({
      address: registry,
      abi: ContractRegistryAbi,
      functionName: "contractByName",
      args: ["Accounts"],
    }),
    publicClient.readContract({
      address: registry,
      abi: ContractRegistryAbi,
      functionName: "contractByName",
      args: ["ExecutionDelayPolicy"],
    }),
  ]);

  return {
    fundsManagementAddress,
    accountsAddress,
    executionDelayPolicyAddress,
  };
};

export const isAccountDeployed = async (publicClient: any, address: Address): Promise<boolean> => {
  const code = await publicClient.getBytecode({ address });
  return Boolean(code && code !== "0x");
};

export const readWeightedStorage = async (
  publicClient: any,
  walletAddress: Address,
  validatorAddress: Address,
): Promise<WeightedStorageState | null> => {
  try {
    const result = await publicClient.readContract({
      address: validatorAddress,
      abi: WeightedValidatorReadAbi,
      functionName: "weightedStorage",
      args: [walletAddress],
    });

    return {
      totalWeight: toNumberSafe(result?.[0]),
      threshold: toNumberSafe(result?.[1]),
      delay: toNumberSafe(result?.[2]),
      guardianLength: toNumberSafe(result?.[3]),
    };
  } catch {
    try {
      const legacyResult = await publicClient.readContract({
        address: validatorAddress,
        abi: WeightedValidatorReadAbiLegacy,
        functionName: "weightedStorage",
        args: [walletAddress],
      });
      return {
        totalWeight: toNumberSafe(legacyResult?.[0]),
        threshold: toNumberSafe(legacyResult?.[1]),
        delay: 0,
        guardianLength: toNumberSafe(legacyResult?.[2]),
      };
    } catch {
      return null;
    }
  }
};

export const readWeightedSigners = async (
  publicClient: any,
  walletAddress: Address,
  validatorAddress: Address,
  guardianLength: number,
): Promise<WeightedSignerState[]> => {
  const signers: WeightedSignerState[] = [];
  for (let i = 0; i < guardianLength; i += 1) {
    const guardian = await publicClient.readContract({
      address: validatorAddress,
      abi: WeightedValidatorReadAbi,
      functionName: "guardian",
      args: [BigInt(i), walletAddress],
    });
    signers.push({
      encodedPublicKey: normalizeEncodedSigner(guardian?.[2]),
      weight: Math.max(1, toNumberSafe(guardian?.[1])),
    });
  }
  return signers;
};

export const createSelfhostSponsoredAaRuntime = async (
  input: SelfhostSponsoredRuntimeInput,
): Promise<SelfhostSponsoredRuntime> => {
  const chainId = Number(input.chainId || baseSepolia.id);
  if (chainId !== baseSepolia.id) {
    throw new Error(`unsupported_chain_id_${chainId}`);
  }

  const walletAddress = getAddress(String(input.walletAddress || "").trim());
  const walletPrivateKey = normalizePrivateKey(input.walletPrivateKey);
  const publicRpcUrlUsed = assertSelfhostUrl(
    input.publicRpcUrl || "",
    "missing_selfhost_public_rpc_url",
  );
  const bundlerRpcUrlUsed = assertSelfhostUrl(
    input.bundlerRpcUrl || "",
    "missing_selfhost_bundler_rpc_url",
  );
  const paymasterAddressUsed = normalizeSelfhostPaymasterAddress(input.paymasterAddress);

  const signer = privateKeyToAccount(walletPrivateKey);
  if (signer.address.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("private_key_wallet_mismatch");
  }

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(publicRpcUrlUsed),
  });
  const kernelPublicClient = publicClient;
  const bundlerTransport = http(bundlerRpcUrlUsed);

  const simpleValidator = await (signerToEcdsaValidator as any)(
    kernelPublicClient as any,
    {
      entryPoint: ENTRY_POINT,
      signer,
      kernelVersion: KERNEL_V3_1,
    } as any,
  );

  const anchorAccount: any = await createKernelAccount(
    kernelPublicClient as any,
    {
      entryPoint: ENTRY_POINT,
      kernelVersion: KERNEL_V3_1,
      plugins: { sudo: simpleValidator },
    } as any,
  );

  const createPaymaster = () => ({
    async getPaymasterData() {
      return {
        paymaster: paymasterAddressUsed,
        paymasterData: "0x",
        paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS_LIMIT,
        paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS_LIMIT,
      };
    },
  });

  const createAaClient = (targetAccount: any): any =>
    createKernelAccountClient({
      account: targetAccount,
      chain: baseSepolia,
      bundlerTransport,
      userOperation: {
        estimateFeesPerGas: async () => {
          const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
          return { maxFeePerGas, maxPriorityFeePerGas };
        },
      },
      paymaster: createPaymaster(),
    } as any);

  const createWeightedAaClient = (targetAccount: any): any =>
    createWeightedKernelAccountClient({
      account: targetAccount,
      chain: baseSepolia,
      bundlerTransport,
      userOperation: {
        estimateFeesPerGas: async () => {
          const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
          return { maxFeePerGas, maxPriorityFeePerGas };
        },
      },
      paymaster: createPaymaster(),
    } as any);

  const weightedValidatorAddress = getValidatorAddress(
    ENTRY_POINT.version,
    WEIGHTED_VALIDATOR_VERSION,
  );

  return {
    walletAddress,
    walletPrivateKey,
    publicRpcUrlUsed,
    bundlerRpcUrlUsed,
    paymasterAddressUsed,
    publicClient,
    kernelPublicClient,
    signer,
    anchorAccount,
    weightedValidatorAddress,
    createAaClient,
    createWeightedAaClient,
  };
};

export const createCurrentWeightedAccountRuntime = async (
  runtime: SelfhostSponsoredRuntime,
): Promise<{
  weightedStorage: WeightedStorageState;
  weightedSigners: WeightedSignerState[];
  weightedConfig: WeightedValidatorConfig;
  weightedValidator: any;
  weightedAccount: any;
  weightedClient: any;
}> => {
  const weightedStorage = await readWeightedStorage(
    runtime.publicClient,
    runtime.anchorAccount.address,
    runtime.weightedValidatorAddress,
  );
  if (!weightedStorage || weightedStorage.guardianLength <= 0) {
    throw new Error("existing_account_not_weighted_validator_initialized");
  }

  const weightedSigners = await readWeightedSigners(
    runtime.publicClient,
    runtime.anchorAccount.address,
    runtime.weightedValidatorAddress,
    weightedStorage.guardianLength,
  );
  const weightedConfig = buildCurrentWeightedConfig(
    runtime.walletAddress,
    weightedStorage,
    weightedSigners,
  );

  const weightedSigner = await toWeightedEcdsaSigner({ signer: runtime.signer });
  const weightedValidatorRaw = await (createWeightedValidator as any)(
    runtime.kernelPublicClient as any,
    {
      config: weightedConfig,
      signer: weightedSigner,
      entryPoint: ENTRY_POINT,
      kernelVersion: KERNEL_V3_1,
      validatorContractVersion: WEIGHTED_VALIDATOR_VERSION,
      validatorAddress: runtime.weightedValidatorAddress,
    } as any,
  );
  const weightedValidator = patchWeightedValidatorForUserOpSignature(weightedValidatorRaw);
  const weightedAccount = await createKernelAccount(
    runtime.kernelPublicClient as any,
    {
      entryPoint: ENTRY_POINT,
      kernelVersion: KERNEL_V3_1,
      address: runtime.anchorAccount.address,
      plugins: {
        sudo: weightedValidator,
      },
    } as any,
  );
  const weightedClient = runtime.createWeightedAaClient(weightedAccount);

  return {
    weightedStorage,
    weightedSigners,
    weightedConfig,
    weightedValidator,
    weightedAccount,
    weightedClient,
  };
};

export const inspectSelfhostWirexAaReadiness = async (input: {
  walletAddress: string;
  kernelAddress: string;
  publicRpcUrl: string;
  paymasterAddress: string;
}): Promise<SelfhostAaReadiness> => {
  const walletAddress = getAddress(String(input.walletAddress || "").trim());
  const kernelAddress = getAddress(String(input.kernelAddress || "").trim());
  const publicRpcUrlUsed = assertSelfhostUrl(
    input.publicRpcUrl || "",
    "missing_selfhost_public_rpc_url",
  );
  const paymasterAddressUsed = normalizeSelfhostPaymasterAddress(input.paymasterAddress);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(publicRpcUrlUsed),
  });

  const kernelDeployed = await isAccountDeployed(publicClient, kernelAddress);
  const kernelBalanceWei = await publicClient.getBalance({ address: kernelAddress });
  const { fundsManagementAddress, accountsAddress, executionDelayPolicyAddress } =
    await resolveSelfhostWirexContractAddresses(publicClient);

  let fundsManagementInstalled = false;
  let weightedInitialized = false;
  let weightedSignerCount = 0;
  let weightedThreshold = 0;
  let weightedDelay = 0;

  const weightedValidatorAddress = getValidatorAddress(
    ENTRY_POINT.version,
    WEIGHTED_VALIDATOR_VERSION,
  );

  if (kernelDeployed) {
    try {
      fundsManagementInstalled = Boolean(
        await publicClient.readContract({
          address: kernelAddress,
          abi: KernelV3_1AccountAbi,
          functionName: "isModuleInstalled",
          args: [FUNDS_MANAGEMENT_MODULE_TYPE, fundsManagementAddress, FUNDS_MANAGEMENT_INIT_DATA],
        } as any),
      );
    } catch {
      fundsManagementInstalled = false;
    }

    const weightedStorage = await readWeightedStorage(
      publicClient,
      kernelAddress,
      weightedValidatorAddress,
    );
    if (weightedStorage && weightedStorage.guardianLength > 0) {
      weightedInitialized = true;
      weightedSignerCount = weightedStorage.guardianLength;
      weightedThreshold = weightedStorage.threshold;
      weightedDelay = weightedStorage.delay;
    }
  }

  return {
    walletAddress,
    kernelAddress,
    publicRpcUrlUsed,
    sponsorshipMode: "selfhost_paymaster",
    paymasterAddressUsed,
    kernelDeployed,
    kernelBalanceWei: kernelBalanceWei.toString(),
    kernelBalanceEth: formatEther(kernelBalanceWei),
    weightedValidatorAddress,
    fundsManagementAddress,
    fundsManagementInstalled,
    accountsAddress,
    executionDelayPolicyAddress,
    weightedInitialized,
    weightedSignerCount,
    weightedThreshold,
    weightedDelay,
  };
};

export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });

export const isSuccessfulUserOperationReceipt = (receipt: any): boolean => {
  const success = receipt?.success;
  const statusRaw = receipt?.receipt?.status;
  const status =
    typeof statusRaw === "string" ? statusRaw.toLowerCase() : String(statusRaw ?? "").toLowerCase();
  return success === true || status === "success" || status === "0x1" || status === "1";
};
