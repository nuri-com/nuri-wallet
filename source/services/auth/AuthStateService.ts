/**
 * Authentication State Management Service
 * Manages user authentication state, HMAC keys, and co-signer registration
 */

import * as Keychain from "react-native-keychain";
import {
  storeAuthData,
  getAuthData,
  deleteAuthData,
  hasAuthKey,
  hasStoredKey,
  deleteAuthKey,
  AUTH_STORAGE_KEYS,
} from "../../lib/secureKeyStorage";
import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { randomBytes, bytesToHex, hexToBytes } from "../../lib/bytes";
import { hmacSha256, utf8ToBytes } from "../../lib/crypto/index";
import { disableSharedCookiesOnce } from "../app/WebViewSessionService";
import { homeCurrencyService } from "../../lib/currency/HomeCurrencyService";

export interface AuthState {
  isSignedIn: boolean;
  userId: string | null;
  authKeyHex: string | null;
  cosignerPubkey: string | null; // compressed 33 from /info
  isRegistered: boolean;
  hasPasskey: boolean;
  hasCosignerKey: boolean; // Whether c_xonly is cached locally
  walletPasskeyNameBase?: string | null;
  /** Verified Nuri handle for this wallet. Identity metadata, not display cache. */
  walletUsername?: string | null;
  /** Set once the MuSig2+CSV on-chain wallet exists for this identity. */
  walletCreated?: "musig2+csv" | null;
  walletPublicKeys?: {
    // The wallet passkey credential identifies the wallet to arkade (read by
    // ArkadeRemoteIdentity / ArkadeRecoveryBackupService). The remaining fields
    // carry the MuSig2 on-chain wallet's keys.
    walletPasskeyCredIdB64u?: string;
    walletPasskeyCredPubkeyB64u?: string;
    // The user's own key — shared by both on-chain wallets (same PRF derivation).
    userExternal?: string;
    userInternal?: string;
    // Historical fields retained only for storage-schema compatibility. Current
    // wallet derivation never reads them; v4 aggregate lives in signer context.
    aggregatedExternal?: string;
    aggregatedInternal?: string;
    cosigner?: string;
  } | null;
  arkadeSignerContext?: {
    clientPk33: string;
    serverPk33: string;
    aggregatedPk33: string;
    aggregatedXonly32: string;
    signerUrl: string;
    updatedAtMs: number;
  } | null;
}

export type ArkadeSignerContext = NonNullable<AuthState["arkadeSignerContext"]>;

class AuthStateManager {
  private static instance: AuthStateManager;
  private loadPromise: Promise<void> | null = null;
  private hasLoadedFromStorage = false;
  private authState: AuthState = {
    isSignedIn: false,
    userId: null,
    authKeyHex: null,
    cosignerPubkey: null,
    isRegistered: false,
    hasPasskey: false, // Passkey #2 status
    hasCosignerKey: false, // C key status
    walletPasskeyNameBase: null,
    walletUsername: null,
    walletPublicKeys: null, // Cached public keys
    arkadeSignerContext: null,
  };

  private listeners: Set<(state: AuthState) => void> = new Set();

  private async deriveSignedInFromKeys(
    walletPublicKeys?: AuthState["walletPublicKeys"] | null,
  ): Promise<boolean> {
    try {
      const [hasEthKey, hasBtcKey] = await Promise.all([
        hasStoredKey("ethereum"),
        hasStoredKey("bitcoin"),
      ]);
      return Boolean(hasEthKey || hasBtcKey || walletPublicKeys);
    } catch {
      return Boolean(walletPublicKeys);
    }
  }

  private constructor() {
    // Load state asynchronously on construction
    this.ensureLoadPromise().catch((error) => {
      console.error("[AuthStateService:constructor] Failed to load initial auth state:", error);
    });
  }

  static getInstance(): AuthStateManager {
    if (!AuthStateManager.instance) {
      AuthStateManager.instance = new AuthStateManager();
    }
    return AuthStateManager.instance;
  }

  // Ensure auth state is loaded from storage at most once, sharing the same promise across callers.
  private ensureLoadPromise(): Promise<void> {
    if (this.hasLoadedFromStorage && !this.loadPromise) {
      return Promise.resolve();
    }
    if (!this.loadPromise) {
      this.loadPromise = this.loadStoredState()
        .catch((error) => {
          // Propagate error to callers; allow subsequent retries.
          throw error;
        })
        .finally(() => {
          this.hasLoadedFromStorage = true;
          this.loadPromise = null;
        });
    }
    return this.loadPromise;
  }

  // Load stored authentication state
  private async loadStoredState() {
    const op = newOp("AuthStateService", "loadStoredState", LOG_EMOJI.auth);
    op.log("Loading Auth State");
    try {
      const userId = await getAuthData(AUTH_STORAGE_KEYS.USER_ID);
      const cosignerPubkey = await getAuthData(AUTH_STORAGE_KEYS.COSIGNER_PUBKEY);

      // Load flags as JSON
      const flagsStr = await getAuthData(AUTH_STORAGE_KEYS.AUTH_FLAGS);
      const flags = flagsStr ? JSON.parse(flagsStr) : {};

      // Check if user has stored auth key (no biometric prompt)
      const hasAuthKeyPresent = await hasAuthKey();

      // Load wallet public keys if they exist
      let walletPublicKeys = null;
      try {
        const keysStr = await getAuthData("@auth:wallet_public_keys");
        if (keysStr) {
          walletPublicKeys = JSON.parse(keysStr);
        }
      } catch (_error) {
        console.log("[AuthStateService:loadStoredState] No stored public keys found");
      }

      let arkadeSignerContext: ArkadeSignerContext | null = null;
      try {
        const contextStr = await getAuthData("@auth:arkade_signer_context");
        if (contextStr) {
          arkadeSignerContext = JSON.parse(contextStr);
        }
      } catch (_error) {
        console.log("[AuthStateService:loadStoredState] No stored Arkade signer context found");
      }

      const isSignedInFromKeys = await this.deriveSignedInFromKeys(walletPublicKeys);

      this.authState = {
        isSignedIn: isSignedInFromKeys,
        userId,
        authKeyHex: null, // Don't load auth key until actual sign-in
        cosignerPubkey,
        isRegistered: flags.isRegistered || false,
        hasPasskey: flags.hasPasskey || false, // Passkey #2 enrollment status
        hasCosignerKey: !!cosignerPubkey, // Track c_xonly presence
        walletPasskeyNameBase:
          typeof flags.walletPasskeyNameBase === "string" ? flags.walletPasskeyNameBase : null,
        walletUsername: typeof flags.walletUsername === "string" ? flags.walletUsername : null,
        walletCreated: flags.walletCreated === "musig2+csv" ? "musig2+csv" : null,
        walletPublicKeys,
        arkadeSignerContext,
      };

      console.log("[AuthStateService:loadStoredState] Auth state loaded:", {
        isSignedIn: this.authState.isSignedIn,
        userId: this.authState.userId,
        hasAuthKey: hasAuthKeyPresent,
        signedInFromKeys: isSignedInFromKeys,
        hasCosignerKey: this.authState.hasCosignerKey,
        isRegistered: this.authState.isRegistered,
        hasPasskey: this.authState.hasPasskey,
        walletPasskeyNameBase: this.authState.walletPasskeyNameBase,
        hasArkadeSignerContext: !!this.authState.arkadeSignerContext,
      });

      // If flags claim hasAuthKey but Keychain no longer has it, fix flags
      if (flags.hasAuthKey && !hasAuthKeyPresent) {
        try {
          await this.updateAuthFlags({ hasAuthKey: false });
        } catch {}
      }
      this.notifyListeners();
      op.end("Loaded");
    } catch (error) {
      console.error("[AuthStateService:loadStoredState] Failed to load auth state:", error);
    }
  }

  // Sign in with passkey (primary authentication)
  // Note: PRF no longer needed - auth uses separate HMAC key
  async signInWithPasskey(userId: string): Promise<void> {
    const op = newOp("AuthStateService", "signInWithPasskey", LOG_EMOJI.auth);
    op.log("Sign In With Passkey");
    console.log("[AuthStateService:signInWithPasskey] User ID:", userId);

    // Store user ID only. Do not auto-register with co-signer.
    await storeAuthData(AUTH_STORAGE_KEYS.USER_ID, userId);
    await this.updateAuthFlags({ isRegistered: false, hasAuthKey: false });
    this.authState.userId = userId;
    this.authState.isSignedIn = await this.deriveSignedInFromKeys(this.authState.walletPublicKeys);
    console.log(
      "[AuthStateService:signInWithPasskey] Sign-in stored user id (no co-signer registration)",
    );
    this.notifyListeners();
    op.end("Signed in");
  }

  // Helper to update auth flags
  private async updateAuthFlags(
    updates: Partial<{
      isRegistered: boolean;
      hasPasskey: boolean;
      hasAuthKey: boolean;
      walletPasskeyNameBase: string | null;
      walletUsername: string | null;
      walletCreated: "musig2+csv" | null;
    }>,
  ): Promise<void> {
    const flagsStr = await getAuthData(AUTH_STORAGE_KEYS.AUTH_FLAGS);
    const flags = flagsStr ? JSON.parse(flagsStr) : {};
    const newFlags = { ...flags, ...updates };
    await storeAuthData(AUTH_STORAGE_KEYS.AUTH_FLAGS, JSON.stringify(newFlags));
  }

  // Generate HMAC headers for authenticated requests
  async generateHMACHeaders(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, string>> {
    const op = newOp("AuthStateService", "generateHMACHeaders", LOG_EMOJI.auth);
    if (!this.authState.userId || !this.authState.authKeyHex) {
      throw new Error("Not authenticated");
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const nonceBytes = randomBytes(16);
    const nonce = bytesToHex(nonceBytes);

    const bodyStr = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
    const message = `${method}\n${path}\n${bodyStr}\n${timestamp}|${nonce}`;

    const signature = bytesToHex(
      hmacSha256(hexToBytes(this.authState.authKeyHex), utf8ToBytes(message)),
    );

    const headers = {
      "X-User-Id": this.authState.userId,
      "X-Ts": timestamp.toString(),
      "X-Nonce": nonce,
      "X-Sig": signature,
    };
    op.end("Headers ready");
    return headers;
  }

  // Get current auth state
  getState(): AuthState {
    return { ...this.authState };
  }

  // Initialize and wait for auth state to load
  async initialize(): Promise<void> {
    const op = newOp("AuthStateService", "initialize", LOG_EMOJI.auth);
    try {
      await this.ensureLoadPromise();
      op.end("Initialized");
    } catch (error) {
      op.error("Initialize failed", error);
      op.end("Error");
      throw error;
    }
  }

  // Subscribe to auth state changes
  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Notify all listeners of state change
  private notifyListeners() {
    this.listeners.forEach((listener) => listener(this.getState()));
  }

  // Sign out
  async signOut(): Promise<void> {
    const op = newOp("AuthStateService", "signOut", LOG_EMOJI.auth);
    console.log("[AuthStateService:signOut] \n=== Sign Out ===");

    // Clear secure storage
    await deleteAuthData(AUTH_STORAGE_KEYS.USER_ID);
    // Keep auth key and cosigner key for next sign-in

    this.authState.userId = null;
    this.authState.isSignedIn = await this.deriveSignedInFromKeys(this.authState.walletPublicKeys);

    console.log("[AuthStateService:signOut] Signed out successfully");
    this.notifyListeners();
    op.end("Signed out");
  }

  // Clear all data (factory reset)
  async clearAllData(): Promise<void> {
    const op = newOp("AuthStateService", "clearAllData", LOG_EMOJI.auth);
    console.log("[AuthStateService:clearAllData] \n=== Clear All Data ===");

    // Clear all secure storage
    await deleteAuthData(AUTH_STORAGE_KEYS.USER_ID);
    await deleteAuthData(AUTH_STORAGE_KEYS.COSIGNER_PUBKEY);
    await deleteAuthData("COSIGNER_PUBKEY_COMPRESSED");
    await deleteAuthData(AUTH_STORAGE_KEYS.AUTH_FLAGS);
    // Remove cached wallet public keys if present
    await deleteAuthData("@auth:wallet_public_keys");
    await deleteAuthData("@auth:arkade_signer_context");
    // Remove HMAC auth key as part of full reset
    try {
      await deleteAuthKey();
    } catch {}

    // legacy Gnosis keychain cleanup (Gnosis Pay removed)
    try {
      await Keychain.resetInternetCredentials({ server: "gnosis_user_cards_cache" });
    } catch {}
    try {
      await Keychain.resetInternetCredentials({ server: "gnosis_jwt_token" });
    } catch {}
    try {
      await Keychain.resetInternetCredentials({ server: "gnosis_jwt_expiry" });
    } catch {}

    // Clear persisted home-currency cache so next user doesn't inherit it
    try {
      await deleteAuthData("@cache:safeCurrency");
      homeCurrencyService.reset();
    } catch {}

    // Ensure next WebView auth uses an isolated cookie jar (simulate fresh install)
    try {
      disableSharedCookiesOnce();
    } catch {}

    // Reset in-memory auth state and initialization bookkeeping
    this.authState = {
      isSignedIn: false,
      userId: null,
      authKeyHex: null,
      cosignerPubkey: null,
      isRegistered: false,
      hasPasskey: false,
      hasCosignerKey: false,
      walletPasskeyNameBase: null,
      walletUsername: null,
      walletPublicKeys: null,
      arkadeSignerContext: null,
    };
    this.hasLoadedFromStorage = false;
    this.loadPromise = null;

    console.log(
      "[AuthStateService:clearAllData] All data cleared; post-reset auth state =",
      this.authState,
    );
    this.notifyListeners();
    op.end("Finished");
  }

  // Persist wallet passkey metadata inside cached wallet public keys.
  // If walletPasskeyCredPubkeyB64u is omitted, existing pubkey is preserved.
  // If walletPasskeyCredPubkeyB64u is provided as empty string, stored pubkey is cleared.
  async upsertWalletPasskeyMetadata(
    walletPasskeyCredIdB64u: string,
    walletPasskeyCredPubkeyB64u?: string,
    clientPk33?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const credId = String(walletPasskeyCredIdB64u || "").trim();
    const hasCredPubkeyInput = walletPasskeyCredPubkeyB64u !== undefined;
    const credPubkey = hasCredPubkeyInput
      ? String(walletPasskeyCredPubkeyB64u || "").trim()
      : undefined;
    if (!credId) {
      return { ok: false, reason: "missing_cred_id" };
    }
    // The client signing pubkey (arkade clientPk33 / userExternal). Required by
    // ArkadeRemoteIdentity alongside the credential id.
    const userExternal = String(clientPk33 || "").trim() || undefined;

    await this.ensureLoadPromise();
    // Create-if-missing: the wallet passkey credential is what arkade needs to
    // init, so this must persist a record even on a fresh install/restore where
    // no prior @auth:wallet_public_keys exists yet.
    const existing = this.authState.walletPublicKeys ?? {};

    const merged = {
      ...existing,
      walletPasskeyCredIdB64u: credId,
      walletPasskeyCredPubkeyB64u: hasCredPubkeyInput
        ? credPubkey || undefined
        : existing.walletPasskeyCredPubkeyB64u || undefined,
      userExternal: userExternal || existing.userExternal,
      userInternal: userExternal || existing.userInternal,
    };

    await storeAuthData("@auth:wallet_public_keys", JSON.stringify(merged));
    this.authState.walletPublicKeys = merged;
    this.authState.isSignedIn = await this.deriveSignedInFromKeys(this.authState.walletPublicKeys);
    this.notifyListeners();
    return { ok: true };
  }

  async getCosignerCompressedPubkey(): Promise<string | null> {
    try {
      // Only accept the actual 33-byte compressed key stored during setup
      const compressed = await getAuthData("COSIGNER_PUBKEY_COMPRESSED");
      return compressed || null;
    } catch (error) {
      console.error(
        "[AuthStateService:getCosignerCompressedPubkey] Failed to get cosigner compressed pubkey:",
        error,
      );
      return null;
    }
  }

  /**
   * Record that the MuSig2+CSV on-chain wallet exists and cache its public keys.
   *
   * MERGES into `@auth:wallet_public_keys` rather than overwriting it. The same
   * record also holds the wallet passkey credential that ArkadeRemoteIdentity
   * needs to initialize, written independently by the PRF bootstrap — a
   * wholesale overwrite here would drop those fields and break arkade init for
   * any identity that bootstrapped arkade before creating the on-chain wallet.
   */
  async markWalletCreated(payload: {
    walletType: "musig2+csv";
    walletPublicKeys: NonNullable<AuthState["walletPublicKeys"]>;
  }): Promise<void> {
    if (!payload?.walletPublicKeys) {
      throw new Error("markWalletCreated requires walletPublicKeys");
    }
    const op = newOp("AuthStateService", "markWalletCreated", LOG_EMOJI.auth);
    try {
      await this.ensureLoadPromise();
      const merged = {
        ...(this.authState.walletPublicKeys ?? {}),
        ...payload.walletPublicKeys,
      };
      await storeAuthData("@auth:wallet_public_keys", JSON.stringify(merged));
      await this.updateAuthFlags({ walletCreated: payload.walletType });
      this.authState.walletPublicKeys = merged;
      this.authState.walletCreated = payload.walletType;
      this.authState.isSignedIn = true;
      this.notifyListeners();
      op.end("Done");
    } catch (e) {
      op.error("Failed to mark wallet created", e as Error);
      throw e;
    }
  }

  async setWalletPasskeyNameBase(value: string | null): Promise<void> {
    const normalized = typeof value === "string" && value.trim() ? value.trim() : null;
    await this.updateAuthFlags({ walletPasskeyNameBase: normalized });
    this.authState.walletPasskeyNameBase = normalized;
    this.notifyListeners();
  }

  async setWalletUsername(value: string): Promise<void> {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(normalized)) {
      throw new Error("wallet username is invalid");
    }
    await this.ensureLoadPromise();
    await this.updateAuthFlags({ walletUsername: normalized });
    this.authState.walletUsername = normalized;
    this.notifyListeners();
  }

  async markPasskeyUnregistered(): Promise<void> {
    await this.updateAuthFlags({ hasPasskey: false });
    this.authState.hasPasskey = false;
    this.notifyListeners();
  }

  async upsertArkadeSignerContext(context: ArkadeSignerContext): Promise<void> {
    await storeAuthData("@auth:arkade_signer_context", JSON.stringify(context));
    this.authState.arkadeSignerContext = context;
    this.notifyListeners();
  }

  async clearArkadeSignerContext(): Promise<void> {
    if (!this.authState.arkadeSignerContext) {
      await deleteAuthData("@auth:arkade_signer_context").catch(() => {});
      return;
    }
    await deleteAuthData("@auth:arkade_signer_context");
    this.authState.arkadeSignerContext = null;
    this.notifyListeners();
  }

  // Persisted list of addresses this user previously controlled. Nothing in the
  // app writes or reads it any more — the app reads exactly its current wallet,
  // and moving an old one is the separate product on v1.nuri.com — but an entry
  // an older install left behind is identity-bearing, so the teardown paths
  // still have to be able to read it back and prove it is gone.
  async getPreviousAddresses(): Promise<{ ethereum: string[]; bitcoin: string[] }> {
    try {
      const raw = await getAuthData("@auth:previous_addresses");
      if (!raw) return { ethereum: [], bitcoin: [] };
      const parsed = JSON.parse(raw);
      return {
        ethereum: Array.isArray(parsed?.ethereum) ? parsed.ethereum.filter(Boolean) : [],
        bitcoin: Array.isArray(parsed?.bitcoin) ? parsed.bitcoin.filter(Boolean) : [],
      };
    } catch {
      return { ethereum: [], bitcoin: [] };
    }
  }

  // Drops that list. Required when the next sign-in may be a DIFFERENT account
  // (soft logout with no preserved hint, factory reset): the addresses name who
  // was signed in, so leaving them on the device carries one account's identity
  // into the next one's session.
  //
  // Fail-closed: `deleteAuthData` swallows keychain errors, so a resolved
  // promise is not evidence the entry is gone. This is identity-bearing data —
  // the caller has to be able to abort the relaunch when it survives, which it
  // can only do if the read-back throws.
  async clearPreviousAddresses(): Promise<void> {
    await deleteAuthData("@auth:previous_addresses");
    const residual = await getAuthData("@auth:previous_addresses");
    if (residual) {
      throw new Error("Previous-address list still present after delete");
    }
  }

  async addPreviousAddress(kind: "ethereum" | "bitcoin", address: string): Promise<void> {
    const normalized = String(address || "").trim();
    if (!normalized) return;
    const current = await this.getPreviousAddresses();
    const list = current[kind];
    if (list.includes(normalized)) return;
    const next = { ...current, [kind]: [...list, normalized] };
    await storeAuthData("@auth:previous_addresses", JSON.stringify(next));
  }

  /**
   * Re-stash login hints after `clearAllData()`. Used by SoftLogoutService to
   * preserve "Continue with @<name>" UX across a hard reload while wiping
   * everything else. Writes a minimal walletPublicKeys (legacy MuSig2+CSV
   * fields empty — they're unreachable in arkade mode) and refreshes
   * AUTH_FLAGS with walletPasskeyNameBase only.
   */
  async setLoginHintAfterWipe(opts: {
    credIdB64u: string;
    credPubkeyB64u?: string;
    walletPasskeyNameBase?: string;
  }): Promise<void> {
    const credId = String(opts.credIdB64u || "").trim();
    if (!credId) return;
    const credPubkey = String(opts.credPubkeyB64u || "").trim();
    const nameBase = String(opts.walletPasskeyNameBase || "").trim();

    const minimal = {
      userExternal: "",
      userInternal: "",
      aggregatedExternal: "",
      aggregatedInternal: "",
      cosigner: "",
      walletPasskeyCredIdB64u: credId,
      walletPasskeyCredPubkeyB64u: credPubkey || undefined,
    };
    await storeAuthData("@auth:wallet_public_keys", JSON.stringify(minimal));
    this.authState.walletPublicKeys = minimal;

    if (nameBase) {
      await this.updateAuthFlags({ walletPasskeyNameBase: nameBase });
      this.authState.walletPasskeyNameBase = nameBase;
    }

    this.notifyListeners();
  }
}

// Export singleton instance
export const authStateManager = AuthStateManager.getInstance();
