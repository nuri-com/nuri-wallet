// In-memory + persisted snapshot cache for the Arkade LNURL status. Lives in
// internal/ so consumers like receiveAutoClaim and walletSummary can read the
// snapshot without importing the prod-tier ArkadeLnurlService (which would
// create a module cycle). The prod-tier service owns the live fetcher
// (`getArkadeLnurlStatus`) and uses `setCachedLnurlStatus` to write here.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { bytesToHex } from "../../../lib/bytes";
import { sha256 } from "../../../lib/crypto";
import { errMsg } from "../../../lib/errorMessage";
import { authStateManager } from "../../auth/AuthStateService";
import { scopeArkadeV4StorageKey } from "../ArkadeRecoveryBackupService";
import type { ArkadeLnurlStatus } from "../types/lnurl";
import { emitTrace } from "./logging";
import { truncateForLog } from "./utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

let cachedLnurlStatus: ArkadeLnurlStatus | null = null;
let cachedLnurlStatusLoaded = false;
let cachedLnurlStatusKey = "";

export function toLnurlStatus(out: unknown): ArkadeLnurlStatus {
  const record = isRecord(out) ? out : undefined;
  const username = record?.username;
  const registered = record?.registered;
  const lightningAddress =
    record?.lightningAddress !== undefined ? record.lightningAddress : record?.lightning_address;
  const lnurlpUrl = record?.lnurlpUrl !== undefined ? record.lnurlpUrl : record?.lnurlp_url;
  const callbackUrl = record?.callbackUrl !== undefined ? record.callbackUrl : record?.callback_url;
  const evmAddress = record?.evmAddress !== undefined ? record.evmAddress : record?.evm_address;
  const evmAddressVerified =
    record?.evmAddressVerified !== undefined
      ? record.evmAddressVerified
      : record?.evm_address_verified;
  const arkadeAddress =
    record?.arkadeAddress !== undefined ? record.arkadeAddress : record?.arkade_address;
  const btcAddress = record?.btcAddress !== undefined ? record.btcAddress : record?.btc_address;
  const email = record?.email;
  const minSendableMsat =
    record?.minSendableMsat !== undefined ? record.minSendableMsat : record?.min_sendable_msat;
  const maxSendableMsat =
    record?.maxSendableMsat !== undefined ? record.maxSendableMsat : record?.max_sendable_msat;
  const hasPublishedInvoice =
    record?.hasPublishedInvoice !== undefined
      ? record.hasPublishedInvoice
      : record?.has_published_invoice;
  const invoiceExpiresAtMs =
    record?.invoiceExpiresAtMs !== undefined
      ? record.invoiceExpiresAtMs
      : record?.invoice_expires_at_ms;
  return {
    username: username ? String(username) : null,
    registered: Boolean(registered),
    lightningAddress: lightningAddress ? String(lightningAddress) : null,
    lnurlpUrl: lnurlpUrl ? String(lnurlpUrl) : null,
    callbackUrl: callbackUrl ? String(callbackUrl) : null,
    evmAddress: evmAddress ? String(evmAddress) : null,
    evmAddressVerified: evmAddressVerified === true,
    arkadeAddress: arkadeAddress ? String(arkadeAddress) : null,
    btcAddress: btcAddress ? String(btcAddress) : null,
    email: email ? String(email) : null,
    minSendableMsat: Number(minSendableMsat || 0),
    maxSendableMsat: Number(maxSendableMsat || 0),
    hasPublishedInvoice: Boolean(hasPublishedInvoice),
    invoiceExpiresAtMs: Number(invoiceExpiresAtMs || 0),
  };
}

function cloneLnurlStatus(status: ArkadeLnurlStatus): ArkadeLnurlStatus {
  return { ...status };
}

function isUsefulLnurlStatus(status: ArkadeLnurlStatus | null): status is ArkadeLnurlStatus {
  return Boolean(status?.registered || status?.username || status?.lightningAddress);
}

function getLnurlStatusCacheKey(): string {
  const credId = String(
    authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u || "missing_cred",
  );
  const credHash = bytesToHex(sha256(new TextEncoder().encode(credId))).slice(0, 16);
  return scopeArkadeV4StorageKey(`lnurl-status-cache:${credHash}`);
}

export async function readCachedLnurlStatus(): Promise<ArkadeLnurlStatus | null> {
  const cacheKey = getLnurlStatusCacheKey();
  if (cachedLnurlStatusKey && cachedLnurlStatusKey !== cacheKey) {
    cachedLnurlStatus = null;
    cachedLnurlStatusLoaded = false;
  }
  cachedLnurlStatusKey = cacheKey;
  if (cachedLnurlStatusLoaded) {
    return cachedLnurlStatus ? cloneLnurlStatus(cachedLnurlStatus) : null;
  }
  cachedLnurlStatusLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(cacheKey);
    if (!raw) return null;
    const status = toLnurlStatus(JSON.parse(raw));
    if (!isUsefulLnurlStatus(status)) return null;
    cachedLnurlStatus = status;
    return cloneLnurlStatus(status);
  } catch (error: unknown) {
    emitTrace({
      atMs: Date.now(),
      op: "lnurl_status",
      status: "cache_read_failed",
      detail: truncateForLog(errMsg(error, "unknown"), 160),
    });
    return null;
  }
}

export function writeCachedLnurlStatus(status: ArkadeLnurlStatus): void {
  if (!isUsefulLnurlStatus(status)) return;
  const cacheKey = getLnurlStatusCacheKey();
  cachedLnurlStatus = cloneLnurlStatus(status);
  cachedLnurlStatusLoaded = true;
  cachedLnurlStatusKey = cacheKey;
  void AsyncStorage.setItem(cacheKey, JSON.stringify(cachedLnurlStatus)).catch((error: unknown) => {
    emitTrace({
      atMs: Date.now(),
      op: "lnurl_status",
      status: "cache_write_failed",
      detail: truncateForLog(errMsg(error, "unknown"), 160),
    });
  });
}

export function resetArkadeLnurlCache(): void {
  cachedLnurlStatus = null;
  cachedLnurlStatusLoaded = false;
  cachedLnurlStatusKey = "";
}

export function getArkadeLnurlStatusSnapshot(): ArkadeLnurlStatus | null {
  const cacheKey = getLnurlStatusCacheKey();
  if (cachedLnurlStatusKey && cachedLnurlStatusKey !== cacheKey) {
    cachedLnurlStatus = null;
    cachedLnurlStatusLoaded = false;
    cachedLnurlStatusKey = cacheKey;
    return null;
  }
  return cachedLnurlStatus ? cloneLnurlStatus(cachedLnurlStatus) : null;
}
