import { describe, expect, it } from "vitest";
import { parsePasskeyUsernamePath, shouldWipeForPasskeySwitch } from "./passkeyUsernameLink";

describe("passkey username links", () => {
  it("accepts only one valid @username path", () => {
    expect(parsePasskeyUsernamePath("/@Alice.Doe")).toBe("alice.doe");
    expect(parsePasskeyUsernamePath("/@alice/")).toBe("alice");
    expect(parsePasskeyUsernamePath("/@ab")).toBeNull();
    expect(parsePasskeyUsernamePath("/@alice/card")).toBeNull();
    expect(parsePasskeyUsernamePath("/alice")).toBeNull();
  });

  it("wipes only when an existing wallet differs from the target", () => {
    expect(shouldWipeForPasskeySwitch("old", "target", true)).toBe(true);
    expect(shouldWipeForPasskeySwitch("target", "target", true)).toBe(false);
    expect(shouldWipeForPasskeySwitch(null, "target", false)).toBe(false);
  });
});
