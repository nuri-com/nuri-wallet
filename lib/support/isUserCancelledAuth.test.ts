import { describe, expect, it } from "vitest";

import { isUserCancelledAuth } from "./isUserCancelledAuth";

/** What the browser actually throws when the user dismisses a passkey sheet. */
function domException(name: string, message = ""): Error {
  const err = new Error(message || name);
  err.name = name;
  return err;
}

describe("isUserCancelledAuth", () => {
  it("recognises a dismissed WebAuthn prompt (PWA)", () => {
    expect(
      isUserCancelledAuth(
        domException("NotAllowedError", "The operation either timed out or was not allowed."),
      ),
    ).toBe(true);
    // An AbortError must identify the auth ceremony to count.
    expect(isUserCancelledAuth(domException("AbortError", "webauthn assertion aborted"))).toBe(
      true,
    );
  });

  it("does not treat a plain aborted fetch as a cancel", () => {
    // RemitService aborts its own fetch after 20s and rejects with exactly
    // this. Swallowing it turned a real outage into a silent no-op: no error
    // shown, no support path, nothing sent.
    expect(isUserCancelledAuth(domException("AbortError", "signal is aborted"))).toBe(false);
    expect(isUserCancelledAuth(domException("AbortError", "The operation was aborted."))).toBe(
      false,
    );
  });

  it("sees a cancel wrapped in another error's cause", () => {
    // The cause carries the name and an empty-ish message, so reading only the
    // message treated a genuine cancel as a real failure.
    expect(
      isUserCancelledAuth(
        new Error("sign failed", {
          cause: domException("NotAllowedError", "The operation is not allowed."),
        }),
      ),
    ).toBe(true);
  });

  it("recognises a native biometric cancel", () => {
    expect(isUserCancelledAuth(new Error("Biometric authentication cancelled"))).toBe(true);
    expect(isUserCancelledAuth(new Error("User canceled the operation"))).toBe(true);
    expect(isUserCancelledAuth("UserCancel")).toBe(true);
  });

  it("recognises an explicit refusal", () => {
    expect(isUserCancelledAuth(new Error("user denied the request"))).toBe(true);
    expect(isUserCancelledAuth(new Error("User rejected request"))).toBe(true);
  });

  it("reads a nested cause", () => {
    const outer = new Error("sign failed", {
      cause: domException("NotAllowedError"),
    });
    expect(isUserCancelledAuth(outer)).toBe(true);
  });

  it("reads a plain object with a name", () => {
    expect(isUserCancelledAuth({ name: "NotAllowedError", message: "" })).toBe(true);
  });

  // The whole point: a real failure must still reach support.
  it("does NOT swallow real failures", () => {
    expect(isUserCancelledAuth(new Error("fetch failed"))).toBe(false);
    expect(isUserCancelledAuth(new Error("insufficient funds"))).toBe(false);
    expect(isUserCancelledAuth(new Error("AddressMismatch"))).toBe(false);
    expect(isUserCancelledAuth(new Error("solver refused: amount_out_of_range"))).toBe(false);
    expect(isUserCancelledAuth(new Error("HTTP 500"))).toBe(false);
  });

  it("is safe on empty input", () => {
    expect(isUserCancelledAuth(null)).toBe(false);
    expect(isUserCancelledAuth(undefined)).toBe(false);
    expect(isUserCancelledAuth("")).toBe(false);
  });
});
