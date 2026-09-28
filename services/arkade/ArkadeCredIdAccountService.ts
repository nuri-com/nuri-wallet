// Prod-tier service: per-credential-ID arkade account operations used by the
// migration flow. The functions here are intentionally credId-scoped (they
// skip the ambient `ArkadeRemoteIdentity` singleton) so a freshly-created
// passkey can claim a username, fetch server info, and derive a boarding
// address BEFORE the keychain swap that makes it the ambient identity.
//
// Cross-cutting helpers (emitTrace, truncateForLog, getOrCreateWallet,
// hexToBytesLocal, normalizeArkadeRelativeTimelock) are imported back from
// the legacy debug service during the prod/debug migration.

import { networks as arkadeNetworks } from "@arkade-os/sdk";
import {
  arkadeAuthBegin,
  arkadeInfo,
  arkadeLnurlRegister,
  type ArkadeRecoveryStatus,
  type ArkadeRelativeTimelock,
} from "./ArkadeApiService";
import {
  ArkadeClientRecoveryVtxoScript,
  type ArkadeClientRecoveryContractParams,
} from "./ArkadeClientRecoveryContract";
import { arkadeServerConfigService } from "./ArkadeServerConfigService";
import { normalizeLnurlUsername } from "./ArkadeLnurlService";
import { emitTrace } from "./internal/logging";
import { fetchArkNodeInfoWithRetry, inferArkadeNetwork } from "./internal/network";
import {
  getCachedStableParamsSnapshot,
  readCachedStableParams,
  type ArkadeStableParams,
} from "./internal/persistence";
import { normalizeArkadeRelativeTimelock } from "./internal/timelocks";
import { hexToBytesLocal, truncateForLog } from "./internal/utils";
import { getOrCreateWallet } from "./internal/walletCache";
import { UsernameAlreadyClaimedError } from "./types/errors";
import type { ArkadeLnurlStatus } from "./types/lnurl";

type ClaimArkadeLnurlUsernameForCredIdParams = {
  username: string;
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientPk33Hex: string;
  aggregatedPk33Hex: string;
  /** Pre-acquired WebAuthn assertion (clientData/authData/sig). */
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
  /** Auth token returned by `arkadeAuthBegin`. */
  authToken: string;
};

type MigrationBoardingStableParams = Pick<
  ArkadeStableParams,
  "arkadeServerPubKeyHex32" | "arkadeCsvTimelock" | "networkName"
>;

function assertXOnlyPubkeyBytes(valueHex: string, field: string): Uint8Array {
  const normalized = String(valueHex || "")
    .trim()
    .toLowerCase();
  const xOnlyHex = /^[0-9a-f]{66}$/.test(normalized)
    ? normalized.slice(2)
    : /^[0-9a-f]{64}$/.test(normalized)
      ? normalized
      : "";
  if (!xOnlyHex) {
    throw new Error(`${field}: expected 32-byte x-only or 33-byte compressed pubkey`);
  }
  const bytes = hexToBytesLocal(xOnlyHex);
  if (bytes.length !== 32) {
    throw new Error(`${field}: x-only pubkey length mismatch`);
  }
  return bytes;
}

function bytesToHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function resolveArkadeNetworkName(
  rawNetwork: string,
  nodeUrl: string,
): keyof typeof arkadeNetworks {
  const networkName = String(rawNetwork || "")
    .trim()
    .toLowerCase();
  if (networkName in arkadeNetworks) {
    return networkName as keyof typeof arkadeNetworks;
  }
  const inferred = inferArkadeNetwork(nodeUrl);
  if (inferred in arkadeNetworks) {
    return inferred as keyof typeof arkadeNetworks;
  }
  throw new Error(`migration boarding: unsupported arkade network ${networkName || inferred}`);
}

async function resolveMigrationBoardingStableParams(): Promise<MigrationBoardingStableParams> {
  const cached = getCachedStableParamsSnapshot() || (await readCachedStableParams());
  if (cached) {
    return {
      arkadeServerPubKeyHex32: cached.arkadeServerPubKeyHex32,
      arkadeCsvTimelock: { ...cached.arkadeCsvTimelock },
      networkName: cached.networkName,
    };
  }

  const nodeUrl = arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, "");
  const info = await fetchArkNodeInfoWithRetry(nodeUrl);
  const boardingDelay = info.boardingExitDelay;
  if (typeof boardingDelay !== "bigint" || boardingDelay <= 0n) {
    throw new Error("migration boarding: arkade boardingExitDelay unavailable");
  }
  return {
    arkadeServerPubKeyHex32: bytesToHexLocal(
      assertXOnlyPubkeyBytes(info.signerPubkey, "arkade signer pubkey"),
    ).toLowerCase(),
    arkadeCsvTimelock: {
      type: boardingDelay < 512n ? "blocks" : "seconds",
      value: String(boardingDelay),
    },
    networkName: resolveArkadeNetworkName(String(info.network || ""), nodeUrl),
  };
}

/**
 * Migration variant of `claimArkadeLnurlUsername`. The caller is expected to
 * have already run `arkadeAuthBegin` + a WebAuthn assertion ceremony for the
 * NEW credId, and is passing the resulting assertion fields here. We just
 * POST `/arkade/lnurl/register`.
 *
 * On HTTP 400 the server treats both "invalid username" and "username
 * already claimed" the same way — we surface the latter as a typed error so
 * the migration sheet can roll back to the picker.
 */
export async function claimArkadeLnurlUsernameForCredId(
  params: ClaimArkadeLnurlUsernameForCredIdParams,
): Promise<ArkadeLnurlStatus> {
  const normalized = normalizeLnurlUsername(params.username);
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(normalized)) {
    throw new Error("username must be 3-32 chars [a-z0-9._-]");
  }
  emitTrace({
    atMs: Date.now(),
    op: "lnurl_register_migration",
    status: "attempt",
    detail: `username=${normalized} credId=${truncateForLog(params.credIdB64u, 12)}`,
  });
  try {
    await arkadeLnurlRegister(
      {
        token: params.authToken,
        clientDataB64u: params.clientDataB64u,
        authDataB64u: params.authDataB64u,
        sigB64u: params.sigB64u,
      },
      {
        username: normalized,
        client_pk33: params.clientPk33Hex,
        aggregated_pk33: params.aggregatedPk33Hex,
      },
    );
  } catch (error: unknown) {
    const message = String((error as { message?: unknown })?.message || error || "unknown");
    // Server replies with http_400 message=... when username is already
    // claimed; the regex is validated above so any 400 here is a conflict.
    if (/http_400/.test(message)) {
      emitTrace({
        atMs: Date.now(),
        op: "lnurl_register_migration",
        status: "conflict",
        detail: `username=${normalized} message=${truncateForLog(message, 160)}`,
      });
      throw new UsernameAlreadyClaimedError(normalized);
    }
    throw error;
  }
  emitTrace({
    atMs: Date.now(),
    op: "lnurl_register_migration",
    status: "ok",
    detail: `username=${normalized}`,
  });

  // After registration the cached lnurl status corresponds to the OLD
  // identity. Build a synthetic status entry so callers don't depend on the
  // ambient identity to surface "registered: true" — actual status refresh
  // happens after the migration completes (keychain swap → next login picks
  // up the new credId's cache).
  const status: ArkadeLnurlStatus = {
    username: normalized,
    registered: true,
    lightningAddress: `${normalized}@nuri.com`,
    evmAddress: null,
    arkadeAddress: null,
    btcAddress: null,
    email: null,
    lnurlpUrl: null,
    callbackUrl: null,
    minSendableMsat: 0,
    maxSendableMsat: 0,
    hasPublishedInvoice: false,
    invoiceExpiresAtMs: 0,
  };
  return status;
}

/**
 * Mint a fresh `auth_begin` token + WebAuthn challenge for a given credId,
 * skipping the singleton `ArkadeRemoteIdentity` cache. Used during the
 * migration username-claim step so the assertion is bound to the NEW
 * credId, not the still-current ambient one.
 */
export async function arkadeAuthBeginForCredId(params: {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientSignerPubkeyHex: string;
}): Promise<{ token: string; challenge: string; rpId: string }> {
  const out = await arkadeAuthBegin({
    credIdB64u: params.credIdB64u,
    credPubkeyB64u: params.credPubkeyB64u,
    clientSignerPubkeyHex: params.clientSignerPubkeyHex,
  });
  return {
    token: out.token,
    challenge: out.challenge,
    rpId: out.rp_id,
  };
}

/**
 * Direct `arkade/info` call for a given credId, skipping ambient identity.
 * Returns the raw `server_pubkey` (33-byte hex) needed to aggregate with the
 * new client pk for the migration's `keys_derived` stage, plus the
 * `nuri_server_csv` timelock needed for boarding-address derivation.
 */
export async function arkadeInfoForCredId(params: {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientSignerPubkeyHex: string;
}): Promise<{
  serverPubkeyHex: string;
  nuriServerCsv: ArkadeRelativeTimelock | null;
}> {
  const out = await arkadeInfo({
    credIdB64u: params.credIdB64u,
    credPubkeyB64u: params.credPubkeyB64u,
    clientSignerPubkeyHex: params.clientSignerPubkeyHex,
  });
  const serverPubkeyHex = String(out.server_pubkey || "").toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(serverPubkeyHex)) {
    throw new Error("arkadeInfoForCredId: malformed server_pubkey");
  }
  const nuriServerCsv =
    normalizeArkadeRelativeTimelock(out.nuri_server_csv) ||
    normalizeArkadeRelativeTimelock(out.recovery_policy?.nuri_server_csv) ||
    normalizeArkadeRelativeTimelock(out.cosigner_derivation?.nuri_server_csv) ||
    normalizeArkadeRelativeTimelock(out.cosigner_derivation?.recovery_policy?.nuri_server_csv);
  return {
    serverPubkeyHex,
    nuriServerCsv,
  };
}

/**
 * Migration-only boarding address derivation. This intentionally does NOT call
 * `getOrCreateWallet()`: BTC migration must stay on the legacy v1 signer path
 * until the final keychain swap makes the new Arkade identity ambient.
 */
export async function deriveMigrationBoardingAddressForCredId(params: {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientPk33Hex: string;
  aggregatedPk33Hex: string;
}): Promise<string> {
  const [stable, info] = await Promise.all([
    resolveMigrationBoardingStableParams(),
    arkadeInfoForCredId({
      credIdB64u: params.credIdB64u,
      credPubkeyB64u: params.credPubkeyB64u,
      clientSignerPubkeyHex: params.clientPk33Hex,
    }),
  ]);
  if (!info.nuriServerCsv) {
    throw new Error("deriveMigrationBoardingAddressForCredId: nuri_server_csv unavailable");
  }

  const script = new ArkadeClientRecoveryVtxoScript({
    aggregatePubKey: assertXOnlyPubkeyBytes(
      params.aggregatedPk33Hex,
      "deriveMigrationBoardingAddressForCredId: aggregatedPk33Hex",
    ),
    clientPubKey: assertXOnlyPubkeyBytes(
      params.clientPk33Hex,
      "deriveMigrationBoardingAddressForCredId: clientPk33Hex",
    ),
    nuriServerPubKey: assertXOnlyPubkeyBytes(
      info.serverPubkeyHex,
      "deriveMigrationBoardingAddressForCredId: nuri server pubkey",
    ),
    arkadeServerPubKey: assertXOnlyPubkeyBytes(
      stable.arkadeServerPubKeyHex32,
      "deriveMigrationBoardingAddressForCredId: arkade server pubkey",
    ),
    arkadeCsvTimelock: {
      type: stable.arkadeCsvTimelock.type,
      value: BigInt(stable.arkadeCsvTimelock.value),
    } as ArkadeClientRecoveryContractParams["arkadeCsvTimelock"],
    nuriServerCsvTimelock: {
      type: info.nuriServerCsv.type,
      value: BigInt(info.nuriServerCsv.value),
    } as ArkadeClientRecoveryContractParams["nuriServerCsvTimelock"],
  });
  const network = arkadeNetworks[stable.networkName];
  const address = script.onchainAddress(network);
  if (typeof address !== "string" || !address) {
    throw new Error("deriveMigrationBoardingAddressForCredId: onchainAddress returned empty");
  }
  emitTrace({
    atMs: Date.now(),
    op: "migration_boarding_address_for_credid",
    status: "ok",
    detail: `addr=${truncateForLog(address, 28)} credId=${truncateForLog(params.credIdB64u, 12)}`,
  });
  return address;
}

/**
 * Fetch the server's recovery status for a credId. Returns null if the
 * server response carries no `recovery` block (older server build). Used by
 * the lab's CompatibilityBanner to surface the TRUTH about whether the
 * server has credPubkey on file — the local row's empty `newCredPubkey`
 * field is meaningless after the first /arkade/info call has succeeded.
 */
export async function arkadeRecoveryStatusForCredId(params: {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientSignerPubkeyHex: string;
}): Promise<ArkadeRecoveryStatus | null> {
  const out = await arkadeInfo({
    credIdB64u: params.credIdB64u,
    credPubkeyB64u: params.credPubkeyB64u,
    clientSignerPubkeyHex: params.clientSignerPubkeyHex,
  });
  return out.recovery ?? null;
}

/**
 * Derive the boarding (onchain) address for a NEW arkade identity, given
 * its credId + new aggregated/client pubkeys. Uses the network-level
 * constants (arkade server pubkey, boarding CSV, network) from the user's
 * CURRENT initialized wallet — these don't depend on credId.
 *
 * Migration BTC sweep target.
 */
export async function deriveBoardingAddressForCredId(params: {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientPk33Hex: string;
  aggregatedPk33Hex: string;
}): Promise<string> {
  const wallet = await getOrCreateWallet();
  const arkadeServerPubKey =
    (wallet.boardingTapscript?.options?.serverPubKey as Uint8Array | undefined) ||
    (wallet.arkServerPublicKey as Uint8Array | undefined);
  if (!(arkadeServerPubKey instanceof Uint8Array) || arkadeServerPubKey.length !== 32) {
    throw new Error("deriveBoardingAddressForCredId: arkade server pubkey unavailable");
  }
  const arkadeCsvTimelock = wallet.boardingTapscript?.options?.csvTimelock as
    | ArkadeClientRecoveryContractParams["arkadeCsvTimelock"]
    | undefined;
  if (
    !arkadeCsvTimelock ||
    (arkadeCsvTimelock.type !== "blocks" && arkadeCsvTimelock.type !== "seconds")
  ) {
    throw new Error("deriveBoardingAddressForCredId: boarding CSV timelock unavailable");
  }
  const info = await arkadeInfoForCredId({
    credIdB64u: params.credIdB64u,
    credPubkeyB64u: params.credPubkeyB64u,
    clientSignerPubkeyHex: params.clientPk33Hex,
  });
  if (!info.nuriServerCsv) {
    throw new Error("deriveBoardingAddressForCredId: nuri_server_csv unavailable");
  }
  const nuriServerCsvTimelock = {
    value: BigInt(info.nuriServerCsv.value),
    type: info.nuriServerCsv.type,
  } as ArkadeClientRecoveryContractParams["nuriServerCsvTimelock"];
  // Convert 33-byte compressed to 32-byte x-only by stripping the parity prefix.
  const clientXOnly = hexToBytesLocal(params.clientPk33Hex.slice(2));
  const aggregateXOnly = hexToBytesLocal(params.aggregatedPk33Hex.slice(2));
  const nuriServerXOnly = hexToBytesLocal(info.serverPubkeyHex.slice(2));
  if (clientXOnly.length !== 32 || aggregateXOnly.length !== 32 || nuriServerXOnly.length !== 32) {
    throw new Error("deriveBoardingAddressForCredId: x-only pubkey length mismatch");
  }
  const recoveryScript = new ArkadeClientRecoveryVtxoScript({
    aggregatePubKey: aggregateXOnly,
    clientPubKey: clientXOnly,
    nuriServerPubKey: nuriServerXOnly,
    arkadeServerPubKey,
    arkadeCsvTimelock,
    nuriServerCsvTimelock,
  });
  const address = recoveryScript.onchainAddress(wallet.network);
  if (typeof address !== "string" || !address) {
    throw new Error("deriveBoardingAddressForCredId: onchainAddress returned empty");
  }
  emitTrace({
    atMs: Date.now(),
    op: "boarding_address_for_credid",
    status: "ok",
    detail: `addr=${truncateForLog(address, 28)} credId=${truncateForLog(params.credIdB64u, 12)}`,
  });
  return address;
}
