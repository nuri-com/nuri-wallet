// Per-operation signing-key vault. Owns:
//   * cachedPriv32 — the most recent private key, valid only while
//     signingKeyScopeDepth > 0 (zeroized on scope exit).
//   * signingKeyInFlight — coalesces concurrent PRF prompts.
//   * signingKeyScopeDepth — refcount that controls when the cache is
//     zeroized. Increment on enter, decrement on exit; clear at 0.
//   * signOpTail — promise queue tail used by runSignExclusive to serialize
//     msg32 signs without blocking concurrent reads.
import * as musig2 from "@scure/btc-signer/musig2.js";
import { AppState } from "react-native";
import { bytesToHex } from "../../../lib/bytes";
import { zeroize } from "../../../lib/crypto";
import { shortTime } from "../../../lib/logShared";
import { getPrivateKey } from "../../../lib/secureKeyStorage";
import { getWalletPasskeyAssertion } from "../../auth/PasskeyNativeModuleService";
import { arkadeAuthBegin } from "../ArkadeApiService";
import {
  ARKADE_CLIENT_VERSION,
  ARKADE_EXPECTED_SIGNER_SERVER,
  NURI_SERVER_API_VERSION,
} from "../ArkadeVersion";
import type { ArkadeAuthBeginResponse, AssertionCache } from "./assertionCache";

const ARKADE_SIGN_TRACE_MARKER = "ARKADE_SIGN_TRACE_V2_20260417";

type CredentialMetaForVault = {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientPk33: string;
};

type PublicContextForVault = {
  clientPk33: string;
};

export type SigningKeyVaultDeps = {
  getCredentialMeta: () => CredentialMetaForVault;
  getPublicContext: () => Promise<PublicContextForVault>;
  assertionCache: AssertionCache;
};

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

export class SigningKeyVault {
  private cachedPriv32: Uint8Array | null = null;
  private signingKeyInFlight: Promise<Uint8Array> | null = null;
  private signingKeyScopeDepth = 0;
  private signOpTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SigningKeyVaultDeps) {}

  clearSigningKeyCache(reason: string): void {
    if (this.cachedPriv32) {
      zeroize(this.cachedPriv32);
      this.cachedPriv32 = null;
    }
    console.log(
      `🔐 [${shortTime()} ArkadeRemoteIdentity.keyScope] nuri_server_api=${NURI_SERVER_API_VERSION} source=passkey_prf action=clear reason=${reason}`,
    );
  }

  getCachedPriv32(): Uint8Array | null {
    return this.cachedPriv32;
  }

  getScopeDepth(): number {
    return this.signingKeyScopeDepth;
  }

  async withClientSigningKeyScope<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    this.signingKeyScopeDepth += 1;
    logArkadeSignTrace("client_key_scope_enter", {
      reason,
      depth: this.signingKeyScopeDepth,
      expected_next: "derive_or_reuse_key_inside_operation",
    });
    try {
      return await fn();
    } finally {
      this.signingKeyScopeDepth = Math.max(0, this.signingKeyScopeDepth - 1);
      if (this.signingKeyScopeDepth === 0) {
        this.clearSigningKeyCache(reason);
      }
    }
  }

  async withMaintenanceSigningScope<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    return this.withClientSigningKeyScope(reason, fn);
  }

  async runSignExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.signOpTail;
    let release: (() => void) | null = null;
    this.signOpTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      try {
        release?.();
      } catch {}
    }
  }

  async getSigningKey(
    expectedClientPk33: string,
    reason = "client_signing",
    combinedAssertionAuth?: ArkadeAuthBeginResponse | null,
    // When the caller already ran the WebView passkey ceremony (e.g. the
    // PaymentReceivedModal "Passkey Unlock" button IS the WebView), it passes the
    // result here so getSigningKey skips its own prompt — one tap instead of two.
    // The assertion must have been signed over combinedAssertionAuth.challenge.
    preObtained?: {
      prfB64: string;
      credIdB64u: string;
      clientDataB64u: string;
      authDataB64u: string;
      sigB64u: string;
    } | null,
  ): Promise<Uint8Array> {
    if (this.signingKeyScopeDepth <= 0) {
      throw new Error("client signing key requested without zeroize scope");
    }
    if (this.cachedPriv32) {
      const cachedPk = bytesToHex(musig2.IndividualPubkey(this.cachedPriv32)).toLowerCase();
      if (cachedPk === expectedClientPk33) {
        logArkadeSignTrace("client_key_scope_hit", {
          source: "passkey_prf_scope",
          reason,
          scope_depth: this.signingKeyScopeDepth,
          client_pk: shortRef(expectedClientPk33, 10, 4),
          expected_next: "reuse_key_inside_current_operation_only",
        });
        return this.cachedPriv32;
      }
      this.clearSigningKeyCache("pubkey_mismatch");
    }

    if (this.signingKeyInFlight) {
      logArkadeSignTrace("passkey_prompt_join", {
        source: "client_signing_prf",
        reason,
        app_state: AppState.currentState,
        expected_next: "await_existing_prf_prompt",
      });
      return this.signingKeyInFlight;
    }

    if (!combinedAssertionAuth) {
      logArkadeSignTrace("passkey_prompt_blocked", {
        src: "services/arkade/internal/signingKeyVault.ts#getSigningKey",
        source: "client_signing_prf_assertion",
        reason,
        prompt_kind: "passkey_prf_assertion",
        status: "failed",
        err: "missing_combined_assertion_auth",
        expected_next: "fetch_arkade_auth_begin_before_prompt",
      });
      throw new Error("missing arkade combined assertion auth for signing key");
    }

    const inFlight = (async () => {
      const meta = this.deps.getCredentialMeta();
      const promptSource = "client_signing_assertion";
      logArkadeSignTrace("passkey_prompt", {
        src: "services/arkade/internal/signingKeyVault.ts#getSigningKey",
        source: promptSource,
        reason,
        native_method: "WebAuthnPrfService.getWalletPasskeyAssertion",
        prompt_kind: "passkey_assertion",
        prf_requested: 0,
        assertion_requested: 1,
        prf_output: "not_requested",
        user_verification: "required",
        face_id_role: "os_passkey_user_verification_possible",
        keychain_biometric: 0,
        app_state: AppState.currentState,
        expected_cred: shortRef(meta.credIdB64u, 8, 4),
        credential_pin: 1,
        expected_next: "server_assertion_then_held_signing_key",
      });
      assertExpectedSignerServerVersion(
        String(combinedAssertionAuth.server_version || ""),
        "combined_assertion",
      );
      // The assertion proves user-presence to the arkade signer
      // (clientData/authData/sig). PRF is NOT used here — PRF runs ONCE at
      // bootstrap and the signing key is the held wallet key below. `preObtained`
      // is the result of the transparent button-as-WebView ceremony (one tap, no
      // separate screen); when absent we run a plain assertion, only because we
      // need one right now. Any prfB64 the ceremony returns is ignored.
      const result = preObtained
        ? {
            credIdB64u: preObtained.credIdB64u,
            clientDataB64u: preObtained.clientDataB64u,
            authDataB64u: preObtained.authDataB64u,
            sigB64u: preObtained.sigB64u,
          }
        : await getWalletPasskeyAssertion({
            rpId: combinedAssertionAuth.rp_id,
            challengeB64u: combinedAssertionAuth.challenge,
            credIdB64u: meta.credIdB64u,
          });
      logArkadeSignTrace("passkey_prompt_result", {
        src: "services/arkade/internal/signingKeyVault.ts#getSigningKey",
        source: promptSource,
        reason,
        prompt_kind: "passkey_assertion",
        pre_obtained: preObtained ? 1 : 0,
        returned_cred: result.credIdB64u ? shortRef(String(result.credIdB64u), 14, 8) : "missing",
        status: "ok",
        expected_next: "cache_assertion_and_load_held_key",
      });
      const returnedCredId = String(result.credIdB64u || "").trim();
      logArkadeSignTrace("passkey_credential_check", {
        src: "services/arkade/ArkadeRemoteIdentity.ts#getSigningKey",
        source: promptSource,
        reason,
        prompt_kind: "passkey_prf_assertion",
        expected_cred: meta.credIdB64u ? shortRef(meta.credIdB64u, 8, 4) : "missing",
        returned_cred: returnedCredId ? shortRef(returnedCredId, 8, 4) : "missing",
        match: returnedCredId && returnedCredId === meta.credIdB64u ? 1 : 0,
        expected_next:
          returnedCredId && returnedCredId !== meta.credIdB64u
            ? "claim_retry_guard_handles_mismatch"
            : "derive_client_key",
      });
      if (returnedCredId && returnedCredId !== meta.credIdB64u) {
        throw new Error("wallet passkey credential mismatch");
      }
      // Cache the assertion for the combined-assertion consumers. The promptKind
      // tag stays "passkey_prf_assertion" so the existing approve-path guards
      // (isPrfAssertion) accept it unchanged — the bytes are a standard WebAuthn
      // assertion either way (PRF output never reaches the server).
      this.deps.assertionCache.cacheAssertion(
        meta,
        combinedAssertionAuth.token,
        {
          clientDataB64u: result.clientDataB64u,
          authDataB64u: result.authDataB64u,
          sigB64u: result.sigB64u,
        },
        reason,
        "passkey_prf_assertion",
      );
      // Held signing key — identical to the former PRF-derived key
      // (deriveBitcoinPasskeySigningKey matches bootstrapWalletFromPrf), read from
      // the session-resident secure-storage cache the unlock biometric seeded. No
      // PRF ceremony and no second biometric per spend.
      const priv = await getPrivateKey("bitcoin");
      const actualPk = bytesToHex(musig2.IndividualPubkey(priv)).toLowerCase();
      if (actualPk !== expectedClientPk33) {
        zeroize(priv);
        throw new Error("client held key/public key mismatch with auth state");
      }
      this.cachedPriv32 = priv;
      logArkadeSignTrace("client_key_scoped", {
        src: "services/arkade/internal/signingKeyVault.ts#getSigningKey",
        source: "held_key_scope",
        reason,
        prompt_kind: "passkey_assertion",
        key_material: "client_private_key_scoped_not_logged",
        scope_depth: this.signingKeyScopeDepth,
        client_pk: shortRef(expectedClientPk33, 10, 4),
        expected_next: "zeroize_when_operation_finishes",
      });
      return priv;
    })();

    this.signingKeyInFlight = inFlight;
    try {
      return await inFlight;
    } finally {
      if (this.signingKeyInFlight === inFlight) {
        this.signingKeyInFlight = null;
      }
    }
  }

  async getSigningKeyCopy(
    expectedClientPk33: string,
    reason = "client_key_copy",
  ): Promise<Uint8Array> {
    return this.withClientSigningKeyScope(`${reason}_copy_done`, async () => {
      const meta = this.deps.getCredentialMeta();
      const pubCtx = await this.deps.getPublicContext();
      const auth = await arkadeAuthBegin({
        credIdB64u: meta.credIdB64u,
        credPubkeyB64u: meta.credPubkeyB64u,
        clientSignerPubkeyHex: pubCtx.clientPk33,
      });
      const priv = await this.getSigningKey(expectedClientPk33, reason, auth);
      return new Uint8Array(priv);
    });
  }

  async prewarmSigningKey(reason = "prewarm"): Promise<void> {
    await this.withClientSigningKeyScope(`${reason}_prewarm_done`, async () => {
      const meta = this.deps.getCredentialMeta();
      const pubCtx = await this.deps.getPublicContext();
      const auth = await arkadeAuthBegin({
        credIdB64u: meta.credIdB64u,
        credPubkeyB64u: meta.credPubkeyB64u,
        clientSignerPubkeyHex: pubCtx.clientPk33,
      });
      await this.getSigningKey(pubCtx.clientPk33, reason, auth);
      logArkadeSignTrace("client_key_prewarm_ready", {
        reason,
        client_pk: shortRef(pubCtx.clientPk33, 10, 4),
        lifetime: "operation_scope_only",
        expected_next: "zeroize_immediately_after_prewarm",
      });
    });
  }
}
