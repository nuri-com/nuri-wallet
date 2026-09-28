/**
 * Secure key storage using the platform keychain.
 * iOS: biometric-only (BIOMETRY_CURRENT_SET); fails closed when biometrics are unavailable.
 * Android: strong-class biometrics when enrolled, device-passcode fallback otherwise;
 * fails closed when neither can be enforced.
 */

import * as Keychain from "react-native-keychain";
import { Platform } from "react-native";
import { bytesToBase64url, base64urlToBytes, sha256 } from "./crypto";
import { bytesToHex } from "./bytes";
import { deriveNostrPrivateKeyFromBitcoinKey, isValidNostrPrivateKey } from "./walletDerivation";
import { logWithId, errorWithId } from "./OperationLogUtils";
import { errDescription, errMsg } from "./errorMessage";
import { t } from "./i18n";

/**
 * Cancellation and lockout phrasing differs per platform and API layer
 * ("UserCancel", "User canceled the operation.", "Canceled by user.",
 * "Biometric authentication cancelled", lockout variants). Security flows must
 * treat all of them as a retryable prompt dismissal — never as keychain
 * invalidation.
 */
export function isBiometricPromptDismissal(error: unknown): boolean {
  const message = errMsg(error);
  return /cancel/i.test(message) || /lock(ed)?\s?out/i.test(message);
}

function classifyBiometricError(error: unknown): never {
  const message = errMsg(error);
  if (/lock(ed)?\s?out/i.test(message)) {
    throw new Error("Biometric authentication locked out - too many failed attempts");
  }
  if (/cancel/i.test(message)) {
    throw new Error("Biometric authentication cancelled");
  }
  if (message.includes("BiometryNotAvailable")) {
    throw new Error("Biometric authentication not available");
  }
  if (message.includes("BiometryNotEnrolled")) {
    throw new Error("No biometrics enrolled on device");
  }
  throw error;
}

/**
 * Resolve the access control for biometric-protected writes.
 * iOS: BIOMETRY_CURRENT_SET (fails closed when biometrics are unavailable — intended).
 * Android decides by enrolled security level (enrollment + biometric class, not
 * hardware presence):
 * - BIOMETRIC_STRONG enrolled: BIOMETRY_CURRENT_SET.
 * - Weak-class biometrics or PIN/pattern only: DEVICE_PASSCODE — react-native-keychain
 *   would otherwise silently select a no-auth cipher storage.
 * - No lock screen at all: throw, because even the passcode storage is unavailable
 *   and the library would fall back to no-auth.
 * - DEVICE_PASSCODE additionally requires device-credential auth support (Android 11+,
 *   reported by isPasscodeAuthAvailable); otherwise throw instead of silently
 *   selecting a no-auth cipher storage.
 */
async function resolveBiometricAccessControl(): Promise<Keychain.ACCESS_CONTROL> {
  if (Platform.OS === "ios") {
    return Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET;
  }
  // Lazy import: expo-local-authentication throws AT MODULE LOAD on binaries that
  // don't include the native module (requireNativeModule at top level). iOS never
  // uses it, and OTA-shipped JS on the 0.86.0 fingerprint (see 1533b4ed) must not
  // crash on import. Android behavior is unchanged: missing module → throw → fail
  // closed, exactly like before.
  // EXCEPTION to the no-dynamic-imports rule (AGENTS.md): allowed because this is a
  // native-optional module behind a platform guard, not an app module the bundler
  // can drop; the import failure IS the desired behavior on old Android binaries.
  const LocalAuthentication = await import("expo-local-authentication");

  const enrolledLevel = await LocalAuthentication.getEnrolledLevelAsync();
  if (enrolledLevel === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG) {
    return Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET;
  }
  if (enrolledLevel === LocalAuthentication.SecurityLevel.NONE) {
    throw new Error("No device lock screen configured - cannot store keys securely");
  }
  const passcodeAvailable = await Keychain.isPasscodeAuthAvailable();
  if (!passcodeAvailable) {
    throw new Error("Device passcode authentication unavailable - cannot store keys securely");
  }
  return Keychain.ACCESS_CONTROL.DEVICE_PASSCODE;
}

/** Android cipher storages that enforce no user authentication on read. */
const NO_AUTH_STORAGE_TYPES = new Set<string>([
  Keychain.STORAGE_TYPE.AES_CBC,
  Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
]);

/**
 * Pre-PR Android builds could silently store entries without any auth requirement
 * (no-auth cipher storages). Rewrite such an entry under the access control that
 * resolveBiometricAccessControl() now mandates. The upgrade is MANDATORY: callers
 * must not return the secret unless the entry is already secure or this rewrite
 * succeeded. Throws when the device cannot enforce protection or the write/prompt
 * fails. The write happens WITHOUT resetting first, so a failure never deletes the
 * old entry — the upgrade retries on the next read.
 */
async function upgradeNoAuthEntryIfNeeded(
  server: string,
  value: string,
  storage: string | undefined,
  promptTitle: string,
): Promise<void> {
  if (Platform.OS !== "android") return;
  if (!storage || !NO_AUTH_STORAGE_TYPES.has(storage)) return;
  try {
    const accessControl = await resolveBiometricAccessControl();
    await Keychain.setInternetCredentials(server, server, value, {
      accessControl,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
      authenticationPrompt: { title: promptTitle },
    });
    logWithId("🔐 Biometric", "upgraded no-auth keychain entry", {
      server,
      from_storage: storage,
    });
  } catch (error: unknown) {
    logWithId("🔐 Biometric", "no-auth keychain entry upgrade failed", {
      server,
      ...errDescription(error),
    });
    throw error;
  }
}

// Key identifiers for storage
const BITCOIN_KEY_ID = "bitcoin_private_key";
// Combined protected entry holding the Bitcoin and EVM roots as one JSON blob.
// One read grants wallet access and also provisions the deterministic Nostr key
// without another protected read. The per-key entries remain only as bootstrap
// presence markers and rollback targets; they are never an unlock fallback. A
// single-key (re)store resets this entry so it cannot go stale, and the write
// flow must commit a fresh combined entry before it succeeds.
const WALLET_KEYS_ID = "wallet_private_keys";
const BITCOIN_ADDRESS_ID = "bitcoin_address";
const ARKADE_BOARDING_ADDRESS_ID = "arkade_boarding_address";
// Dedicated cache slot for the current Nuri Cosigner v4 L1 address.
const MUSIG2_ADDRESS_V4_ID = "musig2_onchain_address_v4";
const BITCOIN_PUBKEY_ID = "bitcoin_pubkey";
const ETHEREUM_KEY_ID = "ethereum_private_key";
const ETHEREUM_ADDRESS_ID = "ethereum_address";
const ETHEREUM_PUBKEY_ID = "ethereum_pubkey";
const NOSTR_KEY_ID = "nostr_private_key";
const AUTH_KEY_ID = "auth_hmac_key";
const USER_ID_KEY = "user_id";
const COSIGNER_PUBKEY_ID = "cosigner_pubkey";
const AUTH_FLAGS_ID = "auth_flags";
const COSIGNER_PUBKEY_COMPRESSED_ID = "COSIGNER_PUBKEY_COMPRESSED";
const WALLET_PUBLIC_KEYS_ID = "@auth:wallet_public_keys";
const BIOMETRIC_SENTINEL_ID = "biometric_sentinel";
const BIOMETRIC_SENTINEL_MARKER_ID = "biometric_sentinel_marker";
const SWAPKIT_HTLC_ROOTS_ID = "swapkit_htlc_roots_v1";
const SWAPKIT_HTLC_KEYSTATE_ID = "swapkit_htlc_keystate_v1";

const DEFAULT_KEYCHAIN_SERVERS = [
  BITCOIN_KEY_ID,
  WALLET_KEYS_ID,
  BITCOIN_ADDRESS_ID,
  ARKADE_BOARDING_ADDRESS_ID,
  MUSIG2_ADDRESS_V4_ID,
  BITCOIN_PUBKEY_ID,
  ETHEREUM_KEY_ID,
  ETHEREUM_ADDRESS_ID,
  ETHEREUM_PUBKEY_ID,
  NOSTR_KEY_ID,
  AUTH_KEY_ID,
  USER_ID_KEY,
  COSIGNER_PUBKEY_ID,
  AUTH_FLAGS_ID,
  COSIGNER_PUBKEY_COMPRESSED_ID,
  WALLET_PUBLIC_KEYS_ID,
  BIOMETRIC_SENTINEL_ID,
  BIOMETRIC_SENTINEL_MARKER_ID,
  SWAPKIT_HTLC_ROOTS_ID,
  SWAPKIT_HTLC_KEYSTATE_ID,
];

type PrivateKeyType = "bitcoin" | "ethereum" | "nostr";
type CombinedWalletKeyType = Exclude<PrivateKeyType, "nostr">;
type WalletUnlockedListener = () => void;

const walletUnlockedListeners = new Set<WalletUnlockedListener>();

export function addWalletUnlockedListener(listener: WalletUnlockedListener): () => void {
  walletUnlockedListeners.add(listener);
  return () => walletUnlockedListeners.delete(listener);
}

function notifyWalletUnlocked(): void {
  walletUnlockedListeners.forEach((listener) => {
    try {
      listener();
    } catch {}
  });
}

// Session-resident: all decrypted wallet keys are held in memory from the combined
// wallet access until the app locks or signs out — there is no time-based
// expiry. clearPrivateKeyCache() on lock/logout is the only boundary. This is
// the "biometric once, hold in memory" model: signing reads hit this cache, so
// no second biometric and no passkey ceremony fires per spend.
type CachedPrivateKeyEntry = {
  bytes: Uint8Array;
};

const privateKeyCache: Partial<Record<PrivateKeyType, CachedPrivateKeyEntry>> = {};

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function wipeBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

function setPrivateKeyCache(keyType: PrivateKeyType, keyBytes: Uint8Array): void {
  const existing = privateKeyCache[keyType];
  if (existing) {
    wipeBytes(existing.bytes);
  }
  privateKeyCache[keyType] = {
    bytes: cloneBytes(keyBytes),
  };
}

function getPrivateKeyFromCache(keyType: PrivateKeyType): Uint8Array | null {
  const cached = privateKeyCache[keyType];
  if (!cached) return null;
  return cloneBytes(cached.bytes);
}

function clearPrivateKeyCache(keyType?: PrivateKeyType): void {
  if (keyType) {
    const cached = privateKeyCache[keyType];
    if (cached) {
      wipeBytes(cached.bytes);
      delete privateKeyCache[keyType];
    }
    return;
  }
  (Object.keys(privateKeyCache) as PrivateKeyType[]).forEach((type) => {
    const cached = privateKeyCache[type];
    if (!cached) return;
    wipeBytes(cached.bytes);
    delete privateKeyCache[type];
  });
}

export function clearPrivateKeyMemoryCache(keyType?: PrivateKeyType): void {
  clearPrivateKeyCache(keyType);
}

// App-lock gate. While the app is biometric-locked, background key reads must
// not raise their own Face ID prompt — they park here until the lock resolves.
// A successful unlock (setAppLocked(false)) seeds the cache first, so released
// callers resume against a warm cache with no extra prompt. A reset/sign-out
// (abortAppLock) rejects the parked callers instead, so background SIWE/signing
// can't resume and prompt for keys mid-logout.
let appLocked = false;
type UnlockWaiter = { resolve: () => void; reject: (error: Error) => void };
let unlockWaiters: UnlockWaiter[] = [];

export function setAppLocked(locked: boolean): void {
  appLocked = locked;
  if (locked) {
    // Session-resident keys live in memory only while the app is unlocked. The
    // moment we lock, drop them so a locked app holds no key material; the
    // unlock biometric (BiometricLockModal) re-seeds the cache.
    clearPrivateKeyCache();
    return;
  }
  const waiters = unlockWaiters;
  unlockWaiters = [];
  waiters.forEach((w) => w.resolve());
}

// Reset/sign-out release. Unlike a successful unlock, nothing seeded the cache,
// so resolving the parked readers would let them read/prompt for keys during
// logout. Reject them (the awaiting getPrivateKey calls throw and their callers
// abandon the read) and disengage the gate.
export function abortAppLock(): void {
  appLocked = false;
  // Sign-out/reset: never leave key material in memory for the aborted readers.
  clearPrivateKeyCache();
  const waiters = unlockWaiters;
  unlockWaiters = [];
  waiters.forEach((w) => w.reject(new Error("app lock aborted")));
}

function waitForUnlock(): Promise<void> {
  if (!appLocked) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    unlockWaiters.push({ resolve, reject });
  });
}

/**
 * Store a private key in Keychain with biometric-only protection
 * @param privateKey The private key bytes to store
 * @param keyType The type of key (bitcoin or ethereum)
 */
export async function storePrivateKey(
  privateKey: Uint8Array,
  keyType: "bitcoin" | "ethereum",
): Promise<void> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    throw new Error("Biometric storage only supported on iOS and Android");
  }

  const keyId = keyType === "bitcoin" ? BITCOIN_KEY_ID : ETHEREUM_KEY_ID;
  const base64Key = bytesToBase64url(privateKey);

  try {
    // Resolve access control first: on fail-closed paths this throws BEFORE we
    // delete the user's existing entry.
    const accessControl = await resolveBiometricAccessControl();
    logWithId("🔐 Biometric", "storePrivateKey access control resolved", {
      access_control: accessControl,
    });
    // Proactively reset any existing internet credentials to avoid stale caches
    try {
      await Keychain.resetInternetCredentials({ server: keyId });
    } catch {}
    await Keychain.setInternetCredentials(keyId, keyId, base64Key, {
      accessControl,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
      authenticationPrompt: { title: t("screen.SecureKeyStorage.storeWalletKeyPrompt") },
    });
    if (keyType === "bitcoin") clearPrivateKeyCache("nostr");
    setPrivateKeyCache(keyType, privateKey);
    // A single-key (re)store makes the combined entry stale — drop it. The
    // caller must write a fresh combined entry before its wallet-key commit can
    // succeed. Unlock never reconstructs it from separate biometric reads.
    try {
      await Keychain.resetInternetCredentials({ server: WALLET_KEYS_ID });
    } catch {}
  } catch (error: unknown) {
    classifyBiometricError(error);
  }
}

/**
 * Write the protected Bitcoin and EVM roots as one combined entry. Wallet access
 * reads it once, provisions Nostr without another protected read, and caches all
 * three identities. This write is mandatory because there is no per-key fallback.
 */
export async function storeCombinedWalletKeys(
  bitcoinPrivateKey: Uint8Array,
  ethereumPrivateKey: Uint8Array,
): Promise<void> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  await writeCombinedWalletKeys({
    bitcoin: bytesToBase64url(bitcoinPrivateKey),
    ethereum: bytesToBase64url(ethereumPrivateKey),
  });
  const nostrPrivateKey = await getOrProvisionStoredNostrPrivateKey(bitcoinPrivateKey);
  try {
    setPrivateKeyCache("nostr", nostrPrivateKey);
  } finally {
    wipeBytes(nostrPrivateKey);
  }
}

/**
 * Commit roots the caller re-derived from the passkey PRF, then open the session
 * with them. Recovery path only: an unlock entry that is missing or unreadable
 * cannot be repaired by any read, so it has to be rewritten before the wallet can
 * be reached at all. Seeds exactly what a successful unlock seeds and fires the
 * same notification, so recovery costs no second protected read.
 *
 * Two things the caller owns: proving the roots belong to the wallet this device
 * is signed into (this function overwrites the unlock entry and cannot check
 * that), and zeroizing the buffers afterwards. Nothing is deleted here — the
 * per-key entries stay untouched, so a failed write leaves the caller no worse
 * off than the unreadable entry it was already facing.
 */
export async function adoptRecoveredWalletKeys(
  bitcoinPrivateKey: Uint8Array,
  ethereumPrivateKey: Uint8Array,
): Promise<void> {
  await storeCombinedWalletKeys(bitcoinPrivateKey, ethereumPrivateKey);
  setPrivateKeyCache("bitcoin", bitcoinPrivateKey);
  setPrivateKeyCache("ethereum", ethereumPrivateKey);
  logWithId("🔐 Biometric", "combined entry rebuilt from passkey", {
    types: ["bitcoin", "ethereum", "nostr"],
  });
  notifyWalletUnlocked();
}

async function writeCombinedWalletKeys(
  entries: Record<CombinedWalletKeyType, string>,
): Promise<void> {
  try {
    const accessControl = await resolveBiometricAccessControl();
    try {
      await Keychain.resetInternetCredentials({ server: WALLET_KEYS_ID });
    } catch {}
    const stored = await Keychain.setInternetCredentials(
      WALLET_KEYS_ID,
      WALLET_KEYS_ID,
      JSON.stringify(entries),
      {
        accessControl,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
        authenticationPrompt: { title: t("screen.SecureKeyStorage.storeWalletKeyPrompt") },
      },
    );
    if (!stored) {
      throw new Error("Combined wallet keys write was not persisted");
    }
    logWithId("🔐 Biometric", "combined wallet keys entry written", {
      types: Object.keys(entries),
    });
  } catch (error: unknown) {
    logWithId("🔐 Biometric", "combined wallet keys write failed", errDescription(error));
    throw error;
  }
}

/**
 * Unlock-time read of all wallet keys with a single protected prompt. The
 * combined entry is the only unlock source: one read seeds Bitcoin and EVM,
 * then provisions and caches Nostr without another prompt. Missing, corrupt, or
 * incomplete entries fail closed into passkey relogin.
 */
let inFlightWalletUnlock: Promise<PrivateKeyType[]> | null = null;
// A read carries the generation it started under, which is how a failure that
// arrives after its attempt stopped speaking for the session is told apart from
// one that still does. Both endings retire whatever else is still running: an
// abandoned attempt, and a successful one.
let walletUnlockGeneration = 0;

function retireRunningWalletUnlocks(): void {
  walletUnlockGeneration += 1;
}

async function readCombinedWalletKeys(generation: number): Promise<PrivateKeyType[]> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    throw new Error("Biometric storage only supported on iOS and Android");
  }

  try {
    const credentials = await Keychain.getInternetCredentials(WALLET_KEYS_ID, {
      ...(Platform.OS === "android"
        ? {
            accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
          }
        : {}),
      authenticationPrompt: {
        title: t("screen.SecureKeyStorage.accessWalletTitle"),
        cancel: t("screen.SecureKeyStorage.cancel"),
      },
    });
    if (!credentials || !credentials.password) {
      throw new Error("Combined wallet keys entry unavailable");
    }

    const parsed = JSON.parse(credentials.password) as Partial<Record<PrivateKeyType, unknown>>;
    if (typeof parsed.bitcoin !== "string" || typeof parsed.ethereum !== "string") {
      throw new Error("Combined wallet keys entry incomplete");
    }

    let bitcoinBytes: Uint8Array | null = null;
    let ethereumBytes: Uint8Array | null = null;
    let nostrBytes: Uint8Array | null = null;
    try {
      bitcoinBytes = base64urlToBytes(parsed.bitcoin);
      ethereumBytes = base64urlToBytes(parsed.ethereum);
      if (bitcoinBytes.length !== 32 || ethereumBytes.length !== 32) {
        throw new Error("Combined wallet keys entry contains invalid key material");
      }
      nostrBytes = await getOrProvisionStoredNostrPrivateKey(bitcoinBytes);
      setPrivateKeyCache("bitcoin", bitcoinBytes);
      setPrivateKeyCache("ethereum", ethereumBytes);
      setPrivateKeyCache("nostr", nostrBytes);
      logWithId("🔐 Biometric", "unlockWalletKeys combined entry hit", {
        types: ["bitcoin", "ethereum", "nostr"],
      });
      // This session is now unlocked, and the layer above will close on it.
      // Every read still running belongs to an attempt that lost — retire them
      // so none of them can fail these keys away afterwards.
      retireRunningWalletUnlocks();
      notifyWalletUnlocked();
      return ["bitcoin", "ethereum", "nostr"];
    } finally {
      if (bitcoinBytes) wipeBytes(bitcoinBytes);
      if (ethereumBytes) wipeBytes(ethereumBytes);
      if (nostrBytes) wipeBytes(nostrBytes);
    }
  } catch (error: unknown) {
    // A read that has been retired — abandoned, or beaten to the unlock by
    // another one — no longer speaks for the session. Clearing here would wipe
    // the keys the winning attempt installed, and the app would sit unlocked
    // with nothing to sign with.
    const stale = generation !== walletUnlockGeneration;
    if (!stale) clearPrivateKeyCache();
    // Class and code, never the keychain's own message: it is provider text,
    // it is unbounded, and this log travels with a support report.
    logWithId("🔐 Biometric", "combined wallet unlock blocked", {
      ...errDescription(error),
      ...(stale ? { stale: 1 } : {}),
    });
    classifyBiometricError(error);
  }
}

/**
 * Stop serving the current in-flight unlock to new callers.
 *
 * The dedupe above exists so concurrent unlock requests share one system
 * prompt instead of stacking several. Its failure mode is a native read that
 * never settles: every later caller — including the user's manual retry — would
 * join that dead promise and no new ceremony could ever start. Callers that
 * time an attempt out drop the reference here so their next attempt performs a
 * real read again. The abandoned promise is left alone: if it does land later,
 * it still seeds the cache and notifies unlocked.
 *
 * What it may no longer do is FAIL on the session's behalf. Bumping the
 * generation retires the read: it stops speaking for the screen the moment it
 * is abandoned, so a rejection arriving after the retry succeeded cannot clear
 * the keys that retry installed.
 */
export function abandonInFlightWalletUnlock(): void {
  if (!inFlightWalletUnlock) return;
  inFlightWalletUnlock = null;
  retireRunningWalletUnlocks();
  logWithId("🔐 Biometric", "in-flight wallet unlock abandoned");
}

export async function unlockWalletKeys(): Promise<PrivateKeyType[]> {
  if (inFlightWalletUnlock) return inFlightWalletUnlock;

  const request = readCombinedWalletKeys(walletUnlockGeneration);
  inFlightWalletUnlock = request;
  try {
    return await request;
  } finally {
    if (inFlightWalletUnlock === request) {
      inFlightWalletUnlock = null;
    }
  }
}

async function readStoredNostrPrivateKey(): Promise<Uint8Array | null> {
  const credentials = await Keychain.getInternetCredentials(NOSTR_KEY_ID);
  if (credentials === false || !credentials.password) return null;
  const stored = base64urlToBytes(credentials.password);
  if (isValidNostrPrivateKey(stored)) return stored;
  wipeBytes(stored);
  throw new Error("Stored Nostr private key is invalid");
}

async function getOrProvisionStoredNostrPrivateKey(
  bitcoinPrivateKey: Uint8Array,
): Promise<Uint8Array> {
  const stored = await readStoredNostrPrivateKey();
  if (stored) return stored;

  const derived = deriveNostrPrivateKeyFromBitcoinKey(bitcoinPrivateKey);
  try {
    await storeNostrPrivateKey(derived);
    return cloneBytes(derived);
  } finally {
    wipeBytes(derived);
  }
}

/** Store the wallet-derived Nostr key without adding another biometric prompt. */
export async function storeNostrPrivateKey(privateKey: Uint8Array): Promise<void> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    throw new Error("Secure storage only supported on iOS and Android");
  }

  const base64Key = bytesToBase64url(privateKey);

  try {
    try {
      await Keychain.resetInternetCredentials({ server: NOSTR_KEY_ID });
    } catch {}
    await Keychain.setInternetCredentials(NOSTR_KEY_ID, NOSTR_KEY_ID, base64Key, {
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    setPrivateKeyCache("nostr", privateKey);
  } catch (error: unknown) {
    classifyBiometricError(error);
  }
}

/** Retrieve Nostr through the same combined wallet-access gate. */
export async function getNostrPrivateKey(): Promise<Uint8Array> {
  return getPrivateKey("nostr");
}

/**
 * Check if a Nostr private key exists in Keychain (no biometric prompt)
 */
export async function hasNostrPrivateKey(): Promise<boolean> {
  try {
    const [storedNostr, storedWallet] = await Promise.all([
      Keychain.hasInternetCredentials({ server: NOSTR_KEY_ID }),
      Keychain.hasInternetCredentials({ server: WALLET_KEYS_ID }),
    ]);
    return storedNostr || storedWallet;
  } catch {
    return false;
  }
}

/**
 * Delete Nostr private key from Keychain
 */
export async function deleteNostrPrivateKey(): Promise<void> {
  clearPrivateKeyCache("nostr");
  try {
    await Keychain.resetInternetCredentials({ server: NOSTR_KEY_ID });
  } catch {
    // Ignore errors if key doesn't exist
  }
}

/**
 * SwapKit HTLC provider roots (v2 wallet contract). Key material: every swap
 * key and preimage derives from these. Stored device-only WITHOUT a biometric
 * gate — mirrors the Nostr key — because a background swap resume must re-sign
 * without a prompt. Deterministic from the passkey PRF, so they are rewritten
 * identically on every PRF bootstrap and reproducible after reinstall+restore.
 */
export async function storeSwapKitHtlcRoots(roots: Record<string, Uint8Array>): Promise<void> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    throw new Error("Secure storage only supported on iOS and Android");
  }
  const payload = JSON.stringify(
    Object.fromEntries(Object.entries(roots).map(([k, v]) => [k, bytesToBase64url(v)])),
  );
  try {
    try {
      await Keychain.resetInternetCredentials({ server: SWAPKIT_HTLC_ROOTS_ID });
    } catch {}
    await Keychain.setInternetCredentials(SWAPKIT_HTLC_ROOTS_ID, SWAPKIT_HTLC_ROOTS_ID, payload, {
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (error: unknown) {
    classifyBiometricError(error);
  }
}

/**
 * SwapKit HTLC key-allocation state (nextKeyIndex + actionId allocations).
 * PUBLIC data, but it must share the HTLC roots' lifecycle: the roots are
 * deterministic from the PRF, so losing this counter while the roots survive
 * re-derives already-used preimages (the "satora-duplicate-preimage" loop).
 * A purgeable cache DB is therefore the wrong home — the keychain is.
 */
export async function storeSwapKitHtlcKeyState(json: string): Promise<void> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    throw new Error("Secure storage only supported on iOS and Android");
  }
  try {
    await Keychain.resetInternetCredentials({ server: SWAPKIT_HTLC_KEYSTATE_ID });
  } catch {}
  await Keychain.setInternetCredentials(SWAPKIT_HTLC_KEYSTATE_ID, SWAPKIT_HTLC_KEYSTATE_ID, json, {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/** The stored HTLC key-allocation state, or null (no biometrics required). */
export async function getSwapKitHtlcKeyState(): Promise<string | null> {
  try {
    // `?.` would not narrow this: getInternetCredentials returns `false`, not
    // null, when the entry is absent.
    const credentials = await Keychain.getInternetCredentials(SWAPKIT_HTLC_KEYSTATE_ID);
    if (!credentials) return null;
    return credentials.password || null;
  } catch {
    return null;
  }
}

/** One provider's HTLC root. Throws when absent (fail closed; re-login fixes it). */
export async function getSwapKitHtlcRoot(provider: string): Promise<Uint8Array> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    throw new Error("Secure storage only supported on iOS and Android");
  }
  if (appLocked) await waitForUnlock();
  const credentials = await Keychain.getInternetCredentials(SWAPKIT_HTLC_ROOTS_ID);
  const encoded = credentials
    ? (JSON.parse(credentials.password) as Record<string, string>)[provider]
    : undefined;
  if (!encoded) {
    throw new Error("SwapKit HTLC root missing. Sign in again to derive it.");
  }
  return base64urlToBytes(encoded);
}

/**
 * Store the public Bitcoin address (non-sensitive; no biometrics required).
 */
export async function storeBitcoinAddress(address: string): Promise<void> {
  const trimmed = String(address ?? "")
    .trim()
    .toLowerCase();
  if (!/^(bc1|tb1|bcrt1)[0-9a-z]{20,}$/.test(trimmed)) {
    throw new Error("Invalid Bitcoin address");
  }
  try {
    await Keychain.resetInternetCredentials({ server: BITCOIN_ADDRESS_ID });
  } catch {}

  await Keychain.setInternetCredentials(BITCOIN_ADDRESS_ID, BITCOIN_ADDRESS_ID, trimmed, {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * Retrieve the stored public Bitcoin address (no biometrics required).
 */
export async function getBitcoinAddress(): Promise<string | null> {
  try {
    const credentials = await Keychain.getInternetCredentials(BITCOIN_ADDRESS_ID);
    if (!credentials) return null;
    const addr = credentials.password ? String(credentials.password).trim().toLowerCase() : "";
    if (!addr) return null;
    if (!/^(bc1|tb1|bcrt1)[0-9a-z]{20,}$/.test(addr)) return null;
    return addr;
  } catch {
    return null;
  }
}

/**
 * Both receive-address caches are scoped to the wallet passkey credential that
 * derived them. The scope lives in the stored VALUE, not in the slot name: the
 * factory wipe resets a fixed list of slots (DEFAULT_KEYCHAIN_SERVERS) and
 * cannot enumerate per-credential ones, so credential-named slots would survive
 * it. Binding the value gives the same guarantee — a read under a different
 * credential returns null instead of the previous identity's address, and an
 * address is what a user pays into, so a stale one costs real money.
 *
 * A legacy unscoped entry (a bare address string, written before this) reads as
 * null for the same reason: it cannot be proven to belong to the current
 * credential. It is overwritten by the next successful load.
 */
type CredScopedAddress = {
  cred: string;
  addr: string;
};

const BTC_ADDRESS_RE = /^(bc1|tb1|bcrt1)[0-9a-z]{20,}$/;

function credScopeTag(credIdB64u: string | null | undefined): string {
  const credId = String(credIdB64u || "").trim();
  if (!credId) return "";
  return bytesToHex(sha256(new TextEncoder().encode(credId))).slice(0, 16);
}

function encodeCredScopedAddress(address: string, credIdB64u: string | null | undefined): string {
  const trimmed = String(address ?? "")
    .trim()
    .toLowerCase();
  if (!BTC_ADDRESS_RE.test(trimmed)) {
    throw new Error("Invalid Bitcoin address");
  }
  const cred = credScopeTag(credIdB64u);
  if (!cred) {
    throw new Error("Missing wallet credential for address cache");
  }
  return JSON.stringify({ cred, addr: trimmed } satisfies CredScopedAddress);
}

function decodeCredScopedAddress(
  raw: string | null | undefined,
  credIdB64u: string | null | undefined,
): string | null {
  const cred = credScopeTag(credIdB64u);
  if (!cred) return null;
  try {
    const parsed = JSON.parse(String(raw || "")) as Partial<CredScopedAddress> | null;
    if (!parsed || parsed.cred !== cred) return null;
    const addr = String(parsed.addr || "")
      .trim()
      .toLowerCase();
    return BTC_ADDRESS_RE.test(addr) ? addr : null;
  } catch {
    return null;
  }
}

async function writeAddressCacheSlot(slot: string, value: string): Promise<void> {
  try {
    await Keychain.resetInternetCredentials({ server: slot });
  } catch {}
  await Keychain.setInternetCredentials(slot, slot, value, {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

async function readAddressCacheSlot(slot: string): Promise<string | null> {
  try {
    const credentials = await Keychain.getInternetCredentials(slot);
    if (!credentials) return null;
    return credentials.password ? String(credentials.password) : null;
  } catch {
    return null;
  }
}

/**
 * Store the arkade boarding address in a dedicated keychain slot, separate from
 * BITCOIN_ADDRESS_ID, which holds the MuSig2 on-chain address. Both wallets are
 * live at once, so one slot cannot carry both addresses.
 */
export async function storeArkadeBoardingAddressCache(
  address: string,
  credIdB64u: string | null,
): Promise<void> {
  await writeAddressCacheSlot(
    ARKADE_BOARDING_ADDRESS_ID,
    encodeCredScopedAddress(address, credIdB64u),
  );
}

/**
 * The MuSig2 on-chain receive address, cached in its own slot. Deriving it needs
 * the wallet, which is loaded asynchronously — until then the home cannot tell
 * an identity that HAS an on-chain wallet from one that does not, and the rail
 * (and its balance) appeared seconds after everything else. Public data, so no
 * biometrics. Reads and writes go to the v4 slot only (see MUSIG2_ADDRESS_V4_ID).
 */
export async function storeMusig2AddressCache(
  address: string,
  credIdB64u: string | null,
): Promise<void> {
  await writeAddressCacheSlot(MUSIG2_ADDRESS_V4_ID, encodeCredScopedAddress(address, credIdB64u));
}

export async function getMusig2AddressCache(credIdB64u: string | null): Promise<string | null> {
  return decodeCredScopedAddress(await readAddressCacheSlot(MUSIG2_ADDRESS_V4_ID), credIdB64u);
}

/**
 * Clear the cached arkade boarding address (e.g. on account-change teardown so
 * a same-process re-login can't fall back to the previous identity's address).
 */
export async function clearArkadeBoardingAddressCache(): Promise<void> {
  try {
    await Keychain.resetInternetCredentials({ server: ARKADE_BOARDING_ADDRESS_ID });
  } catch {}
}

/**
 * Retrieve the cached arkade boarding address (no biometrics required).
 */
export async function getArkadeBoardingAddressCache(
  credIdB64u: string | null,
): Promise<string | null> {
  return decodeCredScopedAddress(
    await readAddressCacheSlot(ARKADE_BOARDING_ADDRESS_ID),
    credIdB64u,
  );
}

/**
 * Store the public Bitcoin pubkey (non-sensitive; no biometrics required).
 */
export async function storeBitcoinPublicKey(pubkeyHex: string): Promise<void> {
  const trimmed = String(pubkeyHex ?? "")
    .trim()
    .toLowerCase();
  if (!/^(02|03)[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error("Invalid Bitcoin public key");
  }
  try {
    await Keychain.resetInternetCredentials({ server: BITCOIN_PUBKEY_ID });
  } catch {}

  await Keychain.setInternetCredentials(BITCOIN_PUBKEY_ID, BITCOIN_PUBKEY_ID, trimmed, {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * Retrieve the stored public Bitcoin pubkey (no biometrics required).
 */
export async function getBitcoinPublicKey(): Promise<string | null> {
  try {
    const credentials = await Keychain.getInternetCredentials(BITCOIN_PUBKEY_ID);
    if (!credentials) return null;
    const pub = credentials.password ? String(credentials.password).trim().toLowerCase() : "";
    if (!pub) return null;
    if (!/^(02|03)[0-9a-f]{64}$/.test(pub)) return null;
    return pub;
  } catch {
    return null;
  }
}

/**
 * Delete the stored public Bitcoin address.
 */
export async function deleteBitcoinAddress(): Promise<void> {
  try {
    await Keychain.resetInternetCredentials({ server: BITCOIN_ADDRESS_ID });
  } catch {
    // Ignore errors if key doesn't exist
  }
}

/**
 * Delete the stored public Bitcoin pubkey.
 */
export async function deleteBitcoinPublicKey(): Promise<void> {
  try {
    await Keychain.resetInternetCredentials({ server: BITCOIN_PUBKEY_ID });
  } catch {
    // Ignore errors if key doesn't exist
  }
}

/**
 * Store the public Ethereum address (non-sensitive; no biometrics required).
 */
export async function storeEthereumAddress(address: string): Promise<void> {
  const trimmed = String(address ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error("Invalid Ethereum address");
  }
  try {
    await Keychain.resetInternetCredentials({ server: ETHEREUM_ADDRESS_ID });
  } catch {}

  await Keychain.setInternetCredentials(ETHEREUM_ADDRESS_ID, ETHEREUM_ADDRESS_ID, trimmed, {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * Retrieve the stored public Ethereum address (no biometrics required).
 */
export async function getEthereumAddress(): Promise<string | null> {
  try {
    const credentials = await Keychain.getInternetCredentials(ETHEREUM_ADDRESS_ID);
    if (!credentials) return null;
    const addr = credentials.password ? String(credentials.password).trim() : "";
    if (!addr) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
    return addr;
  } catch {
    return null;
  }
}

/**
 * Store the public Ethereum EOA public key (non-sensitive; no biometrics required).
 */
export async function storeEthereumPublicKey(pubkeyHex: string): Promise<void> {
  const trimmed = String(pubkeyHex ?? "")
    .trim()
    .toLowerCase();
  if (!/^0x04[0-9a-f]{128}$/.test(trimmed)) {
    throw new Error("Invalid Ethereum public key");
  }
  try {
    await Keychain.resetInternetCredentials({ server: ETHEREUM_PUBKEY_ID });
  } catch {}

  await Keychain.setInternetCredentials(ETHEREUM_PUBKEY_ID, ETHEREUM_PUBKEY_ID, trimmed, {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * Retrieve the stored public Ethereum EOA public key (no biometrics required).
 */
export async function getEthereumPublicKey(): Promise<string | null> {
  try {
    const credentials = await Keychain.getInternetCredentials(ETHEREUM_PUBKEY_ID);
    if (!credentials) return null;
    const pub = credentials.password ? String(credentials.password).trim().toLowerCase() : "";
    if (!pub) return null;
    if (!/^0x04[0-9a-f]{128}$/.test(pub)) return null;
    return pub;
  } catch {
    return null;
  }
}

/**
 * Delete the stored public Ethereum address.
 */
export async function deleteEthereumAddress(): Promise<void> {
  try {
    await Keychain.resetInternetCredentials({ server: ETHEREUM_ADDRESS_ID });
  } catch {
    // Ignore errors if key doesn't exist
  }
}

/**
 * Retrieve a private key through the combined wallet biometric access.
 * @param keyType The type of key to retrieve
 * @returns The private key bytes
 */
export async function getPrivateKey(keyType: PrivateKeyType): Promise<Uint8Array> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    throw new Error("Biometric storage only supported on iOS and Android");
  }

  // Locked: park until unlock (which seeds the cache) instead of prompting now.
  // A reset/sign-out (abortAppLock) rejects this wait → we throw, never prompt.
  if (appLocked) {
    await waitForUnlock();
  }

  const cached = getPrivateKeyFromCache(keyType);
  if (cached) {
    logWithId("🔐 Biometric", `getPrivateKey(${keyType}) cache hit`);
    return cached;
  }

  // A cache miss is always full wallet access: one combined keychain read
  // validates and caches Bitcoin, EVM, and Nostr, then emits the central
  // wallet-unlocked event. There is deliberately no per-key protected fallback.
  await unlockWalletKeys();
  const unlocked = getPrivateKeyFromCache(keyType);
  if (!unlocked) {
    throw new Error(`Combined wallet access did not provide ${keyType} key`);
  }
  logWithId("🔐 Biometric", `getPrivateKey(${keyType}) wallet cache hit`);
  return unlocked;
}

/**
 * Delete a private key from Keychain
 * @param keyType The type of key to delete
 */
export async function deletePrivateKey(keyType: "bitcoin" | "ethereum"): Promise<void> {
  const keyId = keyType === "bitcoin" ? BITCOIN_KEY_ID : ETHEREUM_KEY_ID;
  clearPrivateKeyCache(keyType);
  if (keyType === "bitcoin") clearPrivateKeyCache("nostr");

  try {
    await Keychain.resetInternetCredentials({ server: keyId });
  } catch (error) {
    // Ignore errors if key doesn't exist
    errorWithId("🔐 Biometric", `Failed to delete ${keyType} key`, error);
  }

  // The combined entry still holds this key — drop it with the per-key entry.
  try {
    await Keychain.resetInternetCredentials({ server: WALLET_KEYS_ID });
  } catch {}

  // The cached Bitcoin public key is derived from the Bitcoin private key; clear
  // it together with the private key so it can never outlive (or mismatch) its
  // key material.
  if (keyType === "bitcoin") {
    await deleteBitcoinPublicKey();
  }
}

/**
 * Check if a private key exists in Keychain
 * @param keyType The type of key to check
 * @returns True if the key exists
 */
export async function hasStoredKey(keyType: "bitcoin" | "ethereum"): Promise<boolean> {
  const keyId = keyType === "bitcoin" ? BITCOIN_KEY_ID : ETHEREUM_KEY_ID;

  try {
    const credentials = await Keychain.hasInternetCredentials({ server: keyId });
    return credentials;
  } catch {
    return false;
  }
}

/**
 * Whether first-time wallet bootstrap fully committed. The combined unlock entry
 * is written LAST (storePrivateKey clears it, storeCombinedWalletKeys writes it),
 * so its presence proves the whole per-key → combined sequence finished. A lone
 * per-key entry (process killed mid-bootstrap) is NOT a completed bootstrap:
 * unlockWalletKeys reads only this combined entry and has no per-key fallback.
 */
export async function hasCompletedWalletBootstrap(): Promise<boolean> {
  try {
    return await Keychain.hasInternetCredentials({ server: WALLET_KEYS_ID });
  } catch {
    return false;
  }
}

/**
 * Store auth-related data without biometric protection
 * Used for non-sensitive auth state like user ID, cosigner pubkey
 * @param key The storage key
 * @param value The value to store
 */
export async function storeAuthData(key: string, value: string): Promise<void> {
  await Keychain.setInternetCredentials(key, key, value, {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED,
  });
}

/**
 * Retrieve auth-related data
 * @param key The storage key
 * @returns The stored value or null
 */
export async function getAuthData(key: string): Promise<string | null> {
  try {
    const credentials = await Keychain.getInternetCredentials(key);
    if (!credentials) return null;
    return credentials.password || null;
  } catch {
    return null;
  }
}

/**
 * Delete auth-related data
 * @param key The storage key
 */
export async function deleteAuthData(key: string): Promise<void> {
  try {
    await Keychain.resetInternetCredentials({ server: key });
  } catch {
    // Ignore errors if key doesn't exist
  }
}

/**
 * Store HMAC auth key with biometric protection
 * @param authKeyHex The HMAC key as hex string
 */
export async function storeAuthKey(authKeyHex: string): Promise<void> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    throw new Error("Biometric storage only supported on iOS and Android");
  }

  try {
    const accessControl = await resolveBiometricAccessControl();
    await Keychain.setInternetCredentials(AUTH_KEY_ID, AUTH_KEY_ID, authKeyHex, {
      accessControl,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
      authenticationPrompt: { title: t("screen.SecureKeyStorage.storeAuthKeyPrompt") },
    });
  } catch (error: unknown) {
    classifyBiometricError(error);
  }
}

/**
 * Retrieve HMAC auth key with biometric authentication
 * @returns The auth key as hex string
 */
export async function getAuthKey(): Promise<string | null> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    throw new Error("Biometric storage only supported on iOS and Android");
  }

  try {
    const credentials = await Keychain.getInternetCredentials(AUTH_KEY_ID, {
      // Android read-side ACL must match the write-side (resolveBiometricAccessControl):
      // a DEVICE_PASSCODE-stored key (weak-biometric/PIN devices) only reads back when
      // the read declares BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE too.
      ...(Platform.OS === "android"
        ? {
            accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
          }
        : {}),
      authenticationPrompt: {
        title: t("screen.SecureKeyStorage.accessAuthKeyTitle"),
        subtitle: t("screen.SecureKeyStorage.accessAuthKeySubtitle"),
        cancel: t("screen.SecureKeyStorage.cancel"),
      },
    });

    if (!credentials) return null;
    if (credentials.password) {
      await upgradeNoAuthEntryIfNeeded(
        AUTH_KEY_ID,
        credentials.password,
        credentials.storage,
        t("screen.SecureKeyStorage.storeAuthKeyPrompt"),
      );
    }
    return credentials.password || null;
  } catch (error: unknown) {
    if (isBiometricPromptDismissal(error)) {
      throw new Error("Biometric authentication cancelled");
    }
    return null;
  }
}

/**
 * Delete HMAC auth key from Keychain
 */
export async function deleteAuthKey(): Promise<void> {
  try {
    await Keychain.resetInternetCredentials({ server: AUTH_KEY_ID });
  } catch {
    // Ignore errors if key doesn't exist
  }
}

/**
 * Wipe all known app keychain entries (internet + generic).
 * Pass extraServers to cover keys owned by other modules.
 */
export async function wipeAllKeychainData(extraServers: string[] = []): Promise<void> {
  clearPrivateKeyCache();
  const servers = Array.from(
    new Set(
      [...DEFAULT_KEYCHAIN_SERVERS, ...extraServers].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  );

  await Promise.allSettled(servers.map((server) => Keychain.resetInternetCredentials({ server })));

  try {
    const genericServices = await Keychain.getAllGenericPasswordServices();
    await Promise.allSettled(
      genericServices.map((service) => Keychain.resetGenericPassword({ service })),
    );
  } catch {}

  try {
    await Keychain.resetGenericPassword();
  } catch {}
}

/**
 * Check if HMAC auth key exists in Keychain (no biometric prompt)
 */
export async function hasAuthKey(): Promise<boolean> {
  try {
    // hasInternetCredentials expects an options object with server
    const present = await Keychain.hasInternetCredentials({ server: AUTH_KEY_ID });
    return !!present;
  } catch {
    return false;
  }
}

/**
 * Verify that the security-critical keychain entries are absent after a wipe.
 * Returns the list of residual key names ("bitcoin", "ethereum", "auth").
 * Empty list = wipe was successful for the security invariants.
 *
 * Used after `wipeAllKeychainData()` in flows where leaving the previous
 * identity's key material behind is a security failure (soft-logout and
 * factory-reset teardown, where the outgoing ETH/BTC/auth keys MUST be gone
 * before the app relaunches with a different credId).
 */
export async function verifyCriticalKeysAbsent(): Promise<string[]> {
  const checks = await Promise.all([
    hasStoredKey("bitcoin").then((present) => (present ? "bitcoin" : null)),
    hasStoredKey("ethereum").then((present) => (present ? "ethereum" : null)),
    Keychain.hasInternetCredentials({ server: WALLET_KEYS_ID })
      .then((present): string | null => (present ? "wallet_keys" : null))
      .catch((): string | null => null),
    hasAuthKey().then((present) => (present ? "auth" : null)),
  ]);
  return checks.filter((v): v is string => v !== null);
}

// Export storage key constants for AuthStateService
export const AUTH_STORAGE_KEYS = {
  USER_ID: USER_ID_KEY,
  COSIGNER_PUBKEY: COSIGNER_PUBKEY_ID,
  AUTH_FLAGS: AUTH_FLAGS_ID,
};
