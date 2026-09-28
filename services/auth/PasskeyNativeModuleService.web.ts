/**
 * Web (PWA) implementation of the passkey bridge. In a browser the app runs in
 * the DOM directly, so there is no native module and no WebView/postMessage
 * bridge — we call navigator.credentials with the WebAuthn `prf` extension
 * straight away. Mirrors the four functions consumers import from the native
 * service, with identical result shapes (prfB64 = standard base64; all other
 * *B64u fields = base64url, no padding) so every caller resolves transparently.
 *
 * The same passkey derives the same PRF as the native path because rpId
 * ("nuri.com") and the PRF salt ("nuri-prf-salt-v1") are identical — so a wallet
 * created on the iOS/Android app and one created in the PWA at the nuri.com
 * origin are the same wallet.
 *
 * ---------------------------------------------------------------------------
 * MISSION CRITICAL — read before changing anything in this file.
 *
 * Every Nuri key hangs off one PRF value: bitcoin, ethereum, nostr, the arkade
 * client signer. The PRF is a pure function of (credential, rpId, salt). Move
 * any of those and every existing user derives a DIFFERENT wallet on their next
 * sign-in — funds still on chain, app can no longer reach them, no recovery.
 * services/auth/PasskeyPrfDerivation.test.ts pins those inputs; a failure there
 * is never "update the expected value".
 *
 * Verified on-device 2026-09-17 (Android 15, Chrome 153, passkey.nuri.com,
 * credential q8Ae7wF4-oRpJg0LKNABqg): create() and two independent get() calls
 * all returned 4yP23r…<redacted>. That equality is
 * what lets createWalletPasskey below use the create-time PRF instead of a
 * second ceremony. Re-run the device check (docs/passkey-prf.md) whenever this
 * file changes — unit tests cannot see a browser regression.
 *
 * The Android quirk that shaped this file: a get() with a non-empty
 * allowCredentials NEVER SETTLES there. No UI, no resolve, no reject, its own
 * `timeout` ignored; AbortController does not release it; `transports` hints
 * only turn the hang into an instant NotAllowedError. The hung request then
 * fails every later WebAuthn call on the page with "OperationError: A request
 * is already pending" until a reload, which in the app reads as a permanently
 * disabled button and no error message. Do not "simplify" the allowCredentials
 * handling in getAssertion back to always naming the credential.
 * ---------------------------------------------------------------------------
 */

type NativePasskeyResult = {
  prfB64: string;
  credIdB64u?: string;
  credPubkeyB64u?: string;
  isNew: boolean;
};

type NativePasskeyAssertionResult = {
  credIdB64u: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};

const RP_NAME = "Nuri Wallet";
const ALG_ES256 = -7;

function ensureWebAuthn(): void {
  if (
    typeof navigator === "undefined" ||
    !navigator.credentials ||
    typeof PublicKeyCredential === "undefined"
  ) {
    throw new Error("webauthn_not_supported");
  }
}

// WebAuthn requires the RP ID to be a registrable suffix of the page origin.
// Production serves the PWA under nuri.com so "nuri.com" is valid, but on a
// localhost dev origin the browser rejects it — fall back to the actual
// hostname there so local testing works. No-op at the real origin.
function effectiveRpId(rpId: string): string {
  try {
    const host = (globalThis as { location?: { hostname?: string } }).location?.hostname || "";
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) return host;
  } catch {}
  return rpId;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function toBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  return toBase64(buffer).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  let normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Every Android browser shares Chrome's WebAuthn stack and Google's Credential
// Manager, so the allowCredentials hang is assumed for all of them rather than
// sniffed per browser.
function hangsOnAllowCredentials(): boolean {
  try {
    return /Android/.test(
      (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent || "",
    );
  } catch {
    return false;
  }
}

function readPrfFirst(credential: PublicKeyCredential): Uint8Array | null {
  const ext = credential.getClientExtensionResults?.() as
    | { prf?: { results?: { first?: ArrayBuffer } } }
    | undefined;
  const first = ext?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

async function getAssertion(opts: {
  rpId: string;
  challenge: Uint8Array;
  credIdB64u?: string | null;
  prfSalt?: string;
}): Promise<PublicKeyCredential> {
  ensureWebAuthn();
  // Naming the credential is what we want everywhere it works: the browser
  // goes straight to the wallet's passkey with no chooser. Android Chrome is
  // the exception — measured on Android 15 / Chrome 153, a get() with a
  // non-empty allowCredentials never settles (no UI, no resolve, no reject,
  // its own `timeout` ignored), and the hung request then fails every later
  // WebAuthn call on the page with "OperationError: A request is already
  // pending" until a reload. AbortController does not release it, and adding
  // `transports` hints only turns the hang into an immediate NotAllowedError.
  // Wallet passkeys are created with residentKey "required", so there a
  // discoverable get() reaches the same credential; either way the result is
  // pinned below by comparing rawId.
  const expectedCredIdB64u = typeof opts.credIdB64u === "string" ? opts.credIdB64u.trim() : "";
  const nameCredential = expectedCredIdB64u && !hangsOnAllowCredentials();
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: opts.challenge,
    rpId: effectiveRpId(opts.rpId),
    userVerification: "required",
    timeout: 60000,
    allowCredentials: nameCredential
      ? [{ id: base64UrlToBytes(expectedCredIdB64u), type: "public-key" }]
      : [],
  };
  if (opts.prfSalt) {
    (publicKey as PublicKeyCredentialRequestOptions & { extensions?: unknown }).extensions = {
      prf: { eval: { first: utf8(opts.prfSalt) } },
    };
  }
  const assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("empty_assertion");
  if (expectedCredIdB64u && toBase64Url(assertion.rawId) !== expectedCredIdB64u) {
    throw new Error("assertion_credential_mismatch");
  }
  return assertion;
}

/** Web has no native PasskeyModule; parity export for shared call-sites. */
export const isNativePasskeyLoginAvailable = (): boolean => false;

export const createWalletPasskeyCredential = async (
  rpId: string,
  prfSalt: string,
  labelOverride?: string,
): Promise<Omit<NativePasskeyResult, "prfB64"> & { prfB64?: string }> => {
  ensureWebAuthn();
  const label = (typeof labelOverride === "string" && labelOverride.trim()) || "Nuri Wallet";
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { id: effectiveRpId(rpId), name: RP_NAME },
      user: { id: randomBytes(16), name: label, displayName: label },
      pubKeyCredParams: [{ type: "public-key", alg: ALG_ES256 }],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      timeout: 60000,
      // Some providers return PRF during create, but fewer support that path.
      // The following exact-credential get() remains the authoritative check.
      extensions: { prf: { eval: { first: utf8(prfSalt) } } },
    },
  })) as PublicKeyCredential | null;
  if (!created) throw new Error("empty_create_credential");

  const credIdB64u = toBase64Url(created.rawId);
  let credPubkeyB64u = "";
  try {
    const spki = (created.response as AuthenticatorAttestationResponse).getPublicKey?.();
    if (spki) credPubkeyB64u = toBase64Url(spki);
  } catch {}
  const prf = readPrfFirst(created);
  return { credIdB64u, credPubkeyB64u, isNew: true, ...(prf ? { prfB64: toBase64(prf) } : {}) };
};

export const createWalletPasskey = async (
  rpId: string,
  prfSalt: string,
  labelOverride?: string,
): Promise<NativePasskeyResult> => {
  const created = await createWalletPasskeyCredential(rpId, prfSalt, labelOverride);
  // Prefer the PRF the provider already evaluated during create(). Verified on
  // Android 15 / Chrome 153 against app.nuri.com: the create-time value is
  // byte-identical to the one an assertion returns for the same credential and
  // salt, and skipping the second ceremony avoids a hard hang — a get() with a
  // non-empty allowCredentials never shows UI and never settles there (its own
  // `timeout` is ignored), which leaves the onboarding button disabled forever
  // and makes every later WebAuthn call on the page fail with
  // "OperationError: A request is already pending".
  if (created.prfB64) return { ...created, prfB64: created.prfB64 };
  // Providers that omit PRF at create() time still need the extra assertion.
  const assertion = await getAssertion({
    rpId,
    challenge: randomBytes(32),
    credIdB64u: created.credIdB64u,
    prfSalt,
  });
  const prf = readPrfFirst(assertion);
  if (!prf) throw new Error("missing_create_prf");

  return { ...created, prfB64: toBase64(prf) };
};

export const useExistingWalletPasskey = async (
  rpId: string,
  prfSalt: string,
  credIdB64u?: string | null,
): Promise<NativePasskeyResult> => {
  const assertion = await getAssertion({
    rpId,
    challenge: randomBytes(32),
    credIdB64u,
    prfSalt,
  });
  const prf = readPrfFirst(assertion);
  if (!prf) throw new Error("missing_assertion_prf");
  return { prfB64: toBase64(prf), credIdB64u: toBase64Url(assertion.rawId), isNew: false };
};

/**
 * One assertion that both signs the server's challenge and evaluates the PRF.
 * The WebView ceremony does exactly this in a single `get()`, and flows like the
 * username claim need both halves: the PRF unlocks the wallet, the signature
 * fields authenticate the request (without them the server answers
 * `auth failed: missing assertion fields`). Two separate calls would also mean
 * two Face ID prompts.
 */
export const getWalletPasskeyPrfAssertion = async (params: {
  rpId: string;
  challengeB64u: string;
  credIdB64u?: string;
  prfSalt: string;
}): Promise<NativePasskeyAssertionResult & { prfB64: string }> => {
  const assertion = await getAssertion({
    rpId: params.rpId,
    challenge: base64UrlToBytes(params.challengeB64u),
    credIdB64u: params.credIdB64u,
    prfSalt: params.prfSalt,
  });
  const prf = readPrfFirst(assertion);
  if (!prf) throw new Error("missing_assertion_prf");
  const response = assertion.response as AuthenticatorAssertionResponse;
  return {
    prfB64: toBase64(prf),
    credIdB64u: toBase64Url(assertion.rawId),
    clientDataB64u: toBase64Url(response.clientDataJSON),
    authDataB64u: toBase64Url(response.authenticatorData),
    sigB64u: toBase64Url(response.signature),
  };
};

export const getWalletPasskeyAssertion = async (params: {
  rpId: string;
  challengeB64u: string;
  credIdB64u?: string;
}): Promise<NativePasskeyAssertionResult> => {
  const assertion = await getAssertion({
    rpId: params.rpId,
    challenge: base64UrlToBytes(params.challengeB64u),
    credIdB64u: params.credIdB64u,
  });
  const response = assertion.response as AuthenticatorAssertionResponse;
  return {
    credIdB64u: toBase64Url(assertion.rawId),
    clientDataB64u: toBase64Url(response.clientDataJSON),
    authDataB64u: toBase64Url(response.authenticatorData),
    sigB64u: toBase64Url(response.signature),
  };
};
