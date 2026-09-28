import { describe, expect, it } from "vitest";
import { parsePayLinkPath } from "./payLinkPath";

describe("pay link paths", () => {
  it("accepts only one valid /pay/@username path", () => {
    expect(parsePayLinkPath("/pay/@Alice.Doe")).toBe("alice.doe");
    expect(parsePayLinkPath("/pay/@alice/")).toBe("alice");
    expect(parsePayLinkPath("/pay/%40alice")).toBe("alice");
    expect(parsePayLinkPath("/pay/@ab")).toBeNull();
    expect(parsePayLinkPath("/pay/@alice/card")).toBeNull();
    expect(parsePayLinkPath("/pay/alice")).toBeNull();
  });

  it("never matches the passkey login link", () => {
    expect(parsePayLinkPath("/@alice")).toBeNull();
    expect(parsePayLinkPath("/pay")).toBeNull();
  });
});
