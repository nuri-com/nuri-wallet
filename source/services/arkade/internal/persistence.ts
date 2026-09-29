// Persistence of "stable params" — the small set of pubkeys + CSV timelocks
// required to derive the boarding address offline (before the wallet boots).
// Cached in AsyncStorage scoped by the current passkey credId hash.
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { NetworkName } from "@arkade-os/sdk";
import { bytesToHex } from "../../../lib/bytes";
import { sha256 } from "../../../lib/crypto";
import { errMsg } from "../../../lib/errorMessage";
import { authStateManager } from "../../auth/AuthStateService";
import { scopeArkadeV4StorageKey } from "../ArkadeRecoveryBackupService";
import { ArkadeRemoteIdentity } from "../ArkadeRemoteIdentity";
import { emitTrace } from "./logging";
import { getArkadeClientRecoveryContractParamsForTimelock } from "./recoveryDefaults";
import type { ArkadeWallet } from "./types";
import { truncateForLog } from "./utils";

export type ArkadeStableParams = {
  arkadeServerPubKeyHex32: string;
  arkadeCsvTimelock: { type: "blocks" | "seconds"; value: string };
  nuriServerPubKeyHex33: string;
  nuriServerCsvTimelock: { type: "blocks" | "seconds"; value: string };
  networkName: NetworkName;
  updatedAtMs: number;
};

let cachedStableParams: ArkadeStableParams | null = null;
let cachedStableParamsLoaded = false;
let cachedStableParamsKey = "";

function getStableParamsCacheKey(): string {
  const credId = String(
    authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u || "missing_cred",
  );
  const credHash = bytesToHex(sha256(new TextEncoder().encode(credId))).slice(0, 16);
  return scopeArkadeV4StorageKey(`stable-params:${credHash}`);
}

function cloneStableParams(params: ArkadeStableParams): ArkadeStableParams {
  return {
    arkadeServerPubKeyHex32: params.arkadeServerPubKeyHex32,
    arkadeCsvTimelock: { ...params.arkadeCsvTimelock },
    nuriServerPubKeyHex33: params.nuriServerPubKeyHex33,
    nuriServerCsvTimelock: { ...params.nuriServerCsvTimelock },
    networkName: params.networkName,
    updatedAtMs: params.updatedAtMs,
  };
}

function isValidStableParams(value: unknown): value is ArkadeStableParams {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.arkadeServerPubKeyHex32 !== "string" ||
    !/^[0-9a-f]{64}$/.test(v.arkadeServerPubKeyHex32)
  ) {
    return false;
  }
  if (
    typeof v.nuriServerPubKeyHex33 !== "string" ||
    !/^[0-9a-f]{66}$/.test(v.nuriServerPubKeyHex33)
  ) {
    return false;
  }
  const ark = v.arkadeCsvTimelock as { type?: unknown; value?: unknown } | undefined;
  const nuri = v.nuriServerCsvTimelock as { type?: unknown; value?: unknown } | undefined;
  if (!ark || (ark.type !== "blocks" && ark.type !== "seconds") || typeof ark.value !== "string") {
    return false;
  }
  if (
    !nuri ||
    (nuri.type !== "blocks" && nuri.type !== "seconds") ||
    typeof nuri.value !== "string"
  ) {
    return false;
  }
  const nn = v.networkName;
  if (
    nn !== "bitcoin" &&
    nn !== "testnet" &&
    nn !== "signet" &&
    nn !== "mutinynet" &&
    nn !== "regtest"
  ) {
    return false;
  }
  return true;
}

export async function readCachedStableParams(): Promise<ArkadeStableParams | null> {
  const cacheKey = getStableParamsCacheKey();
  if (cachedStableParamsKey && cachedStableParamsKey !== cacheKey) {
    cachedStableParams = null;
    cachedStableParamsLoaded = false;
  }
  cachedStableParamsKey = cacheKey;
  if (cachedStableParamsLoaded) {
    return cachedStableParams ? cloneStableParams(cachedStableParams) : null;
  }
  cachedStableParamsLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidStableParams(parsed)) return null;
    cachedStableParams = cloneStableParams(parsed);
    return cloneStableParams(cachedStableParams);
  } catch (error: unknown) {
    emitTrace({
      atMs: Date.now(),
      op: "stable_params_cache",
      status: "read_failed",
      detail: truncateForLog(errMsg(error, "unknown"), 160),
    });
    return null;
  }
}

function writeCachedStableParams(params: ArkadeStableParams): void {
  const cacheKey = getStableParamsCacheKey();
  cachedStableParams = cloneStableParams(params);
  cachedStableParamsLoaded = true;
  cachedStableParamsKey = cacheKey;
  void AsyncStorage.setItem(cacheKey, JSON.stringify(cachedStableParams)).catch(
    (error: unknown) => {
      emitTrace({
        atMs: Date.now(),
        op: "stable_params_cache",
        status: "write_failed",
        detail: truncateForLog(errMsg(error, "unknown"), 160),
      });
    },
  );
}

export function getCachedStableParamsSnapshot(): ArkadeStableParams | null {
  return cachedStableParams ? cloneStableParams(cachedStableParams) : null;
}

export function resetCachedStableParams(): void {
  cachedStableParams = null;
  cachedStableParamsLoaded = false;
  cachedStableParamsKey = "";
}

function networkNameFromWallet(wallet: ArkadeWallet): NetworkName {
  const direct = String((wallet as unknown as { networkName?: unknown })?.networkName || "").trim();
  if (
    direct === "bitcoin" ||
    direct === "testnet" ||
    direct === "signet" ||
    direct === "mutinynet" ||
    direct === "regtest"
  ) {
    return direct;
  }
  const bech32 = String((wallet?.network as unknown as { bech32?: unknown })?.bech32 || "").trim();
  if (bech32 === "bc") return "bitcoin";
  if (bech32 === "bcrt") return "regtest";
  if (bech32 === "tb") return "testnet";
  return "bitcoin";
}

export async function persistArkadeStableParams(wallet: ArkadeWallet): Promise<void> {
  try {
    const boardingOptions = (
      wallet.boardingTapscript as unknown as { options?: { csvTimelock?: unknown } }
    )?.options;
    const params = await getArkadeClientRecoveryContractParamsForTimelock(
      wallet as unknown as Parameters<typeof getArkadeClientRecoveryContractParamsForTimelock>[0],
      boardingOptions?.csvTimelock as Parameters<
        typeof getArkadeClientRecoveryContractParamsForTimelock
      >[1],
    );
    const identity = wallet.identity as ArkadeRemoteIdentity;
    const pubCtx = await identity.getSigningPublicContext();
    const nuriPk33Hex = String(pubCtx.serverPk33 || "").toLowerCase();
    if (!/^[0-9a-f]{66}$/.test(nuriPk33Hex)) {
      throw new Error("nuriServerPk33 wrong length");
    }
    const next: ArkadeStableParams = {
      arkadeServerPubKeyHex32: bytesToHex(params.arkadeServerPubKey).toLowerCase(),
      arkadeCsvTimelock: {
        type: params.arkadeCsvTimelock.type,
        value: String(params.arkadeCsvTimelock.value),
      },
      nuriServerPubKeyHex33: nuriPk33Hex,
      nuriServerCsvTimelock: {
        type: params.nuriServerCsvTimelock.type,
        value: String(params.nuriServerCsvTimelock.value),
      },
      networkName: networkNameFromWallet(wallet),
      updatedAtMs: Date.now(),
    };
    writeCachedStableParams(next);
  } catch (paramsErr: unknown) {
    emitTrace({
      atMs: Date.now(),
      op: "stable_params_cache",
      status: "write_failed",
      detail: truncateForLog(errMsg(paramsErr, "unknown"), 160),
    });
  }
}
