// A user who dismisses the passkey/biometric prompt has not hit a bug.
//
// Every send path funnels its failures into `reportErrorToSupport`, which opens
// the support chat with a diagnostic dump. That is right for a provider or SDK
// failure and wrong for a deliberate cancel: the user chose not to authorise,
// the wallet did exactly what they asked, and nothing needs reporting.
//
// The check has to be text-based because the shapes differ per platform:
//   - native: expo-local-authentication / the keystore throw messages carrying
//     "cancel" (see lib/secureKeyStorage.ts classifyBiometricError)
//   - web/PWA: WebAuthn rejects with a DOMException named `NotAllowedError`
//     (also used for timeouts, which are equally not-a-bug) or `AbortError`
//
// `lib/secureKeyStorage.web.ts` returns false from isBiometricPromptDismissal
// because a browser has no biometric prompt — but it does have WebAuthn, so
// the PWA needs this.

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    // The cause's NAME matters as much as its message: a wrapped cancel is
    // usually `new Error("sign failed", { cause: DOMException(…,
    // "NotAllowedError") })`, where the message says nothing and the name says
    // everything. Reading only the message treated those as real failures.
    const cause = (error as { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error
        ? `${cause.name} ${cause.message}`
        : typeof cause === "string"
          ? cause
          : cause && typeof cause === "object"
            ? `${String((cause as { name?: unknown }).name ?? "")} ${String((cause as { message?: unknown }).message ?? "")}`
            : "";
    return `${error.name} ${error.message} ${causeText}`.trim();
  }
  if (typeof error === "object") {
    const record = error as { name?: unknown; message?: unknown; code?: unknown };
    return `${String(record.name ?? "")} ${String(record.message ?? "")} ${String(record.code ?? "")}`.trim();
  }
  return String(error);
}

/**
 * True when a failure is the user declining an authentication prompt, rather
 * than something that went wrong.
 */
export function isUserCancelledAuth(error: unknown): boolean {
  const text = errorText(error);
  if (!text) return false;
  // NotAllowedError is WebAuthn's own refusal/timeout answer and means nothing
  // else in this codebase.
  if (/NotAllowedError/i.test(text)) return true;
  // AbortError is NOT enough on its own. Every `AbortController` timeout in the
  // app rejects with exactly that name — RemitService aborts its fetch after
  // 20s — and treating those as a cancel turned a real outage into a silent
  // no-op with no error shown and no support path. Only an abort that also
  // identifies the auth ceremony counts.
  if (/AbortError/i.test(text) && /webauthn|passkey|credential|assertion|biometric/i.test(text)) {
    return true;
  }
  if (/cancel(l)?ed|cancel/i.test(text)) return true;
  if (/user\s?(denied|declined|rejected|dismissed)/i.test(text)) return true;
  // A prompt that timed out was also not authorised, and telling the user to
  // contact support about their own inaction helps nobody.
  if (/authentication\s?timed\s?out|prompt\s?timed\s?out/i.test(text)) return true;
  return false;
}
