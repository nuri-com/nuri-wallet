import { describe, expect, it } from "vitest";
import { isSendSourceBoundToCredential } from "./sendSourceBinding";

describe("isSendSourceBoundToCredential", () => {
  it("accepts a descriptor bound to the loaded credential", () => {
    expect(isSendSourceBoundToCredential("cred-a", "cred-a")).toBe(true);
  });

  // The bug this guards: after an in-app account switch the previous account's descriptor is still
  // installed, and deriving from it would bind a route to an address the new account does not own.
  it("refuses a descriptor left over from another credential", () => {
    expect(isSendSourceBoundToCredential("cred-a", "cred-b")).toBe(false);
  });

  it("refuses an unbound descriptor (account switch invalidated it)", () => {
    expect(isSendSourceBoundToCredential(null, "cred-a")).toBe(false);
  });

  it("refuses when the current credential is not loaded yet", () => {
    expect(isSendSourceBoundToCredential("cred-a", null)).toBe(false);
    expect(isSendSourceBoundToCredential(null, null)).toBe(false);
  });
});
