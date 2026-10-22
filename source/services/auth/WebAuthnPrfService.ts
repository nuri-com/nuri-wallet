// WebAuthnPrfService — Promise-bridge for WebView-based WebAuthn PRF.
//
// WebAuthn PRF technically requires a mounted WebView plus a real user tap
// inside it (user-activation). This service lets non-UI code request a PRF
// the same way it used to call the native passkey module: the public
// functions below have byte-identical signatures and return shapes to
// `PasskeyNativeModuleService.ts`, so call-sites can swap imports 1:1.
//
// Mechanism: each public function registers a pending {resolve, reject} in a
// module-level Map keyed by request id, then emits an EventBus event. The
// global `WebAuthnPrfOverlay` listens, mounts `PasskeyWebAuthnPrfView`, and
// calls `resolvePrfRequest` / `rejectPrfRequest` with the WebView outcome.
//
// EventBus events emitted by this service:
//   "webauthn:prfRequest" — payload: WebAuthnPrfRequestPayload (see below)
//   "webauthn:prfCancel" — payload: { id: string }; emitted on bridge timeout so
//     the overlay unmounts a ceremony that never produced a result.

import type {
  PasskeyWebAuthnPrfAssertionResult,
  PasskeyWebAuthnPrfCreateResult,
} from "../../components/PasskeyWebAuthnPrfView";
import { bytesToBase64url, randomBytes } from "../../lib/crypto";
import { paymentTimingMark } from "../../lib/paymentTiming";
import { t } from "../../lib/i18n";
import { formatWalletPasskeyLabel } from "../../lib/passkeyLabels";
import { EventBus } from "../events/AppEventBusService";

// ---- Native-shaped return types (must match PasskeyNativeModuleService) ----

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

type AnyNativeReturn = NativePasskeyResult | NativePasskeyAssertionResult;

// ---- Bridge registry ----

/** Discriminates how a WebView result maps back to a native-shaped object. */
type RequestVariant = "create" | "prf" | "assertion";

type PendingRequest = {
  variant: RequestVariant;
  payload: WebAuthnPrfRequestPayload;
  resolve: (value: AnyNativeReturn) => void;
  reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Hard ceiling on a single ceremony. The in-WebView WebAuthn call has its own
 *  60s timeout; this backstops the cases that never report back (backgrounded,
 *  load failure, never-tapped) so the promise rejects and the overlay unmounts
 *  instead of hanging forever. */
const REQUEST_TIMEOUT_MS = 90_000;

/** Payload of the "webauthn:prfRequest" EventBus event. */
export type WebAuthnPrfRequestPayload = {
  id: string;
  mode: "create" | "assertion";
  rpId: string;
  /**
   * PRF eval salt (UTF-8) passed through to `PasskeyWebAuthnPrfView`. Used by the
   * create + `prf` (unlock) variants, which derive key material; the `assertion`
   * (signing) variant requests no PRF, so it carries no salt.
   */
  prfSalt?: string;
  /** Whether the WebView should request/require the PRF extension. False for the
   *  `assertion` (signing) variant — signing never needs the root PRF. */
  requestPrf: boolean;
  challengeB64u?: string;
  credIdB64u?: string;
  /** Passkey display name used on create (create mode only). */
  label?: string;
  buttonLabel: string;
  title: string;
};

const pendingRequests = new Map<string, PendingRequest>();
const requestQueue: string[] = [];
let activeRequestId: string | null = null;

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `webauthn-prf-${requestCounter}`;
}

function randomChallengeB64u(): string {
  return bytesToBase64url(randomBytes(32));
}

function log(step: string, detail: string): void {
  console.log(`🔐 [WebAuthnPrfService#${step}] ${detail}`);
}

// ---- Public API (signatures match PasskeyNativeModuleService) ----

export const createWalletPasskey = (
  rpId: string,
  prfSalt: string,
  labelOverride?: string,
): Promise<NativePasskeyResult> =>
  requestPrf<NativePasskeyResult>({
    variant: "create",
    mode: "create",
    rpId,
    prfSalt,
    label:
      typeof labelOverride === "string" && labelOverride.trim().length > 0
        ? labelOverride.trim()
        : formatWalletPasskeyLabel(),
    buttonLabel: t("screen.WebAuthnPrfOverlay.buttonCreate"),
    title: t("screen.WebAuthnPrfOverlay.titleCreate"),
  });

export const useExistingWalletPasskey = (
  rpId: string,
  prfSalt: string,
  credIdB64u?: string | null,
): Promise<NativePasskeyResult> =>
  requestPrf<NativePasskeyResult>({
    variant: "prf",
    mode: "assertion",
    rpId,
    prfSalt,
    // Native variant takes no challenge; the WebView assertion needs one.
    challengeB64u: randomChallengeB64u(),
    credIdB64u: normalizeCredId(credIdB64u),
    buttonLabel: t("screen.WebAuthnPrfOverlay.buttonConfirm"),
    title: t("screen.WebAuthnPrfOverlay.titleConfirm"),
  });

export const getWalletPasskeyAssertion = (params: {
  rpId: string;
  challengeB64u: string;
  credIdB64u?: string;
}): Promise<NativePasskeyAssertionResult> =>
  requestPrf<NativePasskeyAssertionResult>({
    variant: "assertion",
    mode: "assertion",
    rpId: params.rpId,
    challengeB64u: params.challengeB64u,
    credIdB64u: normalizeCredId(params.credIdB64u),
    buttonLabel: t("screen.WebAuthnPrfOverlay.buttonConfirm"),
    title: t("screen.WebAuthnPrfOverlay.titleConfirm"),
  });

// ---- Overlay callbacks ----

/** Called by the overlay when the WebView produces a successful result. */
export function resolvePrfRequest(
  id: string,
  result: PasskeyWebAuthnPrfCreateResult | PasskeyWebAuthnPrfAssertionResult,
): void {
  const pending = pendingRequests.get(id);
  if (!pending) return;
  pendingRequests.delete(id);
  if (pending.timer) clearTimeout(pending.timer);
  try {
    pending.resolve(mapResult(pending.variant, result));
  } catch (error) {
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    finishActiveRequest(id);
  }
}

/** Called by the overlay on WebView error or user dismiss/cancel. */
export function rejectPrfRequest(id: string, message: string): void {
  const pending = pendingRequests.get(id);
  if (!pending) return;
  pendingRequests.delete(id);
  if (pending.timer) clearTimeout(pending.timer);
  pending.reject(new Error(message || "webauthn_prf_request_failed"));
  finishActiveRequest(id);
}

// ---- Internals ----

function normalizeCredId(value?: string | null): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function finishActiveRequest(id: string): void {
  if (activeRequestId !== id) return;
  activeRequestId = null;
  startNextRequest();
}

function startNextRequest(): void {
  if (activeRequestId) return;

  while (requestQueue.length > 0) {
    const id = requestQueue.shift();
    if (!id) return;
    const pending = pendingRequests.get(id);
    if (!pending) continue;

    activeRequestId = id;
    pending.timer = setTimeout(() => {
      const stale = pendingRequests.get(id);
      if (!stale) return;
      pendingRequests.delete(id);
      try {
        EventBus.emit("webauthn:prfCancel", { id });
      } catch {}
      stale.reject(new Error("webauthn_prf_timeout"));
      finishActiveRequest(id);
    }, REQUEST_TIMEOUT_MS);

    try {
      log(
        "requestPrf",
        `id=${id} variant=${pending.variant} mode=${pending.payload.mode} rp=${pending.payload.rpId}`,
      );
      paymentTimingMark("PASSKEY PROMPT SHOWN");
      EventBus.emit("webauthn:prfRequest", pending.payload);
    } catch (error) {
      if (pending.timer) clearTimeout(pending.timer);
      pendingRequests.delete(id);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      activeRequestId = null;
      continue;
    }
    return;
  }
}

function requestPrf<T extends AnyNativeReturn>(opts: {
  variant: RequestVariant;
  mode: "create" | "assertion";
  rpId: string;
  prfSalt?: string;
  challengeB64u?: string;
  credIdB64u?: string;
  label?: string;
  buttonLabel: string;
  title: string;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextRequestId();
    // Only key-derivation ceremonies (create / unlock) need PRF; signing
    // assertions must not evaluate or transport the root PRF.
    const wantsPrf = opts.variant !== "assertion";
    const payload: WebAuthnPrfRequestPayload = {
      id,
      mode: opts.mode,
      rpId: opts.rpId,
      prfSalt: opts.prfSalt,
      requestPrf: wantsPrf,
      challengeB64u: opts.challengeB64u,
      credIdB64u: opts.credIdB64u,
      label: opts.label,
      buttonLabel: opts.buttonLabel,
      title: opts.title,
    };
    pendingRequests.set(id, {
      variant: opts.variant,
      payload,
      resolve: resolve as (value: AnyNativeReturn) => void,
      reject,
    });
    requestQueue.push(id);
    startNextRequest();
  });
}

function mapResult(
  variant: RequestVariant,
  result: PasskeyWebAuthnPrfCreateResult | PasskeyWebAuthnPrfAssertionResult,
): AnyNativeReturn {
  if (variant === "create") {
    if (result.kind !== "create") {
      throw new Error("webauthn_prf_expected_create_result");
    }
    return {
      prfB64: result.prfB64u,
      credIdB64u: result.credIdB64u,
      credPubkeyB64u: result.credPubkeyB64u,
      isNew: true,
    };
  }

  if (result.kind !== "assertion") {
    throw new Error("webauthn_prf_expected_assertion_result");
  }

  switch (variant) {
    case "prf":
      if (!result.prfB64u) throw new Error("webauthn_prf_missing_prf_result");
      return {
        prfB64: result.prfB64u,
        credIdB64u: result.credIdB64u,
        credPubkeyB64u: undefined,
        isNew: false,
      };
    case "assertion":
      return {
        credIdB64u: result.credIdB64u,
        clientDataB64u: result.clientDataB64u,
        authDataB64u: result.authDataB64u,
        sigB64u: result.sigB64u,
      };
    default:
      throw new Error(`webauthn_prf_unknown_variant_${String(variant)}`);
  }
}
