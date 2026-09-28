/**
 * Web (PWA) implementation of secureKeyStorage. Mirrors the native module's
 * exported surface 1:1 so every consumer resolves it transparently via Metro's
 * `.web.ts` platform resolution — no caller changes.
 *
 * There is no Keychain / Secure Enclave / biometrics in a browser. The wallet's
 * second factor is the co-signing server, so the client key does NOT need
 * hardware backing: keys live in localStorage (same base64url encoding the
 * native Keychain used). Biometric/app-lock machinery collapses to no-ops.
 *
 * ponytail: localStorage, not IndexedDB or WebCrypto-wrapped blobs. The threat
 * model is "co-signer is the second signature", so a synchronous KV store is the
 * right size. Upgrade to IndexedDB + a passphrase-wrapped key only if the
 * product later drops the co-signer requirement.
 */

import { bytesToBase64url, base64urlToBytes, sha256 } from "./crypto";
import { bytesToHex } from "./bytes";
import { deriveNostrPrivateKeyFromBitcoinKey } from "./walletDerivation";

// Same identifiers the native Keychain used, so semantics match and a future
// import/migration path is trivial.
const BITCOIN_KEY_ID = "bitcoin_private_key";
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

const PREFIX = "nuri.sks.";

// localStorage is absent during static export/prerender and in some embedded
// contexts; fall back to an in-memory map so module load and SSR never throw.
const mem = new Map<string, string>();

function ls(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function setItem(id: string, value: string): void {
  const store = ls();
  if (store) {
    try {
      store.setItem(PREFIX + id, value);
      return;
    } catch {}
  }
  mem.set(id, value);
}

function getItem(id: string): string | null {
  const store = ls();
  if (store) {
    try {
      const value = store.getItem(PREFIX + id);
      if (value !== null) return value;
    } catch {}
  }
  return mem.has(id) ? (mem.get(id) as string) : null;
}

function removeItem(id: string): void {
  const store = ls();
  if (store) {
    try {
      store.removeItem(PREFIX + id);
    } catch {}
  }
  mem.delete(id);
}

// ── Biometric / app-lock no-ops (no biometrics in a browser) ────────────────

export function isBiometricPromptDismissal(_error: unknown): boolean {
  return false;
}

export function clearPrivateKeyMemoryCache(_keyType?: "bitcoin" | "ethereum" | "nostr"): void {}

export function setAppLocked(_locked: boolean): void {}

export function abortAppLock(): void {}

// A browser has no biometric prompt, but it does have the lock screen: a wallet
// whose keys went missing is repaired there from the passkey, and that repair
// has to announce itself or the screen never leaves. Same contract as native.
const walletUnlockedListeners = new Set<() => void>();

export function addWalletUnlockedListener(listener: () => void): () => void {
  walletUnlockedListeners.add(listener);
  return () => walletUnlockedListeners.delete(listener);
}

function notifyWalletUnlocked(): void {
  for (const listener of walletUnlockedListeners) {
    try {
      listener();
    } catch {}
  }
}

// ── SwapKit HTLC key material ───────────────────────────────────────────────
// Same storage tier as the wallet's private keys above: the co-signing server
// is the second factor, so these need no hardware backing. Identical ids and
// base64url payload shape as the native Keychain entries, so the two platforms
// stay interchangeable.

export async function storeSwapKitHtlcRoots(roots: Record<string, Uint8Array>): Promise<void> {
  setItem(
    SWAPKIT_HTLC_ROOTS_ID,
    JSON.stringify(
      Object.fromEntries(Object.entries(roots).map(([k, v]) => [k, bytesToBase64url(v)])),
    ),
  );
}

export async function storeSwapKitHtlcKeyState(json: string): Promise<void> {
  setItem(SWAPKIT_HTLC_KEYSTATE_ID, json);
}

export async function getSwapKitHtlcKeyState(): Promise<string | null> {
  return getItem(SWAPKIT_HTLC_KEYSTATE_ID);
}

/** One provider's HTLC root. Throws when absent (fail closed; re-login fixes it). */
export async function getSwapKitHtlcRoot(provider: string): Promise<Uint8Array> {
  const raw = getItem(SWAPKIT_HTLC_ROOTS_ID);
  const encoded = raw ? (JSON.parse(raw) as Record<string, string>)[provider] : undefined;
  if (!encoded) {
    throw new Error("SwapKit HTLC root missing. Sign in again to derive it.");
  }
  return base64urlToBytes(encoded);
}

// ── Private keys ────────────────────────────────────────────────────────────

export async function storePrivateKey(
  privateKey: Uint8Array,
  keyType: "bitcoin" | "ethereum",
): Promise<void> {
  setItem(keyType === "bitcoin" ? BITCOIN_KEY_ID : ETHEREUM_KEY_ID, bytesToBase64url(privateKey));
}

export async function getPrivateKey(
  keyType: "bitcoin" | "ethereum" | "nostr",
): Promise<Uint8Array> {
  const keyId =
    keyType === "bitcoin"
      ? BITCOIN_KEY_ID
      : keyType === "ethereum"
        ? ETHEREUM_KEY_ID
        : NOSTR_KEY_ID;
  const value = getItem(keyId);
  if (!value) throw new Error(`No ${keyType} key found in secure storage`);
  return base64urlToBytes(value);
}

export async function deletePrivateKey(keyType: "bitcoin" | "ethereum"): Promise<void> {
  removeItem(keyType === "bitcoin" ? BITCOIN_KEY_ID : ETHEREUM_KEY_ID);
  if (keyType === "bitcoin") await deleteBitcoinPublicKey();
}

export async function hasStoredKey(keyType: "bitcoin" | "ethereum"): Promise<boolean> {
  return getItem(keyType === "bitcoin" ? BITCOIN_KEY_ID : ETHEREUM_KEY_ID) !== null;
}

// Web mirror of the native predicate: there is no separate combined entry, and
// unlockWalletKeys only needs both per-key entries (Nostr is derived on demand),
// so a completed bootstrap is exactly both keys present.
export async function hasCompletedWalletBootstrap(): Promise<boolean> {
  const [hasBitcoin, hasEthereum] = await Promise.all([
    hasStoredKey("bitcoin"),
    hasStoredKey("ethereum"),
  ]);
  return hasBitcoin && hasEthereum;
}

// Web has no keychain prompt, but mirrors native provisioning so one wallet
// access makes Bitcoin, EVM, and Nostr available through the same API.
async function ensureNostrPrivateKey(bitcoinPrivateKey: Uint8Array): Promise<void> {
  if (await hasNostrPrivateKey()) return;
  const nostrPrivateKey = deriveNostrPrivateKeyFromBitcoinKey(bitcoinPrivateKey);
  try {
    await storeNostrPrivateKey(nostrPrivateKey);
  } finally {
    nostrPrivateKey.fill(0);
  }
}

// Native keeps ONE combined entry beside the per-key ones; here the per-key
// entries ARE the wallet, so this writes both. Deriving only the Nostr key left
// a recovery that reported success and changed nothing a read could find: the
// next unlock failed on the same missing keys, forever.
export async function storeCombinedWalletKeys(
  bitcoinPrivateKey: Uint8Array,
  ethereumPrivateKey: Uint8Array,
): Promise<void> {
  await storePrivateKey(bitcoinPrivateKey, "bitcoin");
  await storePrivateKey(ethereumPrivateKey, "ethereum");
  await ensureNostrPrivateKey(bitcoinPrivateKey);
}

// The lock screen's repair path: rebuild what a read could not find, then say
// so, because the signal is what dismisses the screen.
export async function adoptRecoveredWalletKeys(
  bitcoinPrivateKey: Uint8Array,
  ethereumPrivateKey: Uint8Array,
): Promise<void> {
  await storeCombinedWalletKeys(bitcoinPrivateKey, ethereumPrivateKey);
  notifyWalletUnlocked();
}

// Nothing to abandon: the web read below is not deduped behind a shared
// in-flight promise and raises no provider UI that could hang.
export function abandonInFlightWalletUnlock(): void {}

export async function unlockWalletKeys(): Promise<Array<"bitcoin" | "ethereum" | "nostr">> {
  const [hasBitcoin, hasEthereum] = await Promise.all([
    hasStoredKey("bitcoin"),
    hasStoredKey("ethereum"),
  ]);
  if (!hasBitcoin || !hasEthereum) throw new Error("Wallet keys incomplete in secure storage");
  if (!(await hasNostrPrivateKey())) {
    const bitcoinPrivateKey = await getPrivateKey("bitcoin");
    try {
      await ensureNostrPrivateKey(bitcoinPrivateKey);
    } finally {
      bitcoinPrivateKey.fill(0);
    }
  }
  notifyWalletUnlocked();
  return ["bitcoin", "ethereum", "nostr"];
}

// ── Nostr key (one-way-derived, non-biometric even on native) ────────────────

export async function storeNostrPrivateKey(privateKey: Uint8Array): Promise<void> {
  setItem(NOSTR_KEY_ID, bytesToBase64url(privateKey));
}

export async function getNostrPrivateKey(): Promise<Uint8Array> {
  const value = getItem(NOSTR_KEY_ID);
  if (!value) throw new Error("No Nostr key found in secure storage");
  return base64urlToBytes(value);
}

export async function hasNostrPrivateKey(): Promise<boolean> {
  return getItem(NOSTR_KEY_ID) !== null;
}

export async function deleteNostrPrivateKey(): Promise<void> {
  removeItem(NOSTR_KEY_ID);
}

// ── Public addresses / pubkeys (validated at the trust boundary) ─────────────

const BTC_ADDRESS_RE = /^(bc1|tb1|bcrt1)[0-9a-z]{20,}$/;
const BTC_PUBKEY_RE = /^(02|03)[0-9a-f]{64}$/;
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ETH_PUBKEY_RE = /^0x04[0-9a-f]{128}$/;

export async function storeBitcoinAddress(address: string): Promise<void> {
  const trimmed = String(address ?? "")
    .trim()
    .toLowerCase();
  if (!BTC_ADDRESS_RE.test(trimmed)) throw new Error("Invalid Bitcoin address");
  setItem(BITCOIN_ADDRESS_ID, trimmed);
}

export async function getBitcoinAddress(): Promise<string | null> {
  const addr = (getItem(BITCOIN_ADDRESS_ID) ?? "").trim().toLowerCase();
  return addr && BTC_ADDRESS_RE.test(addr) ? addr : null;
}

export async function deleteBitcoinAddress(): Promise<void> {
  removeItem(BITCOIN_ADDRESS_ID);
}

// Both receive-address caches are scoped to the wallet passkey credential that
// derived them, so a read under another credential can never hand back the
// previous identity's address — see the native module for why the scope lives
// in the value rather than in the key. A legacy unscoped entry reads as null.
type CredScopedAddress = {
  cred: string;
  addr: string;
};

function credScopeTag(credIdB64u: string | null | undefined): string {
  const credId = String(credIdB64u || "").trim();
  if (!credId) return "";
  return bytesToHex(sha256(new TextEncoder().encode(credId))).slice(0, 16);
}

function encodeCredScopedAddress(address: string, credIdB64u: string | null | undefined): string {
  const trimmed = String(address ?? "")
    .trim()
    .toLowerCase();
  if (!BTC_ADDRESS_RE.test(trimmed)) throw new Error("Invalid Bitcoin address");
  const cred = credScopeTag(credIdB64u);
  if (!cred) throw new Error("Missing wallet credential for address cache");
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

export async function storeArkadeBoardingAddressCache(
  address: string,
  credIdB64u: string | null,
): Promise<void> {
  setItem(ARKADE_BOARDING_ADDRESS_ID, encodeCredScopedAddress(address, credIdB64u));
}

export async function clearArkadeBoardingAddressCache(): Promise<void> {
  removeItem(ARKADE_BOARDING_ADDRESS_ID);
}

export async function getArkadeBoardingAddressCache(
  credIdB64u: string | null,
): Promise<string | null> {
  return decodeCredScopedAddress(getItem(ARKADE_BOARDING_ADDRESS_ID), credIdB64u);
}

// Reads and writes go to the v4 slot only (see MUSIG2_ADDRESS_V4_ID).
export async function storeMusig2AddressCache(
  address: string,
  credIdB64u: string | null,
): Promise<void> {
  setItem(MUSIG2_ADDRESS_V4_ID, encodeCredScopedAddress(address, credIdB64u));
}

export async function getMusig2AddressCache(credIdB64u: string | null): Promise<string | null> {
  return decodeCredScopedAddress(getItem(MUSIG2_ADDRESS_V4_ID), credIdB64u);
}

export async function storeBitcoinPublicKey(pubkeyHex: string): Promise<void> {
  const trimmed = String(pubkeyHex ?? "")
    .trim()
    .toLowerCase();
  if (!BTC_PUBKEY_RE.test(trimmed)) throw new Error("Invalid Bitcoin public key");
  setItem(BITCOIN_PUBKEY_ID, trimmed);
}

export async function getBitcoinPublicKey(): Promise<string | null> {
  const pub = (getItem(BITCOIN_PUBKEY_ID) ?? "").trim().toLowerCase();
  return pub && BTC_PUBKEY_RE.test(pub) ? pub : null;
}

export async function deleteBitcoinPublicKey(): Promise<void> {
  removeItem(BITCOIN_PUBKEY_ID);
}

export async function storeEthereumAddress(address: string): Promise<void> {
  const trimmed = String(address ?? "").trim();
  if (!ETH_ADDRESS_RE.test(trimmed)) throw new Error("Invalid Ethereum address");
  setItem(ETHEREUM_ADDRESS_ID, trimmed);
}

export async function getEthereumAddress(): Promise<string | null> {
  const addr = (getItem(ETHEREUM_ADDRESS_ID) ?? "").trim();
  return addr && ETH_ADDRESS_RE.test(addr) ? addr : null;
}

export async function deleteEthereumAddress(): Promise<void> {
  removeItem(ETHEREUM_ADDRESS_ID);
}

export async function storeEthereumPublicKey(pubkeyHex: string): Promise<void> {
  const trimmed = String(pubkeyHex ?? "")
    .trim()
    .toLowerCase();
  if (!ETH_PUBKEY_RE.test(trimmed)) throw new Error("Invalid Ethereum public key");
  setItem(ETHEREUM_PUBKEY_ID, trimmed);
}

export async function getEthereumPublicKey(): Promise<string | null> {
  const pub = (getItem(ETHEREUM_PUBKEY_ID) ?? "").trim().toLowerCase();
  return pub && ETH_PUBKEY_RE.test(pub) ? pub : null;
}

// ── Generic auth data (non-sensitive: user id, cosigner pubkey, flags) ───────

export async function storeAuthData(key: string, value: string): Promise<void> {
  setItem(key, value);
}

export async function getAuthData(key: string): Promise<string | null> {
  return getItem(key);
}

export async function deleteAuthData(key: string): Promise<void> {
  removeItem(key);
}

// ── HMAC auth key ────────────────────────────────────────────────────────────

export async function storeAuthKey(authKeyHex: string): Promise<void> {
  setItem(AUTH_KEY_ID, authKeyHex);
}

export async function getAuthKey(): Promise<string | null> {
  return getItem(AUTH_KEY_ID);
}

export async function deleteAuthKey(): Promise<void> {
  removeItem(AUTH_KEY_ID);
}

export async function hasAuthKey(): Promise<boolean> {
  return getItem(AUTH_KEY_ID) !== null;
}

// ── Bulk wipe / verification ─────────────────────────────────────────────────

export async function wipeAllKeychainData(_extraServers: string[] = []): Promise<void> {
  const store = ls();
  if (store) {
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith(PREFIX)) toRemove.push(k);
      }
      for (const k of toRemove) {
        try {
          store.removeItem(k);
        } catch {}
      }
    } catch {}
  }
  mem.clear();
}

export async function verifyCriticalKeysAbsent(): Promise<string[]> {
  const checks = await Promise.all([
    hasStoredKey("bitcoin").then((p) => (p ? "bitcoin" : null)),
    hasStoredKey("ethereum").then((p) => (p ? "ethereum" : null)),
    hasAuthKey().then((p) => (p ? "auth" : null)),
  ]);
  return checks.filter((v): v is string => v !== null);
}

export const AUTH_STORAGE_KEYS = {
  USER_ID: USER_ID_KEY,
  COSIGNER_PUBKEY: COSIGNER_PUBKEY_ID,
  AUTH_FLAGS: AUTH_FLAGS_ID,
};

// Referenced by the native module's bulk-wipe default list; kept exported-adjacent
// here only to document parity. Not part of the public API.
void [
  COSIGNER_PUBKEY_COMPRESSED_ID,
  WALLET_PUBLIC_KEYS_ID,
  BIOMETRIC_SENTINEL_ID,
  BIOMETRIC_SENTINEL_MARKER_ID,
];
