// Classifying passkey ceremony errors by substring is a trap: the WebView
// stamps every create-ceremony exception with the same `error:create_prf:`
// prefix (PasskeyLoginScreenWebView.tsx:152), so a test for "prf" also matches
// cancellations, timeouts and unsupported-device errors. Keep the exact tokens
// here, next to a test that feeds in the real strings each source emits.

/** Emitted when a ceremony succeeded but yielded no usable PRF output. */
const MISSING_PRF_TOKENS = [
  // PasskeyNativeModuleService (web path)
  "missing_create_prf",
  "missing_assertion_prf",
  "passkey_native:empty_prf",
  "empty prf payload",
  // PasskeyLoginScreenWebView assertion paths (iOS)
  "get:no_prf",
  "get:empty_prf_b64",
  "get_auth_only:no_prf",
  "get_auth_only:empty_prf_b64",
  // Android native. PasskeyModule.kt:291 rejects ("prf_missing", "Missing PRF
  // output"); PasskeyLoginScreenNative.tsx:163 keeps only error.message, so
  // this arrives space-joined as `error:passkey_native:Missing PRF output` and
  // matches none of the underscore tokens above. Keep both spellings: the
  // message is what ships today, the code is what a future bridge change or a
  // `code`-carrying wrapper would surface.
  "missing prf output",
  "prf_missing",
] as const;

/**
 * True only when the provider completed a ceremony but returned no PRF, which
 * means there is no wallet seed and the user must switch provider.
 *
 * Deliberately false for cancellations and generic ceremony failures, even
 * though those arrive tagged `error:create_prf:…` — the user knows they
 * cancelled, and telling them their provider lacks PRF would be a lie.
 */
export function isMissingPrfError(error: string): boolean {
  const lower = error.toLowerCase();
  return MISSING_PRF_TOKENS.some((token) => lower.includes(token));
}
