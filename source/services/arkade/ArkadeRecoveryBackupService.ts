import AsyncStorage from "@react-native-async-storage/async-storage";
import { PRF_SALT, WEBAUTHN_RP_ID } from "../../config/constants";
import {
  aeadDecryptX,
  aeadEncryptX,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  bytesToUtf8,
  hkdfSha256,
  KDF_SALT,
  normalizePrfOutput,
  randomBytes,
  sha256,
  utf8ToBytes,
  zeroize,
} from "../../lib/crypto";
import { shortTime } from "../../lib/logShared";
import { authStateManager } from "../auth/AuthStateService";
import { useExistingWalletPasskey } from "../auth/PasskeyNativeModuleService";
import {
  arkadeRecoveryBackupRead,
  arkadeRecoveryBackupUpload,
  type ArkadeCosignerDerivation,
  type ArkadeEncryptedRecoveryBackup,
  type ArkadeRelativeTimelock,
  type ArkadeRecoveryPolicy,
} from "./ArkadeApiService";
import {
  NOSTR_BACKUP_D_TAG_EXIT,
  NOSTR_BACKUP_D_TAG_FULL,
  publishEncryptedBackupsToNostr,
} from "../nostr/NostrBackupService";
import { arkadeServerConfigService } from "./ArkadeServerConfigService";
import { ArkadeRemoteIdentity } from "./ArkadeRemoteIdentity";
import { NURI_SERVER_API_VERSION } from "./ArkadeVersion";

const SERVER_BACKUP_FORMAT = "nuri-arkade-recovery-v1";
const CLIENT_BACKUP_FORMAT = "nuri-arkade-client-recovery-v1";
const BACKUP_ENCRYPTION = "xchacha20poly1305-hkdf-sha256-passkey-prf-v1";
const BACKUP_KEY_INFO = "nuri:arkade:recovery-backup:v1";
const ARKADE_SDK_EXACT_STORAGE_KEYS = [
  "wallet:state",
  "collection:contracts",
  "collection:swaps",
  "collection:reverseSwaps",
  "collection:submarineSwaps",
];
// `collection:swaps:` covers the owner-scoped legacy swap rows the swap
// repository writes (see services/arkade/internal/storageAdapter.ts) — without
// this prefix, in-flight swap/refund/claim state is excluded from backup and
// from restore-cleanup.
const ARKADE_SDK_STORAGE_KEY_PREFIXES = [
  "vtxos:",
  "utxos:",
  "tx:",
  "contract:",
  "collection:swaps:",
];
export const ARKADE_V4_STORAGE_PREFIX = "nuri:arkade:v4:";
const AUTO_BACKUP_DEBOUNCE_MS = 2_500;
const BACKUP_KEY_CACHE_TTL_MS = 180_000;

type ArkadeStorageItem = {
  key: string;
  value: string;
};

type ArkadeRecoveryBackupPlaintext = {
  format: string;
  createdAtMs: number;
  signerUrl: string;
  nodeUrl: string;
  boltzUrl: string;
  serverVersion: string;
  clientPk33: string;
  serverPk33: string;
  aggregatedPk33: string;
  aggregatedXonly32: string;
  nuriServerCsv: ArkadeRelativeTimelock;
  recoveryPolicy: ArkadeRecoveryPolicy | null;
  cosignerDerivation: ArkadeCosignerDerivation | null;
  passkeyPubkeyPolicy: string;
  recoveryBackupFormat: string;
  cosignerAccountFingerprint: string;
  passkeyCredIdB64u: string;
  passkeyCredPubkeyB64u: string;
  passkeyCredPubkeyPresent: boolean;
  storage: {
    itemCount: number;
    items: ArkadeStorageItem[];
  };
};

export type ArkadeRecoveryBackupSummary = {
  status: "uploaded" | "decrypted" | "restored";
  format: string;
  encryption: string;
  ciphertextHash: string;
  ciphertextSize: number;
  plaintextHash: string;
  storageItemCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  matchesCurrentStorage: boolean | null;
  hardModeComplete: boolean;
  serverLossRecoveryComplete: boolean;
  softModeActive: boolean;
  passkeyPubkeyRequired: boolean;
  passkeyPubkeyPresent: boolean;
  hasPublicRecoveryMetadata: boolean;
  hasArkadeStorage: boolean;
  nuriServerCsv: ArkadeRelativeTimelock | null;
  nuriServerCsvLabel: string;
  passkeyPubkeyPolicy: string;
  hardModeMissing: string[];
  serverLossRecoveryMissing: string[];
};

export type ArkadeRecoveryBackupProofReadiness = {
  pass: boolean;
  status: "pass" | "fail" | "not_checked";
  detail: string;
};

let recoveryBackupProofReadinessProvider: (() => ArkadeRecoveryBackupProofReadiness | null) | null =
  null;

export function setArkadeRecoveryBackupProofReadinessProvider(
  provider: (() => ArkadeRecoveryBackupProofReadiness | null) | null,
): void {
  recoveryBackupProofReadinessProvider = provider;
}

type BackupLogLevel = "INFO" | "WARN" | "ERROR";

let asyncStorageObserverInstalled = false;
let autoBackupTimer: ReturnType<typeof setTimeout> | null = null;
let autoBackupInFlight = false;
let autoBackupPendingReason: string | null = null;
let autoBackupSuppressionDepth = 0;
let lastUploadedStorageHash: string | null = null;
let cachedBackupKey: { key: Uint8Array; credIdB64u: string; expiresAtMs: number } | null = null;

function logRecoveryBackup(
  operation: string,
  fields: Record<string, unknown>,
  level: BackupLogLevel = "INFO",
): void {
  const summary = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.log(
    `🗄️ [${shortTime()} src=services/arkade/ArkadeRecoveryBackupService.ts#${operation} ${level} FLOW grp=Bitcoin] nuri_server_api=${NURI_SERVER_API_VERSION} ${summary}`.trim(),
  );
}

function normalizeNuriServerCsv(value: unknown): ArkadeRelativeTimelock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const type = String(raw.type || "")
    .trim()
    .toLowerCase();
  if (type !== "blocks" && type !== "seconds") return null;
  const amount = Math.trunc(Number(raw.value));
  if (!Number.isInteger(amount) || amount <= 0) return null;
  return { type, value: amount };
}

function formatNuriServerCsv(value: ArkadeRelativeTimelock | null | undefined): string {
  if (!value) return "n/a";
  return `${value.value}_${value.type}`;
}

function isArkadeSdkStorageKey(key: string): boolean {
  return (
    ARKADE_SDK_EXACT_STORAGE_KEYS.includes(key) ||
    ARKADE_SDK_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export function scopeArkadeV4StorageKey(key: string): string {
  const raw = String(key || "");
  return raw.startsWith(ARKADE_V4_STORAGE_PREFIX) ? raw : `${ARKADE_V4_STORAGE_PREFIX}${raw}`;
}

export function unScopeArkadeV4StorageKey(key: string): string {
  const raw = String(key || "");
  return raw.startsWith(ARKADE_V4_STORAGE_PREFIX)
    ? raw.slice(ARKADE_V4_STORAGE_PREFIX.length)
    : raw;
}

export function isArkadeV4StorageKey(key: string): boolean {
  const raw = String(key || "");
  return (
    raw.startsWith(ARKADE_V4_STORAGE_PREFIX) &&
    isArkadeSdkStorageKey(unScopeArkadeV4StorageKey(raw))
  );
}

export function isArkadeRecoveryBackupNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!message) return false;
  // Restore endpoints return 404 only for "no backup" / "no recovery
  // identity", so any 404 from this flow is not-found. Different transport
  // layers serialize 404 in different ways ("http_404", "HTTP 404",
  // proxy bodies, etc.) — match all of them.
  return /\bhttp[_\s]?404\b/i.test(message);
}

function isArkadeStorageKey(key: string): boolean {
  return isArkadeV4StorageKey(key);
}

function hasArkadeStorageKey(keys: readonly string[]): boolean {
  return keys.some((key) => isArkadeStorageKey(String(key || "")));
}

export async function hasLocalArkadeStorage(): Promise<boolean> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    return hasArkadeStorageKey(allKeys.map(String));
  } catch {
    return false;
  }
}

// Factory-reset cleanup: remove ALL Arkade-namespaced AsyncStorage. Every
// Arkade prefix shares the `nuri:arkade:` root — the v4 SDK namespace
// (ARKADE_V4_STORAGE_PREFIX, which also holds non-SDK app caches like
// stable-params and lnurl-status-cache), the restore sentinel, and the lazy
// credPubkey backfill flags. A raw prefix scan is deliberate here: unlike the
// SDK-filtered clear used during restore, factory reset must wipe everything,
// including the app caches the SDK filter would skip.
export async function clearAllArkadeLocalStorage(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const arkadeKeys = allKeys.map(String).filter((key) => key.startsWith("nuri:arkade:"));
    if (arkadeKeys.length > 0) {
      await AsyncStorage.multiRemove(arkadeKeys);
    }
    console.log(`[ArkadeRecoveryBackup] factory reset cleared ${arkadeKeys.length} arkade keys`);
  } catch (e) {
    console.warn("[ArkadeRecoveryBackup] clearAllArkadeLocalStorage failed:", e);
  }
}

// Sentinel proving the local Arkade storage is the result of a successful
// restore (or a successful original SDK bootstrap, set via migration). Kept
// OUTSIDE the v4 namespace so `restoreArkadeRecoveryBackup` can't wipe it
// mid-write. Set only after `multiSet` succeeds; absence after partial
// failure is the signal to re-restore.
//
// Keyed by credId so that a factory reset (which wipes keychain but not all
// of AsyncStorage) followed by a fresh passkey on the same install can't
// inherit a stale sentinel from the previous wallet and skip restore.
const ARKADE_RESTORE_SENTINEL_FLAG_PREFIX = "nuri:arkade:restore_sentinel:";

export async function hasArkadeRestoreSentinel(credIdB64u: string): Promise<boolean> {
  if (!credIdB64u) return false;
  try {
    return (
      (await AsyncStorage.getItem(`${ARKADE_RESTORE_SENTINEL_FLAG_PREFIX}${credIdB64u}`)) === "1"
    );
  } catch {
    return false;
  }
}

export async function setArkadeRestoreSentinel(credIdB64u: string): Promise<void> {
  if (!credIdB64u) return;
  try {
    await AsyncStorage.setItem(`${ARKADE_RESTORE_SENTINEL_FLAG_PREFIX}${credIdB64u}`, "1");
  } catch {}
}

async function clearArkadeRestoreSentinel(credIdB64u: string): Promise<void> {
  if (!credIdB64u) return;
  try {
    await AsyncStorage.removeItem(`${ARKADE_RESTORE_SENTINEL_FLAG_PREFIX}${credIdB64u}`);
  } catch {}
}

// Marks that a genuine (non-404) Arkade restore FAILED on this device after the
// bootstrapped keys were already persisted. A failed restore can leave partial
// v4 storage residue with the sentinel absent (absence is the retry signal). On
// the next cold launch `hasStoredKey("ethereum")` is true, so the pre-#481
// migration path would otherwise see that residue + missing sentinel and wrongly
// stamp the sentinel, permanently suppressing the retry. This marker lets the
// migration path distinguish genuine pre-#481 complete local state from
// post-failed-restore residue. Kept OUTSIDE the v4 namespace (like the sentinel)
// so `restoreArkadeRecoveryBackup` can't wipe it mid-write. Keyed by credId for
// the same factory-reset safety reason as the sentinel. Cleared on the next
// successful restore.
const ARKADE_RESTORE_FAILED_FLAG_PREFIX = "nuri:arkade:restore_failed:";

export async function hasArkadeRestoreFailedMarker(credIdB64u: string): Promise<boolean> {
  if (!credIdB64u) return false;
  try {
    return (
      (await AsyncStorage.getItem(`${ARKADE_RESTORE_FAILED_FLAG_PREFIX}${credIdB64u}`)) === "1"
    );
  } catch {
    return false;
  }
}

export async function setArkadeRestoreFailedMarker(credIdB64u: string): Promise<void> {
  if (!credIdB64u) return;
  try {
    await AsyncStorage.setItem(`${ARKADE_RESTORE_FAILED_FLAG_PREFIX}${credIdB64u}`, "1");
  } catch {}
}

async function clearArkadeRestoreFailedMarker(credIdB64u: string): Promise<void> {
  if (!credIdB64u) return;
  try {
    await AsyncStorage.removeItem(`${ARKADE_RESTORE_FAILED_FLAG_PREFIX}${credIdB64u}`);
  } catch {}
}

async function readArkadeStorageItems(): Promise<ArkadeStorageItem[]> {
  const allKeys = await AsyncStorage.getAllKeys();
  const keys = allKeys.map(String).filter(isArkadeStorageKey).sort();
  if (!keys.length) return [];
  const pairs = await AsyncStorage.multiGet(keys);
  return pairs
    .map(([key, value]) => ({
      key: String(key || ""),
      value: String(value || ""),
    }))
    .filter((item) => item.key && item.value);
}

function canonicalItems(items: ArkadeStorageItem[]): string {
  return JSON.stringify(
    items
      .map((item) => ({ key: item.key, value: item.value }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
}

function storageContentHash(items: ArkadeStorageItem[]): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalItems(items)))).slice(0, 16);
}

function plaintextHash(plaintext: ArkadeRecoveryBackupPlaintext): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(plaintext)))).slice(0, 16);
}

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message || "unknown";
  return String(error || "unknown");
}

function clearCachedBackupKey(reason: string): void {
  if (cachedBackupKey) {
    zeroize(cachedBackupKey.key);
    cachedBackupKey = null;
  }
  logRecoveryBackup("backupKeyCache", {
    status: "cleared",
    reason,
  });
}

function getCachedBackupKey(): Uint8Array | null {
  const cached = cachedBackupKey;
  if (!cached) return null;
  const expectedCredId = String(
    authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u || "",
  ).trim();
  if (expectedCredId && cached.credIdB64u !== expectedCredId) {
    clearCachedBackupKey("cred_changed");
    return null;
  }
  if (Date.now() >= cached.expiresAtMs) {
    clearCachedBackupKey("expired");
    return null;
  }
  return new Uint8Array(cached.key);
}

function setCachedBackupKey(key: Uint8Array, credIdB64u: string): void {
  if (cachedBackupKey) {
    zeroize(cachedBackupKey.key);
  }
  cachedBackupKey = {
    key: new Uint8Array(key),
    credIdB64u,
    expiresAtMs: Date.now() + BACKUP_KEY_CACHE_TTL_MS,
  };
  logRecoveryBackup("backupKeyCache", {
    status: "stored",
    ttlMs: BACKUP_KEY_CACHE_TTL_MS,
  });
}

export function primeRecoveryBackupKeyFromPrf(prf: Uint8Array, credIdB64u: string): void {
  if (!prf || prf.length === 0) return;
  if (!credIdB64u || credIdB64u.length === 0) return;
  const key = hkdfSha256(prf, KDF_SALT, utf8ToBytes(BACKUP_KEY_INFO), 32);
  try {
    setCachedBackupKey(key, credIdB64u);
    logRecoveryBackup("backupKeyCache", {
      status: "primed_from_prf",
      credIdLen: credIdB64u.length,
    });
  } finally {
    zeroize(key);
  }
}

function observeArkadeStorageMutation(operation: string, keys: readonly string[]): void {
  if (autoBackupSuppressionDepth > 0) return;
  if (!keys.length || !hasArkadeStorageKey(keys)) return;
  scheduleAutoRecoveryBackup(`${operation}:${keys.length}`);
}

function scheduleAutoRecoveryBackup(reason: string): void {
  autoBackupPendingReason = String(reason || "storage_change");
  if (autoBackupTimer) {
    clearTimeout(autoBackupTimer);
  }
  autoBackupTimer = setTimeout(() => {
    autoBackupTimer = null;
    void runAutoRecoveryBackup();
  }, AUTO_BACKUP_DEBOUNCE_MS);
  logRecoveryBackup("autoSchedule", {
    reason: autoBackupPendingReason,
    debounceMs: AUTO_BACKUP_DEBOUNCE_MS,
  });
}

async function runAutoRecoveryBackup(): Promise<void> {
  if (autoBackupInFlight) {
    scheduleAutoRecoveryBackup(autoBackupPendingReason || "in_flight");
    return;
  }
  const reason = autoBackupPendingReason || "storage_change";
  autoBackupPendingReason = null;
  autoBackupInFlight = true;
  try {
    const items = await readArkadeStorageItems();
    const storageHash = storageContentHash(items);
    if (items.length <= 0) {
      logRecoveryBackup("autoUpload", {
        status: "skipped",
        reason,
        why: "empty_storage",
      });
      return;
    }
    if (storageHash === lastUploadedStorageHash) {
      logRecoveryBackup("autoUpload", {
        status: "skipped",
        reason,
        why: "unchanged_storage",
        items: items.length,
        storageHash,
      });
      return;
    }
    const identity = new ArkadeRemoteIdentity();
    const plaintext = await buildPlaintext(identity, items);
    const cachedKey = getCachedBackupKey();
    const assertion = await identity.getCachedSigningAssertion();
    if (!cachedKey || !assertion) {
      if (cachedKey) zeroize(cachedKey);
      logRecoveryBackup("autoUpload", {
        status: "skipped",
        reason,
        why: cachedKey ? "no_cached_auth_no_prompt" : "no_cached_backup_key_no_prompt",
        items: plaintext.storage.items.length,
        storageHash,
      });
      return;
    }
    await uploadArkadeRecoveryBackupFromPlaintext(identity, plaintext, "auto", {
      key: cachedKey,
      assertion,
    });
  } catch (error) {
    const errorText = compactError(error).slice(0, 160);
    if (errorText.toLowerCase().includes("passkey request already in progress")) {
      logRecoveryBackup(
        "autoUpload",
        {
          status: "skipped",
          reason,
          why: "passkey_busy_no_prompt",
          err: errorText,
        },
        "WARN",
      );
      return;
    }
    logRecoveryBackup(
      "autoUpload",
      {
        status: "failed",
        reason,
        err: errorText,
      },
      "WARN",
    );
  } finally {
    autoBackupInFlight = false;
    if (autoBackupPendingReason) {
      scheduleAutoRecoveryBackup(autoBackupPendingReason);
    }
  }
}

function installArkadeStorageObserver(): void {
  if (asyncStorageObserverInstalled) return;
  asyncStorageObserverInstalled = true;

  const originalSetItem: typeof AsyncStorage.setItem = AsyncStorage.setItem.bind(AsyncStorage);
  const originalRemoveItem: typeof AsyncStorage.removeItem =
    AsyncStorage.removeItem.bind(AsyncStorage);
  const originalMergeItem: typeof AsyncStorage.mergeItem =
    AsyncStorage.mergeItem.bind(AsyncStorage);
  const originalMultiSet: typeof AsyncStorage.multiSet = AsyncStorage.multiSet.bind(AsyncStorage);
  const originalMultiRemove: typeof AsyncStorage.multiRemove =
    AsyncStorage.multiRemove.bind(AsyncStorage);
  const originalMultiMerge: typeof AsyncStorage.multiMerge =
    AsyncStorage.multiMerge.bind(AsyncStorage);
  const originalClear: typeof AsyncStorage.clear = AsyncStorage.clear.bind(AsyncStorage);
  const originalGetAllKeys: typeof AsyncStorage.getAllKeys =
    AsyncStorage.getAllKeys.bind(AsyncStorage);

  AsyncStorage.setItem = (async (...args) => {
    const out = await originalSetItem(...args);
    observeArkadeStorageMutation("setItem", [args[0]]);
    return out;
  }) as typeof AsyncStorage.setItem;

  AsyncStorage.removeItem = (async (...args) => {
    const out = await originalRemoveItem(...args);
    observeArkadeStorageMutation("removeItem", [args[0]]);
    return out;
  }) as typeof AsyncStorage.removeItem;

  AsyncStorage.mergeItem = (async (...args) => {
    const out = await originalMergeItem(...args);
    observeArkadeStorageMutation("mergeItem", [args[0]]);
    return out;
  }) as typeof AsyncStorage.mergeItem;

  AsyncStorage.multiSet = (async (...args) => {
    const out = await originalMultiSet(...args);
    observeArkadeStorageMutation(
      "multiSet",
      args[0].map(([key]) => key),
    );
    return out;
  }) as typeof AsyncStorage.multiSet;

  AsyncStorage.multiRemove = (async (...args) => {
    const out = await originalMultiRemove(...args);
    observeArkadeStorageMutation("multiRemove", args[0]);
    return out;
  }) as typeof AsyncStorage.multiRemove;

  AsyncStorage.multiMerge = (async (...args) => {
    const out = await originalMultiMerge(...args);
    observeArkadeStorageMutation(
      "multiMerge",
      args[0].map(([key]) => key),
    );
    return out;
  }) as typeof AsyncStorage.multiMerge;

  AsyncStorage.clear = (async (...args) => {
    let arkadeKeys: string[] = [];
    try {
      arkadeKeys = (await originalGetAllKeys()).map(String).filter(isArkadeStorageKey);
    } catch {}
    const out = await originalClear(...args);
    observeArkadeStorageMutation("clear", arkadeKeys);
    return out;
  }) as typeof AsyncStorage.clear;

  logRecoveryBackup("autoObserver", {
    status: "installed",
    debounceMs: AUTO_BACKUP_DEBOUNCE_MS,
  });
}

async function withAutoBackupSuppressed<T>(work: () => Promise<T>): Promise<T> {
  autoBackupSuppressionDepth += 1;
  try {
    return await work();
  } finally {
    autoBackupSuppressionDepth = Math.max(0, autoBackupSuppressionDepth - 1);
  }
}

function isHex(value: string, length?: number): boolean {
  if (!/^[0-9a-f]+$/i.test(String(value || ""))) return false;
  return length == null || value.length === length;
}

function validateBackupCompleteness(plaintext: ArkadeRecoveryBackupPlaintext): {
  hardModeComplete: boolean;
  serverLossRecoveryComplete: boolean;
  softModeActive: boolean;
  passkeyPubkeyRequired: boolean;
  hasPublicRecoveryMetadata: boolean;
  hasArkadeStorage: boolean;
  hardModeMissing: string[];
  serverLossRecoveryMissing: string[];
} {
  const passkeyPubkeyPolicy = String(plaintext.passkeyPubkeyPolicy || "")
    .trim()
    .toLowerCase();
  const softModeActive = passkeyPubkeyPolicy === "soft";
  const passkeyPubkeyRequired = passkeyPubkeyPolicy === "hard";
  const hardModeMissing: string[] = [];
  const serverLossRecoveryMissing: string[] = [];
  const hasV4ArkadeStorage =
    Array.isArray(plaintext.storage?.items) &&
    plaintext.storage.items.some((item) => isArkadeStorageKey(String(item.key || "")));
  const nuriServerCsv = normalizeNuriServerCsv(plaintext.nuriServerCsv);
  const actualRecoveryProof =
    recoveryBackupProofReadinessProvider?.() ||
    ({
      pass: false,
      status: "not_checked",
      detail: "not_checked",
    } satisfies ArkadeRecoveryBackupProofReadiness);

  if (!String(plaintext.passkeyCredIdB64u || "").trim()) hardModeMissing.push("passkey_cred_id");
  if (!String(plaintext.passkeyCredPubkeyB64u || "").trim()) {
    hardModeMissing.push("passkey_pubkey");
  }
  if (!isHex(plaintext.clientPk33, 66)) hardModeMissing.push("client_signer_pubkey");

  if (!String(plaintext.passkeyCredIdB64u || "").trim()) {
    serverLossRecoveryMissing.push("passkey_cred_id");
  }
  if (!isHex(plaintext.clientPk33, 66)) {
    serverLossRecoveryMissing.push("client_signer_pubkey");
  }
  if (!isHex(plaintext.serverPk33, 66)) {
    serverLossRecoveryMissing.push("deterministic_server_pubkey");
  }
  if (!isHex(plaintext.aggregatedPk33, 66)) {
    serverLossRecoveryMissing.push("aggregated_pubkey");
  }
  if (!isHex(plaintext.aggregatedXonly32, 64)) {
    serverLossRecoveryMissing.push("aggregated_xonly_pubkey");
  }
  if (!nuriServerCsv) {
    serverLossRecoveryMissing.push("nuri_server_csv");
  }
  if (!plaintext.recoveryPolicy) {
    serverLossRecoveryMissing.push("recovery_policy");
  }
  if (!plaintext.cosignerDerivation) {
    serverLossRecoveryMissing.push("cosigner_derivation");
  }
  if (!hasV4ArkadeStorage) {
    serverLossRecoveryMissing.push("arkade_storage");
  }
  if (passkeyPubkeyRequired && !String(plaintext.passkeyCredPubkeyB64u || "").trim()) {
    serverLossRecoveryMissing.push("passkey_pubkey");
  }
  if (!actualRecoveryProof.pass) {
    serverLossRecoveryMissing.push("actual_recovery_proof");
  }

  return {
    hardModeComplete: hardModeMissing.length === 0,
    serverLossRecoveryComplete: serverLossRecoveryMissing.length === 0,
    softModeActive,
    passkeyPubkeyRequired,
    hasPublicRecoveryMetadata:
      isHex(plaintext.clientPk33, 66) &&
      isHex(plaintext.serverPk33, 66) &&
      isHex(plaintext.aggregatedPk33, 66) &&
      isHex(plaintext.aggregatedXonly32, 64) &&
      Boolean(nuriServerCsv) &&
      Boolean(plaintext.recoveryPolicy) &&
      Boolean(plaintext.cosignerDerivation),
    hasArkadeStorage: hasV4ArkadeStorage,
    hardModeMissing,
    serverLossRecoveryMissing,
  };
}

async function deriveBackupKeyFromPasskey(): Promise<{
  key: Uint8Array;
  credIdB64u: string;
  credPubkeyPresent: boolean;
}> {
  await authStateManager.initialize();
  const walletPublicKeys = authStateManager.getState().walletPublicKeys;
  const expectedCredId = String(walletPublicKeys?.walletPasskeyCredIdB64u || "").trim();
  if (!expectedCredId) {
    throw new Error("wallet passkey credential id missing");
  }

  logRecoveryBackup("passkeyPrompt", {
    source: "manual_recovery_backup_key",
    expectedCredIdLen: expectedCredId.length,
    credentialPinned: 1,
    expectedNext: "native_passkey_prf_prompt",
  });
  const result = await useExistingWalletPasskey(WEBAUTHN_RP_ID, PRF_SALT, expectedCredId);
  const returnedCredId = String(result.credIdB64u || "").trim();
  if (returnedCredId && returnedCredId !== expectedCredId) {
    throw new Error("wallet passkey credential mismatch");
  }

  const prf = normalizePrfOutput(result.prfB64);
  try {
    return {
      key: hkdfSha256(prf, KDF_SALT, utf8ToBytes(BACKUP_KEY_INFO), 32),
      credIdB64u: expectedCredId,
      credPubkeyPresent: Boolean(walletPublicKeys?.walletPasskeyCredPubkeyB64u),
    };
  } finally {
    zeroize(prf);
  }
}

async function buildPlaintext(
  identity: ArkadeRemoteIdentity,
  preloadedItems?: ArkadeStorageItem[],
): Promise<ArkadeRecoveryBackupPlaintext> {
  const [items, publicContext] = await Promise.all([
    preloadedItems ? Promise.resolve(preloadedItems) : readArkadeStorageItems(),
    identity.getSigningPublicContext(),
  ]);
  const walletPublicKeys = authStateManager.getState().walletPublicKeys;
  return {
    format: CLIENT_BACKUP_FORMAT,
    createdAtMs: Date.now(),
    signerUrl: arkadeServerConfigService.getSignerServerUrl(),
    nodeUrl: arkadeServerConfigService.getArkadeNodeUrl(),
    // Written as an empty string: the field stays in the manifest so older
    // backups still load and newer ones keep the same shape, but there is no
    // swap-provider URL to configure any more.
    boltzUrl: "",
    serverVersion: publicContext.serverVersion,
    clientPk33: publicContext.clientPk33,
    serverPk33: publicContext.serverPk33,
    aggregatedPk33: publicContext.aggregatedPk33,
    aggregatedXonly32: publicContext.aggregatedXonly32,
    nuriServerCsv: publicContext.nuriServerCsv,
    recoveryPolicy: publicContext.recoveryPolicy,
    cosignerDerivation: publicContext.cosignerDerivation,
    passkeyPubkeyPolicy: publicContext.passkeyPubkeyPolicy,
    recoveryBackupFormat: publicContext.recoveryBackupFormat,
    cosignerAccountFingerprint: publicContext.cosignerAccountFingerprint,
    passkeyCredIdB64u: String(walletPublicKeys?.walletPasskeyCredIdB64u || ""),
    passkeyCredPubkeyB64u: String(walletPublicKeys?.walletPasskeyCredPubkeyB64u || ""),
    passkeyCredPubkeyPresent: Boolean(walletPublicKeys?.walletPasskeyCredPubkeyB64u),
    storage: {
      itemCount: items.length,
      items,
    },
  };
}

function encryptPlaintext(
  plaintext: ArkadeRecoveryBackupPlaintext,
  key: Uint8Array,
): ArkadeEncryptedRecoveryBackup {
  const createdAtMs = Date.now();
  const aad = {
    format: SERVER_BACKUP_FORMAT,
    encryption: BACKUP_ENCRYPTION,
    client_pk33: plaintext.clientPk33,
    nuri_server_csv: plaintext.nuriServerCsv,
    created_at_ms: createdAtMs,
  };
  const nonce = randomBytes(24);
  const aadBytes = utf8ToBytes(JSON.stringify(aad));
  const plaintextBytes = utf8ToBytes(JSON.stringify(plaintext));
  try {
    const ciphertext = aeadEncryptX(key, nonce, plaintextBytes, aadBytes);
    return {
      format: SERVER_BACKUP_FORMAT,
      encryption: BACKUP_ENCRYPTION,
      nonce_b64u: bytesToBase64url(nonce),
      aad_b64u: bytesToBase64url(aadBytes),
      ciphertext_b64u: bytesToBase64url(ciphertext),
      created_at_ms: createdAtMs,
    };
  } finally {
    zeroize(plaintextBytes);
  }
}

function decryptBackup(
  backup: ArkadeEncryptedRecoveryBackup,
  key: Uint8Array,
): ArkadeRecoveryBackupPlaintext {
  if (backup.format !== SERVER_BACKUP_FORMAT) {
    throw new Error("unsupported recovery backup format");
  }
  if (backup.encryption !== BACKUP_ENCRYPTION) {
    throw new Error("unsupported recovery backup encryption");
  }
  const nonce = base64urlToBytes(backup.nonce_b64u);
  const aad = backup.aad_b64u ? base64urlToBytes(backup.aad_b64u) : undefined;
  const ciphertext = base64urlToBytes(backup.ciphertext_b64u);
  const plaintextBytes = aeadDecryptX(key, nonce, ciphertext, aad);
  if (!plaintextBytes) {
    throw new Error("arkade recovery backup decrypt failed");
  }
  try {
    const parsed = JSON.parse(bytesToUtf8(plaintextBytes)) as ArkadeRecoveryBackupPlaintext;
    if (parsed.format !== CLIENT_BACKUP_FORMAT) {
      throw new Error("unsupported arkade client backup format");
    }
    if (!Array.isArray(parsed.storage?.items)) {
      throw new Error("arkade client backup storage missing");
    }
    return parsed;
  } finally {
    zeroize(plaintextBytes);
  }
}

function summarizeBackup(
  status: ArkadeRecoveryBackupSummary["status"],
  backup: ArkadeEncryptedRecoveryBackup,
  plaintext: ArkadeRecoveryBackupPlaintext,
  matchesCurrentStorage: boolean | null,
): ArkadeRecoveryBackupSummary {
  const ciphertext = base64urlToBytes(backup.ciphertext_b64u);
  const completeness = validateBackupCompleteness(plaintext);
  const nuriServerCsv = normalizeNuriServerCsv(plaintext.nuriServerCsv);
  return {
    status,
    format: backup.format,
    encryption: backup.encryption,
    ciphertextHash: backup.ciphertext_hash || bytesToHex(sha256(ciphertext)),
    ciphertextSize: Math.max(
      0,
      Math.trunc(Number(backup.ciphertext_size || ciphertext.length || 0)),
    ),
    plaintextHash: plaintextHash(plaintext),
    storageItemCount: plaintext.storage.items.length,
    createdAtMs: Math.max(
      0,
      Math.trunc(Number(backup.created_at_ms || plaintext.createdAtMs || 0)),
    ),
    updatedAtMs: Math.max(0, Math.trunc(Number(backup.updated_at_ms || 0))),
    matchesCurrentStorage,
    hardModeComplete: completeness.hardModeComplete,
    serverLossRecoveryComplete: completeness.serverLossRecoveryComplete,
    softModeActive: completeness.softModeActive,
    passkeyPubkeyRequired: completeness.passkeyPubkeyRequired,
    passkeyPubkeyPresent: Boolean(plaintext.passkeyCredPubkeyB64u),
    hasPublicRecoveryMetadata: completeness.hasPublicRecoveryMetadata,
    hasArkadeStorage: completeness.hasArkadeStorage,
    nuriServerCsv,
    nuriServerCsvLabel: formatNuriServerCsv(nuriServerCsv),
    passkeyPubkeyPolicy: String(plaintext.passkeyPubkeyPolicy || ""),
    hardModeMissing: completeness.hardModeMissing,
    serverLossRecoveryMissing: completeness.serverLossRecoveryMissing,
  };
}

async function decryptStoredBackup(
  identity: ArkadeRemoteIdentity,
  usePrfAssertion = false,
): Promise<{
  backup: ArkadeEncryptedRecoveryBackup;
  plaintext: ArkadeRecoveryBackupPlaintext;
  summary: ArkadeRecoveryBackupSummary;
}> {
  const cachedKey = getCachedBackupKey();
  const derived = cachedKey ? null : await deriveBackupKeyFromPasskey();
  if (!cachedKey && !derived) {
    throw new Error("arkade recovery backup key unavailable");
  }
  const key = cachedKey ? cachedKey : derived.key;
  if (derived) {
    setCachedBackupKey(key, derived.credIdB64u);
  }
  try {
    // A PRF assertion is a superset of the server-auth assertion the read needs.
    // On the login-restore path we request PRF so the cached assertion is the
    // `passkey_prf_assertion` kind that Receive/LNURL/boarding reuse — otherwise
    // the cached assertion-only credential is rejected for kind-mismatch and the
    // user gets a second in-app Face ID when they open Receive.
    const assertion = usePrfAssertion
      ? await identity.getPrfSigningAssertion()
      : await identity.getSigningAssertion();
    const response = await arkadeRecoveryBackupRead(assertion);
    const plaintext = decryptBackup(response.encrypted_backup, key);
    const currentItems = await readArkadeStorageItems();
    const matchesCurrentStorage =
      canonicalItems(currentItems) === canonicalItems(plaintext.storage.items);
    const summary = summarizeBackup(
      "decrypted",
      response.encrypted_backup,
      plaintext,
      matchesCurrentStorage,
    );
    logRecoveryBackup("decrypt", {
      status: summary.status,
      items: summary.storageItemCount,
      match: matchesCurrentStorage ? 1 : 0,
      cipherSize: summary.ciphertextSize,
      hard: summary.hardModeComplete ? 1 : 0,
      recovery: summary.serverLossRecoveryComplete ? 1 : 0,
    });
    return { backup: response.encrypted_backup, plaintext, summary };
  } finally {
    zeroize(key);
  }
}

// Storage rows a unilateral exit actually needs: vtxos/utxos to spend, the
// contracts holding their scripts, and wallet state. Tx history and Boltz swap
// rows are deliberately excluded to keep the Nostr event small.
const EXIT_ESSENTIAL_KEY_MARKERS = [
  "wallet:state",
  "collection:contracts",
  "vtxos:",
  "utxos:",
  "contract:",
];

function isExitEssentialStorageKey(key: string): boolean {
  return EXIT_ESSENTIAL_KEY_MARKERS.some((marker) => key.includes(marker));
}

// Mirror the server backup to Nostr: one exit-essential event (priority — it
// alone lets the user unilaterally exit without Nuri) and, size permitting,
// the full backup. Both reuse the same PRF-derived key and encrypted format,
// so decryptBackup() works on whatever a recovery tool fetches from relays.
// Synchronous encryption (key gets zeroized by the caller); publishing is
// fire-and-forget.
function mirrorBackupToNostr(
  plaintext: ArkadeRecoveryBackupPlaintext,
  key: Uint8Array,
  fullBackup: ArkadeEncryptedRecoveryBackup,
): void {
  try {
    const exitItems = plaintext.storage.items.filter((item) => isExitEssentialStorageKey(item.key));
    const exitBackup = encryptPlaintext(
      { ...plaintext, storage: { itemCount: exitItems.length, items: exitItems } },
      key,
    );
    void publishEncryptedBackupsToNostr([
      { dTag: NOSTR_BACKUP_D_TAG_EXIT, contentJson: JSON.stringify(exitBackup) },
      { dTag: NOSTR_BACKUP_D_TAG_FULL, contentJson: JSON.stringify(fullBackup) },
    ]);
  } catch (error) {
    logRecoveryBackup(
      "nostrMirror",
      { status: "failed", err: compactError(error).slice(0, 160) },
      "WARN",
    );
  }
}

async function uploadArkadeRecoveryBackupFromPlaintext(
  identity: ArkadeRemoteIdentity,
  plaintext: ArkadeRecoveryBackupPlaintext,
  source: "manual" | "auto",
  cached?: {
    key: Uint8Array;
    assertion: {
      token: string;
      clientDataB64u: string;
      authDataB64u: string;
      sigB64u: string;
    };
  },
): Promise<ArkadeRecoveryBackupSummary | null> {
  if (source === "auto" && !cached) {
    logRecoveryBackup("autoUpload", {
      status: "skipped",
      source,
      why: "auto_passkey_prompt_forbidden",
      items: plaintext.storage.items.length,
      storageHash: storageContentHash(plaintext.storage.items),
    });
    return null;
  }
  const derived = cached ? null : await deriveBackupKeyFromPasskey();
  if (!cached && !derived) {
    throw new Error("arkade recovery backup key unavailable");
  }
  const key = cached ? cached.key : derived.key;
  try {
    const backup = encryptPlaintext(plaintext, key);
    if (derived) {
      setCachedBackupKey(key, derived.credIdB64u);
    }
    const assertion = cached?.assertion || (await identity.getSigningAssertion());
    const response = await arkadeRecoveryBackupUpload(assertion, backup);
    const summary = summarizeBackup(
      "uploaded",
      {
        ...backup,
        ciphertext_hash: response.recovery?.backup_ciphertext_hash,
        ciphertext_size: response.recovery?.backup_ciphertext_size,
        updated_at_ms: response.recovery?.backup_updated_at_ms,
      },
      plaintext,
      true,
    );
    lastUploadedStorageHash = storageContentHash(plaintext.storage.items);
    mirrorBackupToNostr(plaintext, key, backup);
    logRecoveryBackup(source === "auto" ? "autoUpload" : "upload", {
      status: summary.status,
      source,
      items: summary.storageItemCount,
      cipherSize: summary.ciphertextSize,
      nuriServerCsv: formatNuriServerCsv(plaintext.nuriServerCsv),
      policy: plaintext.passkeyPubkeyPolicy || "n/a",
      passkeyPubkey: plaintext.passkeyCredPubkeyPresent ? 1 : 0,
      recovery: response.recovery?.backup_present ? 1 : 0,
      complete: summary.serverLossRecoveryComplete ? 1 : 0,
    });
    return summary;
  } finally {
    zeroize(key);
  }
}

installArkadeStorageObserver();

export async function uploadArkadeRecoveryBackup(
  identity: ArkadeRemoteIdentity,
): Promise<ArkadeRecoveryBackupSummary> {
  const plaintext = await buildPlaintext(identity);
  const summary = await uploadArkadeRecoveryBackupFromPlaintext(identity, plaintext, "manual");
  if (!summary) {
    throw new Error("manual arkade recovery backup skipped unexpectedly");
  }
  return summary;
}

export async function decryptArkadeRecoveryBackup(
  identity: ArkadeRemoteIdentity,
): Promise<ArkadeRecoveryBackupSummary> {
  return (await decryptStoredBackup(identity)).summary;
}

export async function decryptArkadeRecoveryBackupPasskeyCredPubkey(
  identity: ArkadeRemoteIdentity,
): Promise<{ summary: ArkadeRecoveryBackupSummary; passkeyCredPubkeyB64u: string }> {
  const { plaintext, summary } = await decryptStoredBackup(identity);
  return { summary, passkeyCredPubkeyB64u: String(plaintext.passkeyCredPubkeyB64u || "") };
}

export async function restoreArkadeRecoveryBackup(
  identity: ArkadeRemoteIdentity,
  credIdB64u?: string,
): Promise<{ summary: ArkadeRecoveryBackupSummary; passkeyCredPubkeyB64u: string }> {
  const { backup, plaintext, summary } = await decryptStoredBackup(identity, true);
  const storageItems = plaintext.storage.items.filter((item) =>
    isArkadeStorageKey(String(item.key || "")),
  );
  if (storageItems.length <= 0) {
    throw new Error("recovery backup contains no v4 arkade storage");
  }
  // Clear the sentinel before any destructive write. If multiSet partially
  // fails or the process is killed mid-write, the sentinel stays absent and
  // the next sign-in re-runs restore over the residue.
  if (credIdB64u) {
    await clearArkadeRestoreSentinel(credIdB64u);
  }
  const currentKeys = await withAutoBackupSuppressed(async () => {
    const keys = (await AsyncStorage.getAllKeys()).map(String).filter(isArkadeStorageKey);
    if (keys.length) {
      await AsyncStorage.multiRemove(keys);
    }
    await AsyncStorage.multiSet(
      storageItems.map((item) => [item.key, item.value] as [string, string]),
    );
    return keys;
  });
  if (credIdB64u) {
    await setArkadeRestoreSentinel(credIdB64u);
    await clearArkadeRestoreFailedMarker(credIdB64u);
  }
  const restored = summarizeBackup("restored", backup, plaintext, null);
  logRecoveryBackup("restore", {
    status: restored.status,
    items: storageItems.length,
    removed: currentKeys.length,
    previousMatch: summary.matchesCurrentStorage ? 1 : 0,
  });
  return {
    summary: restored,
    passkeyCredPubkeyB64u: String(plaintext.passkeyCredPubkeyB64u || ""),
  };
}

const LAZY_CRED_PUBKEY_BACKFILL_FLAG_PREFIX = "nuri:arkade:lazy_credpub_backfill:";

export type LazyCredPubkeyBackfillStatus =
  | "completed"
  | "no_backup_on_server"
  | "backup_has_no_credpubkey";

export async function getLazyCredPubkeyBackfillStatus(
  credIdB64u: string,
): Promise<LazyCredPubkeyBackfillStatus | null> {
  if (!credIdB64u) return null;
  try {
    const value = await AsyncStorage.getItem(
      `${LAZY_CRED_PUBKEY_BACKFILL_FLAG_PREFIX}${credIdB64u}`,
    );
    if (
      value === "completed" ||
      value === "no_backup_on_server" ||
      value === "backup_has_no_credpubkey"
    ) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setLazyCredPubkeyBackfillStatus(
  credIdB64u: string,
  status: LazyCredPubkeyBackfillStatus,
): Promise<void> {
  if (!credIdB64u) return;
  try {
    await AsyncStorage.setItem(`${LAZY_CRED_PUBKEY_BACKFILL_FLAG_PREFIX}${credIdB64u}`, status);
  } catch {}
}

/**
 * One-shot lazy credPubkey backfill for legacy users who migrated to a second
 * device before #478 shipped (credId present, credPubkey missing) and have a
 * recovery backup on the server. credPubkey is required for
 * PASSKEY_PUBKEY_POLICY=hard.
 *
 * MUST run only AFTER the app is unlocked: the decrypt step triggers a passkey
 * PRF assertion (Face ID/Touch ID), which must not race the biometric lock
 * prompt at cold launch. The caller defers invocation to the post-unlock path.
 */
export async function runLazyCredPubkeyBackfill(credId: string): Promise<void> {
  try {
    const priorStatus = await getLazyCredPubkeyBackfillStatus(credId);
    if (priorStatus) {
      console.log(`[LazyCredPubkeyBackfill] already attempted (${priorStatus}); skipping`);
      return;
    }
    const identity = new ArkadeRemoteIdentity();
    let recoveryStatus: { backup_present?: boolean } | null = null;
    try {
      const ctx = await identity.getSigningPublicContext();
      recoveryStatus = ctx.recovery;
    } catch (preCheckErr) {
      const msg = preCheckErr instanceof Error ? preCheckErr.message : String(preCheckErr);
      console.warn("[LazyCredPubkeyBackfill] pre-check failed (will retry next launch):", msg);
      return;
    }
    if (recoveryStatus == null) {
      // Server omitted recovery status entirely — treat as unknown rather than
      // as definitely-no-backup. Setting the suppression flag here would
      // permanently disable backfill for users who actually have a backup.
      console.warn(
        "[LazyCredPubkeyBackfill] server recovery status missing; will retry next launch",
      );
      return;
    }
    if (recoveryStatus.backup_present === false) {
      await setLazyCredPubkeyBackfillStatus(credId, "no_backup_on_server");
      console.log("[LazyCredPubkeyBackfill] no backup on server; flag set, no future retry");
      return;
    }
    if (recoveryStatus.backup_present !== true) {
      console.warn(
        "[LazyCredPubkeyBackfill] backup_present is neither true nor false; will retry next launch",
      );
      return;
    }
    try {
      const { passkeyCredPubkeyB64u } =
        await decryptArkadeRecoveryBackupPasskeyCredPubkey(identity);
      if (passkeyCredPubkeyB64u.length > 0) {
        await authStateManager.upsertWalletPasskeyMetadata(credId, passkeyCredPubkeyB64u);
        await setLazyCredPubkeyBackfillStatus(credId, "completed");
        console.log("[LazyCredPubkeyBackfill] completed and flagged");
      } else {
        await setLazyCredPubkeyBackfillStatus(credId, "backup_has_no_credpubkey");
        console.log("[LazyCredPubkeyBackfill] backup has no credPubkey; flag set");
      }
    } catch (decryptErr) {
      if (isArkadeRecoveryBackupNotFoundError(decryptErr)) {
        await setLazyCredPubkeyBackfillStatus(credId, "no_backup_on_server");
        console.log("[LazyCredPubkeyBackfill] server returned 404 on decrypt; flag set");
      } else {
        const msg = decryptErr instanceof Error ? decryptErr.message : String(decryptErr);
        console.warn("[LazyCredPubkeyBackfill] decrypt failed (will retry next launch):", msg);
      }
    }
  } catch (outerErr) {
    const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    console.warn("[LazyCredPubkeyBackfill] outer failure (will retry next launch):", msg);
  }
}
