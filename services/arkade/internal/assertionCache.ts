// WebAuthn assertion cache for the arkade signer. Owns the singleton
// assertion cache, the optional in-flight assertion promise, and the
// auth_begin-combined-with-prompt flow used by the signing-key vault.
//
// The cache is module-scoped (shared across ArkadeRemoteIdentity instances)
// to match the previous "sharedAssertionCache" semantics in
// ArkadeRemoteIdentity.ts.
import { AppState } from "react-native";
import { AUTH_CACHE_TTL_MS } from "../../../config/constants";
import { shortTime } from "../../../lib/logShared";
import { getWalletPasskeyAssertion } from "../../auth/PasskeyNativeModuleService";
import { arkadeAuthBegin } from "../ArkadeApiService";
import {
  ARKADE_CLIENT_VERSION,
  ARKADE_EXPECTED_SIGNER_SERVER,
  NURI_SERVER_API_VERSION,
} from "../ArkadeVersion";

const ARKADE_SIGN_TRACE_MARKER = "ARKADE_SIGN_TRACE_V2_20260417";

export type AssertionPromptKind = "passkey_assertion" | "passkey_prf_assertion";

export type PasskeyAssertionPayload = {
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};

export type SigningAssertionPayload = {
  token: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};

export type CachedAssertion = {
  credIdB64u: string;
  token: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
  promptKind: AssertionPromptKind;
  createdAtMs: number;
};

export type CredentialMetaForAssertion = {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientPk33: string;
};

export type PublicContextForAssertion = {
  clientPk33: string;
};

export type ArkadeAuthBeginResponse = Awaited<ReturnType<typeof arkadeAuthBegin>>;

export type CombinedAssertionAuthState = "cache_hit" | "inflight" | "miss";

export type AssertionCacheDeps = {
  getCredentialMeta: () => CredentialMetaForAssertion;
  getPublicContext: () => Promise<PublicContextForAssertion>;
  withClientSigningKeyScope: <T>(reason: string, fn: () => Promise<T>) => Promise<T>;
  clearSigningKeyCache: (reason: string) => void;
  getSigningKey: (
    expectedClientPk33: string,
    reason: string,
    combinedAssertionAuth: ArkadeAuthBeginResponse,
  ) => Promise<Uint8Array>;
};

let sharedAssertionCache: CachedAssertion | null = null;
// Per-credId in-flight map. A single global Promise would let a concurrent
// caller for credential B receive credential A's assertion result during the
// brief overlap between auth_begin and the cached assertion being committed.
// Keying by credIdB64u prevents the cross-credential leak.
const sharedAssertionInFlight = new Map<string, Promise<CachedAssertion>>();

function signTraceValue(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "string") return value.replace(/\s+/g, "_");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.join(",");
  return String(value).replace(/\s+/g, "_");
}

function logArkadeSignTrace(step: string, fields: Record<string, unknown> = {}): void {
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${signTraceValue(value)}`)
    .join(" ");
  console.log(
    `🔐 [${shortTime()} ${ARKADE_SIGN_TRACE_MARKER}] nuri_server_api=${NURI_SERVER_API_VERSION} step=${step}${detail ? ` ${detail}` : ""}`,
  );
}

function shortRef(value: string, head = 8, tail = 4): string {
  const raw = String(value || "").trim();
  if (!raw) return "n/a";
  if (tail <= 0) {
    return raw.length <= head ? raw : `${raw.slice(0, head)}...`;
  }
  if (raw.length <= head + tail + 3) return raw;
  return `${raw.slice(0, head)}...${raw.slice(-tail)}`;
}

function assertExpectedSignerServerVersion(serverVersion: string, source: string): void {
  const got = String(serverVersion || "").trim();
  if (!got || got === ARKADE_EXPECTED_SIGNER_SERVER) return;
  console.log(
    `🔐 [${shortTime()} src=services/arkade/ArkadeRemoteIdentity.ts#assertExpectedSignerServerVersion ERROR VALIDATION grp=Bitcoin] expected=${ARKADE_EXPECTED_SIGNER_SERVER} got=${got} client=${ARKADE_CLIENT_VERSION} source=${source}`,
  );
  throw new Error(
    `arkade signer server version mismatch expected=${ARKADE_EXPECTED_SIGNER_SERVER} got=${got}`,
  );
}

export class AssertionCache {
  constructor(private readonly deps: AssertionCacheDeps) {}

  clearAssertionCache(reason: string): void {
    sharedAssertionCache = null;
    console.log(`🔐 [${shortTime()} ArkadeRemoteIdentity.authCache] action=clear reason=${reason}`);
  }

  async getCachedAssertion(meta: CredentialMetaForAssertion): Promise<CachedAssertion | null> {
    const cached = sharedAssertionCache;
    if (!cached) return null;
    if (cached.credIdB64u !== meta.credIdB64u) {
      this.clearAssertionCache("cred_changed");
      return null;
    }
    const ageMs = Date.now() - cached.createdAtMs;
    if (ageMs < 0 || ageMs > AUTH_CACHE_TTL_MS) {
      this.clearAssertionCache("expired");
      return null;
    }
    return cached;
  }

  async beginCombinedAssertionAuthIfNeeded(
    meta: CredentialMetaForAssertion,
    pubCtx: PublicContextForAssertion,
    reason: string,
  ): Promise<ArkadeAuthBeginResponse | undefined> {
    const cacheState = await this.getCombinedAssertionAuthState(meta);
    if (cacheState !== "miss") {
      return undefined;
    }
    return this.beginCombinedAssertionAuth(meta, pubCtx, reason, cacheState);
  }

  async getCombinedAssertionAuthState(
    meta: CredentialMetaForAssertion,
  ): Promise<CombinedAssertionAuthState> {
    const cachedAssertion = await this.getCachedAssertion(meta);
    if (cachedAssertion) return "cache_hit";
    if (sharedAssertionInFlight.has(meta.credIdB64u)) return "inflight";
    return "miss";
  }

  async beginCombinedAssertionAuth(
    meta: CredentialMetaForAssertion,
    pubCtx: PublicContextForAssertion,
    reason: string,
    cacheState: CombinedAssertionAuthState = "miss",
  ): Promise<ArkadeAuthBeginResponse> {
    logArkadeSignTrace("assertion_begin", {
      src: "services/arkade/internal/assertionCache.ts#beginCombinedAssertionAuth",
      reason,
      force_refresh: cacheState === "miss" ? 0 : 1,
      prompt_kind: "passkey_prf_assertion",
      prf_requested: 1,
      assertion_requested: 1,
      native_method: "WebAuthnPrfService.getWalletPasskeyAssertion",
      cache_state: cacheState,
      client_pk: shortRef(pubCtx.clientPk33, 10, 4),
      expected_next: "post_arkade_auth_begin_for_combined_prompt",
    });
    const auth = await arkadeAuthBegin({
      credIdB64u: meta.credIdB64u,
      credPubkeyB64u: meta.credPubkeyB64u,
      clientSignerPubkeyHex: pubCtx.clientPk33,
    });
    assertExpectedSignerServerVersion(String(auth.server_version || ""), "combined_assertion");
    return auth;
  }

  cacheAssertion(
    meta: CredentialMetaForAssertion,
    token: string,
    assertion: PasskeyAssertionPayload,
    reason: string,
    promptKind: AssertionPromptKind = "passkey_assertion",
  ): CachedAssertion {
    const out: CachedAssertion = {
      credIdB64u: meta.credIdB64u,
      token,
      clientDataB64u: assertion.clientDataB64u,
      authDataB64u: assertion.authDataB64u,
      sigB64u: assertion.sigB64u,
      promptKind,
      createdAtMs: Date.now(),
    };
    sharedAssertionCache = out;
    logArkadeSignTrace("assertion_cache_store", {
      src: "services/arkade/ArkadeRemoteIdentity.ts#cacheAssertion",
      source: promptKind === "passkey_prf_assertion" ? "server_prf_assertion" : "server_assertion",
      reason,
      prompt_kind: promptKind,
      assertion_material: "cached_not_logged",
      expected_next: "reuse_assertion_until_ttl",
    });
    return out;
  }

  toSigningAssertionPayload(assertion: CachedAssertion): SigningAssertionPayload {
    return {
      token: assertion.token,
      clientDataB64u: assertion.clientDataB64u,
      authDataB64u: assertion.authDataB64u,
      sigB64u: assertion.sigB64u,
    };
  }

  isPrfAssertion(assertion: CachedAssertion | null): boolean {
    return assertion?.promptKind === "passkey_prf_assertion";
  }

  async getPrfAssertion(
    forceRefresh = false,
    reason = "server_prf_assertion",
  ): Promise<CachedAssertion> {
    const meta = this.deps.getCredentialMeta();
    if (!forceRefresh) {
      const cached = await this.getCachedAssertion(meta);
      if (this.isPrfAssertion(cached)) {
        logArkadeSignTrace("assertion_cache_hit", {
          src: "services/arkade/ArkadeRemoteIdentity.ts#getPrfAssertion",
          source: "server_prf_assertion",
          reason,
          prompt_kind: "passkey_prf_assertion",
          passkey_prompt: 0,
          age_ms: Math.max(0, Date.now() - (cached as CachedAssertion).createdAtMs),
          expected_next: "skip_passkey_prf_assertion_prompt",
        });
        return cached as CachedAssertion;
      }
      if (cached) {
        logArkadeSignTrace("assertion_cache_rejected", {
          src: "services/arkade/ArkadeRemoteIdentity.ts#getPrfAssertion",
          source: "server_prf_assertion",
          reason,
          cached_prompt_kind: cached.promptKind || "passkey_assertion",
          expected_prompt_kind: "passkey_prf_assertion",
          expected_next: "request_passkey_prf_assertion",
        });
        this.clearAssertionCache("non_prf_assertion_rejected");
      }
    }

    const inFlightExisting = sharedAssertionInFlight.get(meta.credIdB64u);
    if (inFlightExisting) {
      logArkadeSignTrace("passkey_prompt_join", {
        source: forceRefresh ? "server_prf_assertion_refresh" : "server_prf_assertion",
        reason,
        app_state: AppState.currentState,
        expected_next: "await_existing_assertion_prompt",
      });
      const assertion = await inFlightExisting;
      if (this.isPrfAssertion(assertion)) return assertion;
      this.clearAssertionCache("inflight_non_prf_assertion_rejected");
    }

    const inFlight = this.deps.withClientSigningKeyScope(
      `${reason}_prf_assertion_done`,
      async () => {
        const pubCtx = await this.deps.getPublicContext();
        logArkadeSignTrace("assertion_begin", {
          src: "services/arkade/ArkadeRemoteIdentity.ts#getPrfAssertion",
          reason,
          force_refresh: forceRefresh ? 1 : 0,
          prompt_kind: "passkey_prf_assertion",
          prf_requested: 1,
          assertion_requested: 1,
          native_method: "WebAuthnPrfService.getWalletPasskeyAssertion",
          cache_state: "miss",
          client_pk: shortRef(pubCtx.clientPk33, 10, 4),
          expected_next: "post_arkade_auth_begin_for_prf_assertion",
        });
        const auth = await arkadeAuthBegin({
          credIdB64u: meta.credIdB64u,
          credPubkeyB64u: meta.credPubkeyB64u,
          clientSignerPubkeyHex: pubCtx.clientPk33,
        });
        assertExpectedSignerServerVersion(String(auth.server_version || ""), "prf_assertion");
        this.deps.clearSigningKeyCache("prf_assertion_requires_fresh_native_result");
        await this.deps.getSigningKey(pubCtx.clientPk33, reason, auth);
        const assertion = await this.getCachedAssertion(meta);
        if (!this.isPrfAssertion(assertion)) {
          throw new Error("passkey PRF assertion was not cached");
        }
        return assertion as CachedAssertion;
      },
    );

    sharedAssertionInFlight.set(meta.credIdB64u, inFlight);
    try {
      return await inFlight;
    } finally {
      if (sharedAssertionInFlight.get(meta.credIdB64u) === inFlight) {
        sharedAssertionInFlight.delete(meta.credIdB64u);
      }
    }
  }

  async getAssertion(forceRefresh = false, reason = "server_assertion"): Promise<CachedAssertion> {
    const meta = this.deps.getCredentialMeta();
    if (!forceRefresh) {
      const cached = await this.getCachedAssertion(meta);
      if (cached) {
        logArkadeSignTrace("assertion_cache_hit", {
          src: "services/arkade/ArkadeRemoteIdentity.ts#getAssertion",
          source: "server_assertion",
          reason,
          prompt_kind: cached.promptKind || "passkey_assertion",
          passkey_prompt: 0,
          age_ms: Math.max(0, Date.now() - cached.createdAtMs),
          expected_next: "skip_passkey_assertion_prompt",
        });
        return cached;
      }
    }

    const inFlightExisting = sharedAssertionInFlight.get(meta.credIdB64u);
    if (inFlightExisting) {
      logArkadeSignTrace("passkey_prompt_join", {
        source: forceRefresh ? "server_assertion_refresh" : "server_assertion",
        reason,
        app_state: AppState.currentState,
        expected_next: "await_existing_assertion_prompt",
      });
      return inFlightExisting;
    }

    const inFlight = (async () => {
      const pubCtx = await this.deps.getPublicContext();
      logArkadeSignTrace("assertion_begin", {
        src: "services/arkade/ArkadeRemoteIdentity.ts#getAssertion",
        reason,
        force_refresh: forceRefresh ? 1 : 0,
        prompt_kind: "passkey_assertion",
        prf_requested: 0,
        assertion_requested: 1,
        native_method: "WebAuthnPrfService.getWalletPasskeyAssertion",
        cache_state: "miss",
        client_pk: shortRef(pubCtx.clientPk33, 10, 4),
        expected_next: "post_arkade_auth_begin",
      });
      const auth = await arkadeAuthBegin({
        credIdB64u: meta.credIdB64u,
        credPubkeyB64u: meta.credPubkeyB64u,
        clientSignerPubkeyHex: pubCtx.clientPk33,
      });

      assertExpectedSignerServerVersion(String(auth.server_version || ""), "assertion");

      logArkadeSignTrace("passkey_prompt", {
        src: "services/arkade/ArkadeRemoteIdentity.ts#getAssertion",
        source: forceRefresh ? "server_assertion_refresh" : "server_assertion",
        reason,
        native_method: "WebAuthnPrfService.getWalletPasskeyAssertion",
        prompt_kind: "passkey_assertion",
        prf_requested: 0,
        assertion_requested: 1,
        prf_salt: "none",
        user_verification: "required",
        face_id_role: "os_passkey_user_verification_possible",
        keychain_biometric: 0,
        app_state: AppState.currentState,
        expected_next: "native_passkey_assertion_prompt",
      });
      let assertion: Awaited<ReturnType<typeof getWalletPasskeyAssertion>>;
      try {
        assertion = await getWalletPasskeyAssertion({
          rpId: auth.rp_id,
          challengeB64u: auth.challenge,
          credIdB64u: meta.credIdB64u,
        });
        logArkadeSignTrace("passkey_prompt_result", {
          src: "services/arkade/ArkadeRemoteIdentity.ts#getAssertion",
          source: forceRefresh ? "server_assertion_refresh" : "server_assertion",
          reason,
          prompt_kind: "passkey_assertion",
          prf_requested: 0,
          assertion_requested: 1,
          status: "ok",
          expected_next: "cache_assertion",
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error || "unknown");
        logArkadeSignTrace("passkey_prompt_result", {
          src: "services/arkade/ArkadeRemoteIdentity.ts#getAssertion",
          source: forceRefresh ? "server_assertion_refresh" : "server_assertion",
          reason,
          prompt_kind: "passkey_assertion",
          prf_requested: 0,
          assertion_requested: 1,
          status: "failed",
          err: shortRef(message, 120, 0),
          expected_next: "surface_prompt_error",
        });
        throw error;
      }

      return this.cacheAssertion(meta, auth.token, assertion, reason);
    })();

    sharedAssertionInFlight.set(meta.credIdB64u, inFlight);
    try {
      return await inFlight;
    } finally {
      if (sharedAssertionInFlight.get(meta.credIdB64u) === inFlight) {
        sharedAssertionInFlight.delete(meta.credIdB64u);
      }
    }
  }
}
