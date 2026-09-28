import {
  encodeAbiParameters,
  encodeFunctionData,
  concatHex,
  formatEther,
  keccak256,
  pad,
  slice,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { isValidEvmAddress } from "../validation";
import { KernelV3_1AccountAbi } from "@zerodev/sdk";
import { KERNEL_V3_1, VALIDATOR_TYPE } from "@zerodev/sdk/constants";
import { toPermissionValidator } from "@zerodev/permissions";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { toECDSASigner as toPermissionEcdsaSigner } from "@zerodev/permissions/signers";
import {
  createWeightedValidator,
  sendUserOperationWithSignatures,
  toECDSASigner as toWeightedEcdsaSigner,
  type WeightedValidatorConfig,
} from "@zerodev/weighted-validator";
import { encodeWebAuthnPubKey } from "@zerodev/webauthn-key";
import { base64urlToBytes, bytesToBase64url, bytesToHex, hexToBytes } from "../crypto";
import { errMsg } from "../errorMessage";
import {
  CONTRACT_REGISTRY,
  ContractRegistryAbi,
  ENTRY_POINT,
  PARTNER_ID,
  WEIGHTED_DEFAULT_SIGNER_WEIGHT,
  WEIGHTED_DEFAULT_THRESHOLD,
  WEIGHTED_VALIDATOR_VERSION,
  assertSelfhostUrl,
  createCurrentWeightedAccountRuntime,
  createSelfhostSponsoredAaRuntime,
  isAccountDeployed,
  isSuccessfulUserOperationReceipt,
  normalizeConfigSigners,
  normalizeEncodedSigner,
  normalizePrivateKey,
  normalizeSelfhostPaymasterAddress,
  readWeightedSigners,
  readWeightedStorage,
  toNumberSafe,
  toWeightedConfigPublicKey,
  withTimeout,
  type WeightedSignerState,
  type WeightedStorageState,
} from "./aaSelfhostClient";
import {
  USER_OPERATION_RECEIPT_TIMEOUT_MS,
  USER_OPERATION_RECEIPT_HARD_TIMEOUT_MS,
  CREATE_AND_REGISTER_MAX_ATTEMPTS,
  UPDATE_SIGNERS_MAX_ATTEMPTS,
  WEIGHTED_SIGNER_VISIBILITY_MAX_ATTEMPTS,
} from "./aaConstants";

export type WirexAaBootstrapInput = {
  walletAddress: string;
  walletPrivateKey: string;
  walletPasskeyCredIdB64u?: string;
  walletPasskeyCredPubkeyB64u?: string;
  walletPasskeyRpId?: string;
  bootstrapMode?: "default" | "add_credential";
  chainId?: number;
  publicRpcUrl?: string;
  bundlerRpcUrl?: string;
  paymasterAddress: string;
};

export type WirexAaBootstrapProgress = {
  stage: string;
  details?: Record<string, unknown>;
};

export type WirexAaBootstrapResult = {
  ok: true;
  walletAddress: Address;
  kernelAddress: Address;
  aaProvider: "selfhost";
  bootstrapMode: "default" | "add_credential";
  chainId: number;
  publicRpcUrlUsed: string;
  bundlerRpcUrlUsed: string;
  sponsorshipMode: "selfhost_paymaster";
  paymasterAddressUsed: Address;
  deployedBefore: boolean;
  webAuthnPermissionInstalledBefore: boolean;
  webAuthnPermissionInstalledAfter: boolean;
  userOperationHash: Hex | null;
  permissionId: Hex;
  rpId: string;
};

const AccountsAbi = [
  {
    inputs: [{ internalType: "bytes16", name: "parentEntity", type: "bytes16" }],
    name: "createUserAccountWithWallet",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const WeightedValidatorWriteAbi = [
  {
    type: "function",
    name: "renew",
    inputs: [{ name: "_data", type: "bytes", internalType: "bytes" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const shortAddress = (value: string): string => {
  if (!value || value.length < 10) return "unknown";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

const toHexPrefixed = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}` as Hex;

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const getWeightedSignerVisibilityWaitMs = (attempt: number): number => {
  if (attempt <= 1) return 1_500;
  if (attempt === 2) return 3_000;
  if (attempt === 3) return 5_000;
  if (attempt === 4) return 8_000;
  return 10_000;
};

const getErrorSummary = (value: unknown): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const timeoutMatch = raw.match(/Timed out while waiting for User Operation[^.\n]*\./i)?.[0];
  if (timeoutMatch) return timeoutMatch.trim();
  const detailsMatch =
    raw.match(/Details:\s*"([^"]+)"/i)?.[1]?.trim() ||
    raw.match(/Details:\s*([^\n]+)/i)?.[1]?.trim();
  if (detailsMatch) return detailsMatch;
  const reasonMatch = raw.match(/reason:\s*([^\n]+)/i)?.[1]?.trim();
  if (reasonMatch) return reasonMatch;
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const nonVersionLine = lines.find((line) => !/^version:/i.test(line));
  if (nonVersionLine) return nonVersionLine;
  if (lines.length > 0) return lines[0];
  return raw;
};

const parseUncompressedP256Key = (rawKey: Uint8Array): { pubX: bigint; pubY: bigint } => {
  if (rawKey.length !== 65 || rawKey[0] !== 0x04) {
    throw new Error("invalid_uncompressed_p256_key");
  }
  const xBytes = rawKey.slice(1, 33);
  const yBytes = rawKey.slice(33, 65);
  return {
    pubX: BigInt(`0x${bytesToHex(xBytes)}`),
    pubY: BigInt(`0x${bytesToHex(yBytes)}`),
  };
};

const looksLikeJson = (value: string): boolean => {
  const trimmed = String(value || "").trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
};

const looksLikeHex = (value: string): boolean =>
  /^(0x)?[a-fA-F0-9]+$/.test(String(value || "").trim());

const looksLikeBase64 = (value: string): boolean =>
  /^[A-Za-z0-9+/_=-]+$/.test(String(value || "").trim());

const tryDecodeUtf8 = (rawBytes: Uint8Array): string => {
  try {
    const decoder = new TextDecoder();
    return decoder.decode(rawBytes);
  } catch {
    return "";
  }
};

const extractUncompressedFromCoseEc2 = (rawBytes: Uint8Array): Uint8Array | null => {
  let xBytes: Uint8Array | null = null;
  let yBytes: Uint8Array | null = null;
  for (let i = 0; i <= rawBytes.length - 35; i += 1) {
    const key = rawBytes[i];
    if ((key === 0x21 || key === 0x22) && rawBytes[i + 1] === 0x58 && rawBytes[i + 2] === 0x20) {
      const bytes = rawBytes.slice(i + 3, i + 35);
      if (key === 0x21) {
        xBytes = bytes;
      } else {
        yBytes = bytes;
      }
      if (xBytes && yBytes) {
        const raw = new Uint8Array(65);
        raw[0] = 0x04;
        raw.set(xBytes, 1);
        raw.set(yBytes, 33);
        return raw;
      }
    }
  }
  return null;
};

const extractUncompressedP256Key = (
  rawBytes: Uint8Array,
  depth = 0,
): { uncompressedKey: Uint8Array; sourceFormat: string } => {
  if (rawBytes.length === 65 && rawBytes[0] === 0x04) {
    return { uncompressedKey: rawBytes, sourceFormat: "raw_uncompressed" };
  }

  if (rawBytes.length === 64) {
    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    raw.set(rawBytes, 1);
    return { uncompressedKey: raw, sourceFormat: "raw_xy" };
  }

  const spkiPrefixHex = "3059301306072a8648ce3d020106082a8648ce3d030107034200";
  const rawHex = bytesToHex(rawBytes).toLowerCase();
  if (rawHex.startsWith(spkiPrefixHex)) {
    const offset = spkiPrefixHex.length / 2;
    const keyBytes = rawBytes.slice(offset, offset + 65);
    if (keyBytes.length === 65 && keyBytes[0] === 0x04) {
      return { uncompressedKey: keyBytes, sourceFormat: "spki_der" };
    }
  }

  const marker = [0x03, 0x42, 0x00, 0x04];
  for (let i = 0; i <= rawBytes.length - 68; i += 1) {
    if (
      rawBytes[i] === marker[0] &&
      rawBytes[i + 1] === marker[1] &&
      rawBytes[i + 2] === marker[2] &&
      rawBytes[i + 3] === marker[3]
    ) {
      const keyBytes = rawBytes.slice(i + 3, i + 68);
      if (keyBytes.length === 65 && keyBytes[0] === 0x04) {
        return { uncompressedKey: keyBytes, sourceFormat: "der_bit_string" };
      }
    }
  }

  const coseUncompressed = extractUncompressedFromCoseEc2(rawBytes);
  if (coseUncompressed) {
    return { uncompressedKey: coseUncompressed, sourceFormat: "cose_ec2" };
  }

  if (depth < 1) {
    const utf8 = tryDecodeUtf8(rawBytes).trim();
    if (utf8) {
      if (looksLikeJson(utf8)) {
        try {
          const jwk = JSON.parse(utf8);
          const x = base64urlToBytes(String(jwk?.x || "").trim());
          const y = base64urlToBytes(String(jwk?.y || "").trim());
          if (x.length === 32 && y.length === 32) {
            const raw = new Uint8Array(65);
            raw[0] = 0x04;
            raw.set(x, 1);
            raw.set(y, 33);
            return { uncompressedKey: raw, sourceFormat: "jwk_json" };
          }
        } catch {
          // ignore
        }
      }

      if (looksLikeHex(utf8)) {
        try {
          const decodedHex = hexToBytes(utf8.startsWith("0x") ? utf8.slice(2) : utf8);
          return extractUncompressedP256Key(decodedHex, depth + 1);
        } catch {
          // ignore
        }
      }

      if (looksLikeBase64(utf8)) {
        try {
          const decodedB64 = base64urlToBytes(utf8);
          return extractUncompressedP256Key(decodedB64, depth + 1);
        } catch {
          // ignore
        }
      }
    }
  }

  const prefix = bytesToHex(rawBytes.slice(0, 8));
  throw new Error(`unsupported_passkey_public_key_format(len=${rawBytes.length},prefix=${prefix})`);
};

export const normalizePasskeyPublicKeyForAaBootstrapSelfhost = (
  credPubkeyB64u: string,
): {
  pubX: bigint;
  pubY: bigint;
  normalizedPublicKeyB64u: string;
  sourceFormat: string;
} => {
  const rawBytes = base64urlToBytes(String(credPubkeyB64u || "").trim());
  if (!rawBytes.length) {
    throw new Error("missing_passkey_public_key");
  }
  const { uncompressedKey, sourceFormat } = extractUncompressedP256Key(rawBytes);
  const parsed = parseUncompressedP256Key(uncompressedKey);
  return {
    ...parsed,
    normalizedPublicKeyB64u: bytesToBase64url(uncompressedKey),
    sourceFormat,
  };
};

const parsePasskeyPublicKey = (
  credPubkeyB64u: string,
): {
  pubX: bigint;
  pubY: bigint;
  normalizedPublicKeyB64u: string;
  sourceFormat: string;
} => {
  return normalizePasskeyPublicKeyForAaBootstrapSelfhost(credPubkeyB64u);
};

const getValidatorTypeHex = (validatorTypeRaw: unknown): Hex => {
  const validatorType = String(validatorTypeRaw || "");
  const validatorTypeHex = VALIDATOR_TYPE[validatorType as keyof typeof VALIDATOR_TYPE];
  if (!validatorTypeHex) {
    throw new Error(`unknown_validator_type_${validatorType || "missing"}`);
  }
  return validatorTypeHex as Hex;
};

const getValidatorId = (validator: any): Hex =>
  concatHex([
    getValidatorTypeHex(validator?.validatorType),
    pad(validator.getIdentifier(), { size: 20, dir: "right" }) as Hex,
  ]) as Hex;

const getInstallExecutorCallData = async (
  publicClient: any,
  walletAddress: Address,
): Promise<{ to: Address; value: bigint; data: Hex }> => {
  const initData = concatHex([
    zeroAddress,
    "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
  ]);

  const executorAddress = await publicClient.readContract({
    address: CONTRACT_REGISTRY,
    abi: ContractRegistryAbi,
    functionName: "contractByName",
    args: ["FundsManagement"],
  });

  const data = encodeFunctionData({
    abi: KernelV3_1AccountAbi,
    functionName: "installModule",
    args: [2n, executorAddress, initData],
  });

  return {
    to: walletAddress,
    value: 0n,
    data,
  };
};

const getChangeRootValidatorCallData = async (
  walletAddress: Address,
  validator: any,
): Promise<{ to: Address; value: bigint; data: Hex }> => {
  const rootValidatorId = getValidatorId(validator);
  const data = encodeFunctionData({
    abi: KernelV3_1AccountAbi,
    functionName: "changeRootValidator",
    args: [rootValidatorId, zeroAddress, await validator.getEnableData(walletAddress), "0x"],
  });

  return {
    to: walletAddress,
    value: 0n,
    data,
  };
};

const getAccountCreateCallData = async (
  publicClient: any,
): Promise<{ to: Address; value: bigint; data: Hex }> => {
  const accountsAddress = await publicClient.readContract({
    address: CONTRACT_REGISTRY,
    abi: ContractRegistryAbi,
    functionName: "contractByName",
    args: ["Accounts"],
  });

  const data = encodeFunctionData({
    abi: AccountsAbi,
    functionName: "createUserAccountWithWallet",
    args: [PARTNER_ID],
  });

  return {
    to: accountsAddress,
    value: 0n,
    data,
  };
};

let executionDelayPolicyAddressCache: Address | null = null;

const getExecutionDelayPolicyAddress = async (publicClient: any): Promise<Address> => {
  if (executionDelayPolicyAddressCache) {
    return executionDelayPolicyAddressCache;
  }
  executionDelayPolicyAddressCache = await publicClient.readContract({
    address: CONTRACT_REGISTRY,
    abi: ContractRegistryAbi,
    functionName: "contractByName",
    args: ["ExecutionDelayPolicy"],
  });
  return executionDelayPolicyAddressCache;
};

const isUserOperationReceiptTimeoutError = (value: unknown): boolean => {
  const message = String(value || "").toLowerCase();
  if (!message) return false;
  return (
    message.includes("timed out while waiting for user operation") ||
    message.includes("receipt_timeout")
  );
};

const getUserOperationReceiptFailureDigest = (receipt: any): string => {
  const statusRaw = receipt?.receipt?.status;
  const status = typeof statusRaw === "string" ? statusRaw : String(statusRaw ?? "").trim();
  const reason = String(receipt?.reason || "").trim();
  const txHash = String(receipt?.receipt?.transactionHash || "").trim();
  const parts = [
    status ? `status=${status}` : "status=unknown",
    reason ? `reason=${reason}` : "",
    txHash ? `txHash=${txHash}` : "",
  ].filter(Boolean);
  return parts.join(" ");
};

const assertUserOperationReceiptSuccessful = (receipt: any, context: string): void => {
  if (isSuccessfulUserOperationReceipt(receipt)) return;
  const digest = getUserOperationReceiptFailureDigest(receipt);
  throw new Error(`${context}_user_operation_reverted:${digest}`);
};

const buildCreateWeightedConfig = (
  walletAddress: Address,
  encodedPasskeyPublicKey: Hex,
): WeightedValidatorConfig => {
  return {
    threshold: WEIGHTED_DEFAULT_THRESHOLD,
    delay: 0,
    signers: normalizeConfigSigners([
      {
        publicKey: walletAddress,
        weight: WEIGHTED_DEFAULT_SIGNER_WEIGHT,
      },
      {
        publicKey: toWeightedConfigPublicKey(encodedPasskeyPublicKey),
        weight: WEIGHTED_DEFAULT_SIGNER_WEIGHT,
      },
    ]),
  };
};

const buildUpdatedWeightedConfig = (
  currentConfig: WeightedValidatorConfig,
  encodedPasskeyPublicKey: Hex,
): WeightedValidatorConfig => {
  const signers = normalizeConfigSigners([
    ...currentConfig.signers,
    {
      publicKey: toWeightedConfigPublicKey(encodedPasskeyPublicKey),
      weight: WEIGHTED_DEFAULT_SIGNER_WEIGHT,
    },
  ]);

  const totalWeight = signers.reduce((acc, entry) => acc + entry.weight, 0);
  const thresholdRaw = toNumberSafe(currentConfig.threshold);
  const threshold = Math.max(1, Math.min(thresholdRaw || WEIGHTED_DEFAULT_THRESHOLD, totalWeight));

  return {
    threshold,
    delay: Math.max(0, toNumberSafe(currentConfig.delay)),
    signers,
  };
};

const sortWeightedConfigSigners = (
  signers: Array<{ publicKey: any; weight: number }>,
): Array<{ publicKey: Hex; weight: number }> =>
  signers
    .map((entry) => ({
      publicKey: normalizeEncodedSigner(String(entry.publicKey || "")),
      weight: Math.max(1, toNumberSafe(entry.weight)),
    }))
    .sort((a, b) => b.publicKey.toLowerCase().localeCompare(a.publicKey.toLowerCase()));

const encodeWeightedRenewData = (config: WeightedValidatorConfig): Hex => {
  const sortedSigners = sortWeightedConfigSigners(config.signers);
  return concatHex([
    toHex(Math.max(1, toNumberSafe(config.threshold)), { size: 3 }),
    toHex(Math.max(0, toNumberSafe(config.delay)), { size: 6 }),
    encodeAbiParameters(
      [{ name: "guardiansData", type: "bytes[]" }],
      [
        sortedSigners.map((cfg) =>
          concatHex([
            cfg.publicKey.length === 42 ? ("0x01" as Hex) : ("0x02" as Hex),
            toHex(cfg.weight, { size: 3 }),
            cfg.publicKey,
          ]),
        ),
      ],
    ),
  ]);
};

const extractAuthenticatorIdHashFromEncodedSigner = (encodedPublicKey: Hex): Hex | null => {
  const normalized = normalizeEncodedSigner(encodedPublicKey);
  // WebAuthn key encoding is exactly pubX(32) + pubY(32) + authenticatorIdHash(32).
  if (normalized.length !== 2 + 64 * 3) return null;
  const compact = normalized.slice(2);
  const authHash = compact.slice(compact.length - 64);
  if (!authHash || authHash.length !== 64) return null;
  return `0x${authHash}` as Hex;
};

/**
 * After a user operation whose receipt never confirmed: read the validator's
 * signers back and look for OUR credential among them. A timeout is not a
 * failure — the operation may well have landed, and the signer list on chain is
 * the only thing that answers that.
 */
const findCredentialAfterFailure = async (
  publicClient: any,
  kernelAddress: Address,
  weightedValidatorAddress: Address,
  credential: { encodedPublicKey?: Hex | null; authenticatorIdHash: Hex },
): Promise<{ signers: WeightedSignerState[]; recovered: WeightedSignerState | null }> => {
  const storage = await readWeightedStorage(publicClient, kernelAddress, weightedValidatorAddress);
  const signers =
    storage && storage.guardianLength > 0
      ? await readWeightedSigners(
          publicClient,
          kernelAddress,
          weightedValidatorAddress,
          storage.guardianLength,
        )
      : [];
  return { signers, recovered: findSignerForCredential(signers, credential) };
};

const findSignerForCredential = (
  signers: WeightedSignerState[],
  options: {
    encodedPublicKey?: Hex | null;
    authenticatorIdHash: Hex;
  },
): WeightedSignerState | null => {
  const encodedPublicKey = options.encodedPublicKey || null;
  if (encodedPublicKey) {
    const needle = normalizeEncodedSigner(encodedPublicKey);
    const directMatch = signers.find(
      (entry) => normalizeEncodedSigner(entry.encodedPublicKey) === needle,
    );
    if (directMatch) {
      return directMatch;
    }
  }

  const targetHash = normalizeEncodedSigner(options.authenticatorIdHash);
  for (const signer of signers) {
    const signerHash = extractAuthenticatorIdHashFromEncodedSigner(signer.encodedPublicKey);
    if (!signerHash) continue;
    if (normalizeEncodedSigner(signerHash) === targetHash) {
      return signer;
    }
  }

  return null;
};

const derivePermissionIdFromEncodedPublicKey = (encodedPublicKey: Hex): Hex => {
  return slice(keccak256(encodedPublicKey), 0, 4) as Hex;
};

export const bootstrapWirexAaOnDeviceSelfhost = async (
  input: WirexAaBootstrapInput,
  onProgress?: (progress: WirexAaBootstrapProgress) => void,
): Promise<WirexAaBootstrapResult> => {
  const chainId = Number(input.chainId || baseSepolia.id);
  if (chainId !== baseSepolia.id) {
    throw new Error(`unsupported_chain_id_${chainId}`);
  }

  const walletAddress = String(input.walletAddress || "").trim() as Address;
  const walletPrivateKey = normalizePrivateKey(input.walletPrivateKey);
  const walletPasskeyCredIdB64u = String(input.walletPasskeyCredIdB64u || "").trim();
  const walletPasskeyCredPubkeyB64u = String(input.walletPasskeyCredPubkeyB64u || "").trim();
  const bootstrapMode = input.bootstrapMode === "add_credential" ? "add_credential" : "default";
  const walletPasskeyRpId = String(input.walletPasskeyRpId || "").trim() || "nuri.com";

  if (!walletAddress || !isValidEvmAddress(walletAddress)) {
    throw new Error("invalid_wallet_address");
  }

  if (!walletPasskeyCredIdB64u) {
    throw new Error("missing_wallet_passkey_credential_id");
  }
  if (bootstrapMode === "add_credential" && !walletPasskeyCredPubkeyB64u) {
    throw new Error("missing_wallet_passkey_metadata");
  }

  const signer = privateKeyToAccount(walletPrivateKey);
  if (signer.address.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("private_key_wallet_mismatch");
  }

  const authenticatorIdBytes = base64urlToBytes(walletPasskeyCredIdB64u);
  if (!authenticatorIdBytes.length) {
    throw new Error("missing_wallet_passkey_credential_id");
  }
  const authenticatorIdHash = keccak256(toHexPrefixed(authenticatorIdBytes));

  let encodedPasskeyPublicKey: Hex | null = null;
  let sourceFormat = "cred_id_only";
  if (walletPasskeyCredPubkeyB64u) {
    const {
      pubX,
      pubY,
      sourceFormat: parsedSourceFormat,
    } = parsePasskeyPublicKey(walletPasskeyCredPubkeyB64u);
    sourceFormat = parsedSourceFormat;
    const webAuthnKey = {
      pubX,
      pubY,
      authenticatorId: walletPasskeyCredIdB64u,
      authenticatorIdHash,
      rpID: walletPasskeyRpId,
    };
    encodedPasskeyPublicKey = encodeWebAuthnPubKey(webAuthnKey) as Hex;
  }
  let permissionId = encodedPasskeyPublicKey
    ? derivePermissionIdFromEncodedPublicKey(encodedPasskeyPublicKey)
    : ("0x00000000" as Hex);

  const bundlerRpcUrl = assertSelfhostUrl(
    input.bundlerRpcUrl || "",
    "missing_selfhost_bundler_rpc_url",
  );
  const explicitPublicRpcUrl = assertSelfhostUrl(
    input.publicRpcUrl || "",
    "missing_selfhost_public_rpc_url",
  );
  const paymasterAddress = normalizeSelfhostPaymasterAddress(input.paymasterAddress);

  const emit = (stage: string, details?: Record<string, unknown>) => {
    if (!onProgress) return;
    onProgress({ stage, details });
  };

  emit("initializing", {
    aaProvider: "selfhost",
    wallet: shortAddress(walletAddress),
    walletAddress,
    chainId,
    bootstrapMode,
    rpId: walletPasskeyRpId,
    sourceFormat,
    publicRpcUrlUsed: explicitPublicRpcUrl,
    bundlerRpcUrlUsed: bundlerRpcUrl,
    sponsorshipMode: "selfhost_paymaster",
    paymasterAddressUsed: paymasterAddress,
  });

  emit("passkey_public_key_ready", {
    sourceFormat,
    credIdLen: walletPasskeyCredIdB64u.length,
    normalizedKeyLen: walletPasskeyCredPubkeyB64u.length,
    hasPublicKey: Boolean(walletPasskeyCredPubkeyB64u),
  });
  emit("building_kernel_account");
  const runtime = await createSelfhostSponsoredAaRuntime({
    chainId,
    walletAddress,
    walletPrivateKey,
    publicRpcUrl: explicitPublicRpcUrl,
    bundlerRpcUrl,
    paymasterAddress,
  });
  const {
    publicClient,
    kernelPublicClient,
    anchorAccount,
    weightedValidatorAddress,
    createAaClient,
    paymasterAddressUsed,
  } = runtime;

  emit("kernel_account_ready", {
    kernel: shortAddress(anchorAccount.address),
    kernelAddress: anchorAccount.address,
  });

  const anchorClient: any = createAaClient(anchorAccount);
  const deployedBefore = await isAccountDeployed(publicClient, anchorAccount.address);

  const inspectKernelBalance = async (mode: "create_and_register" | "update_weighted_signers") => {
    const kernelBalanceWei = await publicClient.getBalance({ address: anchorAccount.address });
    const kernelBalanceEth = formatEther(kernelBalanceWei);
    emit("kernel_balance_checked", {
      mode,
      kernelAddress: anchorAccount.address,
      kernelBalanceWei: kernelBalanceWei.toString(),
      kernelBalanceEth,
      sponsorshipMode: "selfhost_paymaster",
      paymasterAddressUsed,
    });
  };

  let weightedStorageBefore: WeightedStorageState | null = null;
  let weightedSignersBefore: WeightedSignerState[] = [];
  if (deployedBefore) {
    weightedStorageBefore = await readWeightedStorage(
      publicClient,
      anchorAccount.address,
      weightedValidatorAddress,
    );
    if (weightedStorageBefore && weightedStorageBefore.guardianLength > 0) {
      weightedSignersBefore = await readWeightedSigners(
        publicClient,
        anchorAccount.address,
        weightedValidatorAddress,
        weightedStorageBefore.guardianLength,
      );
    }
  }

  const weightedInitializedBefore = Boolean(
    weightedStorageBefore && weightedStorageBefore.guardianLength > 0,
  );
  const matchingSignerBefore = findSignerForCredential(weightedSignersBefore, {
    encodedPublicKey: encodedPasskeyPublicKey,
    authenticatorIdHash,
  });
  const webAuthnPermissionInstalledBefore = Boolean(matchingSignerBefore);
  if (matchingSignerBefore) {
    permissionId = derivePermissionIdFromEncodedPublicKey(matchingSignerBefore.encodedPublicKey);
  }

  emit("weighted_signer_state", {
    deployedBefore,
    weightedInitializedBefore,
    weightedValidatorAddress,
    weightedThreshold: weightedStorageBefore?.threshold || 0,
    weightedDelay: weightedStorageBefore?.delay || 0,
    weightedSignerCount: weightedSignersBefore.length,
    webAuthnPermissionInstalledBefore,
    permissionId,
  });

  let userOperationHash: Hex | null = null;

  if (!deployedBefore) {
    if (!encodedPasskeyPublicKey) {
      throw new Error("missing_wallet_passkey_metadata");
    }
    await inspectKernelBalance("create_and_register");
    emit("migrating_to_weighted_validator", {
      weightedValidatorAddress,
      mode: "create_and_register",
    });

    const weightedCreateConfig = buildCreateWeightedConfig(walletAddress, encodedPasskeyPublicKey);
    const weightedSigner = await toWeightedEcdsaSigner({ signer });
    const weightedValidator = await (createWeightedValidator as any)(
      kernelPublicClient as any,
      {
        config: weightedCreateConfig,
        signer: weightedSigner,
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_1,
        validatorContractVersion: WEIGHTED_VALIDATOR_VERSION,
        validatorAddress: weightedValidatorAddress,
      } as any,
    );

    emit("weighted_validator_ready", {
      weightedValidatorAddress,
      threshold: weightedCreateConfig.threshold,
      signerCount: weightedCreateConfig.signers.length,
      mode: "change_root_on_create",
    });

    const executionDelayPolicyAddress = await getExecutionDelayPolicyAddress(publicClient);
    const rootPolicy = toSudoPolicy({
      policyAddress: executionDelayPolicyAddress,
    } as any);
    const executionDelaySigner = await toPermissionEcdsaSigner({
      signer,
    } as any);
    const executionDelayValidator = await toPermissionValidator(
      kernelPublicClient as any,
      {
        entryPoint: ENTRY_POINT,
        signer: executionDelaySigner,
        kernelVersion: KERNEL_V3_1,
        policies: [rootPolicy],
      } as any,
    );
    emit("root_permission_validator_ready", {
      mode: "execution_delay_migration_on_create",
      rootPolicyAddress: executionDelayPolicyAddress,
    });

    const executorCall = await getInstallExecutorCallData(publicClient, anchorAccount.address);
    const setRootExecutionDelayCall = await getChangeRootValidatorCallData(
      anchorAccount.address,
      executionDelayValidator,
    );
    const registerCall = await getAccountCreateCallData(publicClient);
    const setRootWeightedCall = await getChangeRootValidatorCallData(
      anchorAccount.address,
      weightedValidator,
    );

    const callData = await anchorClient.account.encodeCalls([
      executorCall,
      setRootExecutionDelayCall,
      registerCall,
      setRootWeightedCall,
    ]);

    let createErrorFinal: any = null;

    for (
      let createAttempt = 1;
      createAttempt <= CREATE_AND_REGISTER_MAX_ATTEMPTS;
      createAttempt += 1
    ) {
      try {
        userOperationHash = await anchorClient.sendUserOperation({ callData } as any);
        emit("user_operation_sent", {
          hash: userOperationHash,
          mode: "create_and_register_weighted",
          attempt: createAttempt,
          maxAttempts: CREATE_AND_REGISTER_MAX_ATTEMPTS,
        });
        emit("waiting_for_user_operation_receipt", {
          mode: "create_and_register_weighted",
          hash: userOperationHash,
          attempt: createAttempt,
          maxAttempts: CREATE_AND_REGISTER_MAX_ATTEMPTS,
          timeoutMs: USER_OPERATION_RECEIPT_TIMEOUT_MS,
          hardTimeoutMs: USER_OPERATION_RECEIPT_HARD_TIMEOUT_MS,
        });

        const createReceipt = await withTimeout(
          anchorClient.waitForUserOperationReceipt({
            hash: userOperationHash,
            timeout: USER_OPERATION_RECEIPT_TIMEOUT_MS,
          }),
          USER_OPERATION_RECEIPT_HARD_TIMEOUT_MS,
          `create_and_register_weighted_receipt_timeout_after_${USER_OPERATION_RECEIPT_HARD_TIMEOUT_MS}ms`,
        );
        assertUserOperationReceiptSuccessful(createReceipt, "create_and_register_weighted");
        createErrorFinal = null;
        break;
      } catch (createError: unknown) {
        createErrorFinal = createError;
        const createMessage = errMsg(createError);

        emit("user_operation_receipt_failed", {
          mode: "create_and_register_weighted",
          hash: userOperationHash,
          attempt: createAttempt,
          maxAttempts: CREATE_AND_REGISTER_MAX_ATTEMPTS,
          message: getErrorSummary(createMessage).slice(0, 240),
        });

        const { recovered: recoveredSigner } = await findCredentialAfterFailure(
          publicClient,
          anchorAccount.address,
          weightedValidatorAddress,
          { encodedPublicKey: encodedPasskeyPublicKey, authenticatorIdHash },
        );
        if (recoveredSigner) {
          permissionId = derivePermissionIdFromEncodedPublicKey(recoveredSigner.encodedPublicKey);
          emit("post_receipt_failure_recovered", {
            mode: "create_and_register_weighted",
            kernel: shortAddress(anchorAccount.address),
            kernelAddress: anchorAccount.address,
            permissionId,
          });
          createErrorFinal = null;
          break;
        }

        if (
          createAttempt < CREATE_AND_REGISTER_MAX_ATTEMPTS &&
          isUserOperationReceiptTimeoutError(createMessage)
        ) {
          emit("retrying_create_and_register_after_timeout", {
            mode: "create_and_register_weighted",
            attempt: createAttempt + 1,
            maxAttempts: CREATE_AND_REGISTER_MAX_ATTEMPTS,
            previousError: getErrorSummary(createMessage).slice(0, 240),
          });
          await sleep(1_000);
          continue;
        }

        break;
      }
    }

    if (createErrorFinal) {
      throw createErrorFinal;
    }
  } else {
    if (!weightedInitializedBefore) {
      emit("weighted_validator_not_initialized", {
        weightedValidatorAddress,
      });
      throw new Error("existing_account_not_weighted_validator_initialized");
    }

    if (webAuthnPermissionInstalledBefore) {
      emit("already_ready", {
        mode: bootstrapMode,
        weightedValidatorAddress,
        weightedSignerCount: weightedSignersBefore.length,
      });
    } else {
      if (bootstrapMode !== "add_credential") {
        throw new Error("credential_not_installed_for_selected_credid");
      }
      if (!encodedPasskeyPublicKey) {
        throw new Error("missing_wallet_passkey_metadata");
      }

      const { weightedConfig: currentConfig, weightedClient } =
        await createCurrentWeightedAccountRuntime(runtime);
      const nextConfig = buildUpdatedWeightedConfig(currentConfig, encodedPasskeyPublicKey);
      await inspectKernelBalance("update_weighted_signers");

      emit("updating_weighted_signers", {
        weightedValidatorAddress,
        previousSignerCount: currentConfig.signers.length,
        nextSignerCount: nextConfig.signers.length,
        threshold: nextConfig.threshold,
        delay: nextConfig.delay || 0,
      });

      let updateErrorFinal: any = null;

      for (
        let updateAttempt = 1;
        updateAttempt <= UPDATE_SIGNERS_MAX_ATTEMPTS;
        updateAttempt += 1
      ) {
        try {
          const renewData = encodeWeightedRenewData(nextConfig);
          const renewCallData = encodeFunctionData({
            abi: WeightedValidatorWriteAbi,
            functionName: "renew",
            args: [renewData],
          });
          const callData = await weightedClient.account.encodeCalls([
            {
              to: weightedValidatorAddress,
              value: 0n,
              data: renewCallData,
            },
          ]);
          userOperationHash = await sendUserOperationWithSignatures(weightedClient, {
            sender: anchorAccount.address,
            callData,
            signatures: [],
          } as any);

          emit("user_operation_sent", {
            hash: userOperationHash,
            mode: "weighted_renew_signers",
            attempt: updateAttempt,
            maxAttempts: UPDATE_SIGNERS_MAX_ATTEMPTS,
          });
          emit("waiting_for_user_operation_receipt", {
            mode: "weighted_renew_signers",
            hash: userOperationHash,
            attempt: updateAttempt,
            maxAttempts: UPDATE_SIGNERS_MAX_ATTEMPTS,
            timeoutMs: USER_OPERATION_RECEIPT_TIMEOUT_MS,
            hardTimeoutMs: USER_OPERATION_RECEIPT_HARD_TIMEOUT_MS,
          });

          const updateReceipt = await withTimeout(
            weightedClient.waitForUserOperationReceipt({
              hash: userOperationHash,
              timeout: USER_OPERATION_RECEIPT_TIMEOUT_MS,
            }),
            USER_OPERATION_RECEIPT_HARD_TIMEOUT_MS,
            `weighted_update_receipt_timeout_after_${USER_OPERATION_RECEIPT_HARD_TIMEOUT_MS}ms`,
          );
          assertUserOperationReceiptSuccessful(updateReceipt, "weighted_update_signers");

          updateErrorFinal = null;
          break;
        } catch (updateError: unknown) {
          updateErrorFinal = updateError;
          const updateMessage = errMsg(updateError);

          emit("user_operation_receipt_failed", {
            mode: "weighted_renew_signers",
            hash: userOperationHash,
            attempt: updateAttempt,
            maxAttempts: UPDATE_SIGNERS_MAX_ATTEMPTS,
            message: getErrorSummary(updateMessage).slice(0, 240),
          });

          const { signers: signersAfterFailure, recovered: recoveredSigner } =
            await findCredentialAfterFailure(
              publicClient,
              anchorAccount.address,
              weightedValidatorAddress,
              {
                encodedPublicKey: encodedPasskeyPublicKey,
                authenticatorIdHash,
              },
            );
          if (recoveredSigner) {
            permissionId = derivePermissionIdFromEncodedPublicKey(recoveredSigner.encodedPublicKey);
            emit("weighted_signers_updated", {
              weightedValidatorAddress,
              signerCount: signersAfterFailure.length,
              recoveredAfterTimeout: true,
            });
            updateErrorFinal = null;
            break;
          }

          if (
            updateAttempt < UPDATE_SIGNERS_MAX_ATTEMPTS &&
            isUserOperationReceiptTimeoutError(updateMessage)
          ) {
            emit("retrying_weighted_signer_update_after_timeout", {
              attempt: updateAttempt + 1,
              maxAttempts: UPDATE_SIGNERS_MAX_ATTEMPTS,
              previousError: getErrorSummary(updateMessage).slice(0, 240),
            });
            await sleep(1_000);
            continue;
          }

          break;
        }
      }

      if (updateErrorFinal) {
        throw updateErrorFinal;
      }
    }
  }

  let weightedStorageAfter: WeightedStorageState | null = null;
  let weightedSignersAfter: WeightedSignerState[] = [];
  let webAuthnPermissionInstalledAfter = false;

  for (
    let verifyAttempt = 1;
    verifyAttempt <= WEIGHTED_SIGNER_VISIBILITY_MAX_ATTEMPTS;
    verifyAttempt += 1
  ) {
    weightedStorageAfter = await readWeightedStorage(
      publicClient,
      anchorAccount.address,
      weightedValidatorAddress,
    );
    weightedSignersAfter =
      weightedStorageAfter && weightedStorageAfter.guardianLength > 0
        ? await readWeightedSigners(
            publicClient,
            anchorAccount.address,
            weightedValidatorAddress,
            weightedStorageAfter.guardianLength,
          )
        : [];

    const matchingSignerAfter = findSignerForCredential(weightedSignersAfter, {
      encodedPublicKey: encodedPasskeyPublicKey,
      authenticatorIdHash,
    });
    webAuthnPermissionInstalledAfter = Boolean(matchingSignerAfter);
    if (matchingSignerAfter) {
      permissionId = derivePermissionIdFromEncodedPublicKey(matchingSignerAfter.encodedPublicKey);
    }
    if (webAuthnPermissionInstalledAfter) {
      break;
    }

    if (verifyAttempt < WEIGHTED_SIGNER_VISIBILITY_MAX_ATTEMPTS) {
      const waitMs = getWeightedSignerVisibilityWaitMs(verifyAttempt);
      emit("waiting_for_weighted_signer_visibility", {
        attempt: verifyAttempt,
        maxAttempts: WEIGHTED_SIGNER_VISIBILITY_MAX_ATTEMPTS,
        waitMs,
        weightedSignerCount: weightedSignersAfter.length,
        weightedThreshold: weightedStorageAfter?.threshold || 0,
        weightedDelay: weightedStorageAfter?.delay || 0,
        weightedGuardianLength: weightedStorageAfter?.guardianLength || 0,
      });
      await sleep(waitMs);
    }
  }

  if (!webAuthnPermissionInstalledAfter) {
    emit("weighted_signer_visibility_timeout", {
      weightedSignerCount: weightedSignersAfter.length,
      weightedThreshold: weightedStorageAfter?.threshold || 0,
      weightedDelay: weightedStorageAfter?.delay || 0,
      weightedGuardianLength: weightedStorageAfter?.guardianLength || 0,
      attempts: WEIGHTED_SIGNER_VISIBILITY_MAX_ATTEMPTS,
    });
    throw new Error("weighted_signer_not_installed");
  }

  emit("completed", {
    kernel: shortAddress(anchorAccount.address),
    kernelAddress: anchorAccount.address,
    weightedValidatorAddress,
    weightedSignerCount: weightedSignersAfter.length,
    userOperationHash,
    sponsorshipMode: "selfhost_paymaster",
    paymasterAddressUsed: paymasterAddress,
  });

  return {
    ok: true,
    walletAddress,
    kernelAddress: anchorAccount.address,
    aaProvider: "selfhost",
    bootstrapMode,
    chainId,
    publicRpcUrlUsed: explicitPublicRpcUrl,
    bundlerRpcUrlUsed: bundlerRpcUrl,
    sponsorshipMode: "selfhost_paymaster",
    paymasterAddressUsed: paymasterAddress,
    deployedBefore,
    webAuthnPermissionInstalledBefore,
    webAuthnPermissionInstalledAfter,
    userOperationHash,
    permissionId,
    rpId: walletPasskeyRpId,
  };
};
