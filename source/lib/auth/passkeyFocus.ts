// WebKit refuses a passkey ceremony while its document does not hold the focus
// (`NotAllowedError: The document is not focused`). On iOS that happens when
// the tap that started the ceremony is the same tap that first focuses the
// passkey page (#1818). It is not the user saying no and not a failure: the
// button stays, and the next tap, now on a focused page, runs the ceremony.
// Reporting it as an error failed the unlock and counted it as a cancel.

/** Regex source, also inlined into the WebView page (which cannot import). */
export const PASSKEY_FOCUS_REJECTION_SOURCE = "not\\s+focused";

const FOCUS_REJECTION = new RegExp(PASSKEY_FOCUS_REJECTION_SOURCE, "i");

/** True for WebKit's "document is not focused" refusal of a passkey ceremony. */
export function isPasskeyFocusRejection(name: string, message: string): boolean {
  return name === "NotAllowedError" && FOCUS_REJECTION.test(message);
}
