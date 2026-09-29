// lib/wirex/registerVerification.ts
//
// Client-side verification of the Wirex register UserOp BEFORE signing.
//
// The backend (nuri-wirex-mcp src/aa-register.mjs) prepares the registration
// UserOp — Kernel deploy + installModule(FundsManagement) + changeRootValidator
// (ExecutionDelayPolicy) + createUserAccountWithWallet(partnerId) and, when the
// app supplied its wallet passkey, a final changeRootValidator to the weighted
// validator holding EOA + passkey (threshold 100, weights 100/100). The app
// only receives the userOpHash to sign plus the raw callData
// (register_call_data). That batch can GRANT SIGNING POWER over the smart
// account, so the app must never sign it blind: this module rebuilds the
// expected callData locally from the app's own inputs (EOA address, wallet
// passkey credential) and byte-compares it with what the server sent. Any
// mismatch aborts the flow before the signature exists.
//
// Rebuild path mirrors the server 1:1 (which itself mirrors the app's
// on-device bootstrap in aaBootstrapSelfhost.ts). Read-only: public RPC only —
// no bundler, no paymaster, no biometric, no signing.
//
// LIMITATION (known, accepted): the signed userOpHash covers the FULL UserOp
// (nonce, initCode, gas, paymaster fields), not just callData. Byte-matching
// callData catches a swapped/extended signer set and encoding drift, but full
// binding needs the server to return the whole UserOp so the app can recompute
// the hash itself. TODO(wirex): extend the server contract, verify the hash.

import {
  concatHex,
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { toAccount } from "viem/accounts";
import { BASE_RPC_URL, WIREX_CONTRACT_REGISTRY, WIREX_PARTNER_ID } from "../../config/network";
import { BASE_VIEM_CHAIN } from "../rpc/baseRpc";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createKernelAccount, KernelV3_1AccountAbi } from "@zerodev/sdk";
import { KERNEL_V3_1, VALIDATOR_TYPE } from "@zerodev/sdk/constants";
import { toPermissionValidator } from "@zerodev/permissions";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { toECDSASigner as toPermissionEcdsaSigner } from "@zerodev/permissions/signers";
import {
  createWeightedValidator,
  getValidatorAddress as getWeightedValidatorAddress,
  toECDSASigner as toWeightedEcdsaSigner,
} from "@zerodev/weighted-validator";
import { encodeWebAuthnPubKey } from "@zerodev/webauthn-key";

import { WALLET_RP_ID } from "../../config/passkey";
import { base64urlToBytes, bytesToHex } from "../crypto";
import { errMsg } from "../errorMessage";
import {
  ENTRY_POINT,
  WEIGHTED_DEFAULT_SIGNER_WEIGHT,
  WEIGHTED_DEFAULT_THRESHOLD,
  WEIGHTED_VALIDATOR_VERSION,
  resolveSelfhostWirexContractAddresses,
} from "./aaSelfhostClient";
import { normalizePasskeyPublicKeyForAaBootstrapSelfhost } from "./aaBootstrapSelfhost";

// Read-only public RPC for register-calldata verification, on the active
// Base network (config/network).
const PUBLIC_RPC_URL = BASE_RPC_URL;

// Server-side prepareRegistration builds one of three call lists; we accept a
// match against any variant that is plausible for the flags we were given.
export type RegisterCallDataVariant =
  | "fresh_with_passkey" // install → delay-root → register → weighted-root
  | "fresh_eoa_only" // install → delay-root → register
  | "already_registered"; // register only (no factory, no re-setup)

export interface RegisterVerificationInput {
  eoaAddress: string;
  expectedCallData: string; // register_call_data from onboard/result
  passkeyIncluded: boolean; // passkey_signer_included from onboard/result
  passkeyCredIdB64u?: string;
  passkeyPubkeyB64u?: string;
}

export interface RegisterVerificationResult {
  ok: boolean;
  matchedVariant?: RegisterCallDataVariant;
  reason?: string;
}

// Same as the (unexported) helper in aaBootstrapSelfhost / server aa-register:
// validator id = type byte + right-padded identifier.
const getValidatorId = (validator: { validatorType: string; getIdentifier: () => Hex }): Hex =>
  concatHex([
    (VALIDATOR_TYPE as Record<string, Hex>)[validator.validatorType],
    pad(validator.getIdentifier(), { size: 20, dir: "right" }),
  ]);

// Minimal ABI (public interface); also defined locally in aaBootstrapSelfhost.
const AccountsAbi = [
  {
    inputs: [{ internalType: "bytes16", name: "parentEntity", type: "bytes16" }],
    name: "createUserAccountWithWallet",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// Exposes the EOA address to the ZeroDev builders without any signing
// capability — verification is read-only by construction.
const addressOnlySigner = (address: Address) => {
  const fail = async (): Promise<never> => {
    throw new Error("register_verification_signer_never_signs");
  };
  return toAccount({
    address,
    signMessage: fail,
    signTransaction: fail,
    signTypedData: fail,
  });
};

type Call = { to: Address; value: bigint; data: Hex };

export async function verifyRegisterCallData(
  input: RegisterVerificationInput,
): Promise<RegisterVerificationResult> {
  const expected = String(input.expectedCallData || "")
    .trim()
    .toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(expected) || expected.length < 10) {
    return { ok: false, reason: "register_call_data_missing_or_malformed" };
  }

  try {
    const eoa = input.eoaAddress as Address;
    const publicClient = createPublicClient({
      chain: BASE_VIEM_CHAIN,
      transport: http(PUBLIC_RPC_URL),
    });
    const signer = addressOnlySigner(eoa);

    // Counterfactual Kernel account — same derivation as the server's
    // buildAccount (ECDSA root validator over the EOA).
    // biome-ignore lint/suspicious/noExplicitAny: ZeroDev builder generics don't line up across subpackages; the debug bootstrap uses the same escape hatch.
    const ecdsaValidator = await (signerToEcdsaValidator as any)(publicClient, {
      entryPoint: ENTRY_POINT,
      signer,
      kernelVersion: KERNEL_V3_1,
    });
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const account: any = await (createKernelAccount as any)(publicClient, {
      entryPoint: ENTRY_POINT,
      kernelVersion: KERNEL_V3_1,
      plugins: { sudo: ecdsaValidator },
    });
    const kernelAddress = account.address as Address;

    const { fundsManagementAddress, accountsAddress, executionDelayPolicyAddress } =
      await resolveSelfhostWirexContractAddresses(publicClient, WIREX_CONTRACT_REGISTRY);

    // Call 1 — installModule(FundsManagement).
    const installCall: Call = {
      to: kernelAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: KernelV3_1AccountAbi,
        functionName: "installModule",
        args: [
          2n,
          fundsManagementAddress,
          concatHex([
            zeroAddress,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          ]),
        ],
      }),
    };

    // Call 2 — changeRootValidator(ExecutionDelayPolicy permission validator).
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const delaySigner: any = await (toPermissionEcdsaSigner as any)({ signer });
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const delayValidator: any = await (toPermissionValidator as any)(publicClient, {
      entryPoint: ENTRY_POINT,
      signer: delaySigner,
      kernelVersion: KERNEL_V3_1,
      policies: [toSudoPolicy({ policyAddress: executionDelayPolicyAddress })],
    });
    const delayRootCall: Call = {
      to: kernelAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: KernelV3_1AccountAbi,
        functionName: "changeRootValidator",
        args: [
          getValidatorId(delayValidator),
          zeroAddress,
          await delayValidator.getEnableData(kernelAddress),
          "0x",
        ],
      }),
    };

    // Call 3 — createUserAccountWithWallet(partnerId) on the Accounts contract.
    const registerCall: Call = {
      to: accountsAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: AccountsAbi,
        functionName: "createUserAccountWithWallet",
        args: [WIREX_PARTNER_ID],
      }),
    };

    // Call 4 (only when the server reported the passkey install) —
    // changeRootValidator(weighted validator holding EOA + passkey).
    let weightedRootCall: Call | null = null;
    if (input.passkeyIncluded) {
      const credIdB64u = String(input.passkeyCredIdB64u || "").trim();
      const pubkeyB64u = String(input.passkeyPubkeyB64u || "").trim();
      if (!credIdB64u || !pubkeyB64u) {
        return { ok: false, reason: "passkey_included_but_local_metadata_missing" };
      }
      const { pubX, pubY } = normalizePasskeyPublicKeyForAaBootstrapSelfhost(pubkeyB64u);
      const credIdBytes = base64urlToBytes(credIdB64u);
      const encodedPubKey = encodeWebAuthnPubKey({
        pubX,
        pubY,
        authenticatorId: credIdB64u,
        authenticatorIdHash: keccak256(`0x${bytesToHex(credIdBytes)}` as Hex),
        rpID: WALLET_RP_ID,
      });
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      const weightedSigner: any = await (toWeightedEcdsaSigner as any)({ signer });
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      const weightedValidator: any = await (createWeightedValidator as any)(publicClient, {
        config: {
          threshold: WEIGHTED_DEFAULT_THRESHOLD,
          delay: 0,
          signers: [
            { publicKey: eoa, weight: WEIGHTED_DEFAULT_SIGNER_WEIGHT },
            { publicKey: encodedPubKey, weight: WEIGHTED_DEFAULT_SIGNER_WEIGHT },
          ],
        },
        signer: weightedSigner,
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_1,
        validatorContractVersion: WEIGHTED_VALIDATOR_VERSION,
        validatorAddress: getWeightedValidatorAddress(
          // biome-ignore lint/suspicious/noExplicitAny: see above.
          (ENTRY_POINT as any).version,
          WEIGHTED_VALIDATOR_VERSION,
        ),
      });
      weightedRootCall = {
        to: kernelAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: KernelV3_1AccountAbi,
          functionName: "changeRootValidator",
          args: [
            getValidatorId(weightedValidator),
            zeroAddress,
            await weightedValidator.getEnableData(kernelAddress),
            "0x",
          ],
        }),
      };
    }

    const candidates: Array<{ variant: RegisterCallDataVariant; calls: Call[] }> =
      input.passkeyIncluded && weightedRootCall
        ? [
            {
              variant: "fresh_with_passkey",
              calls: [installCall, delayRootCall, registerCall, weightedRootCall],
            },
          ]
        : [
            { variant: "fresh_eoa_only", calls: [installCall, delayRootCall, registerCall] },
            { variant: "already_registered", calls: [registerCall] },
          ];

    for (const candidate of candidates) {
      const encoded = String(await account.encodeCalls(candidate.calls)).toLowerCase();
      if (encoded === expected) {
        return { ok: true, matchedVariant: candidate.variant };
      }
    }
    return { ok: false, reason: "call_data_mismatch" };
  } catch (error: unknown) {
    // Fail CLOSED: an unverifiable batch (RPC down, unparseable inputs) must
    // not get signed — the caller aborts and the user can retry.
    return { ok: false, reason: `verification_error:${errMsg(error)}` };
  }
}
