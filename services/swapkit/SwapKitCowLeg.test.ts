import { describe, expect, it } from "vitest";
import { BASE_EURC, BASE_USDC } from "../../config/network";
import { assertCowLegBelongsToRoute } from "./SwapKitCowLeg";

describe("the CoW leg guard", () => {
  it("allows the leg that sells the hub's USDC for euros", () => {
    expect(() => assertCowLegBelongsToRoute(BASE_EURC.address)).not.toThrow();
  });

  // Both sides USDC is a leg the accepted route does not contain. The
  // in-session loop and the resumed tracker share this so their answers cannot
  // depend on whether the app restarted.
  it("refuses a USDC-to-USDC leg", () => {
    expect(() => assertCowLegBelongsToRoute(BASE_USDC.address)).toThrow(/USDC order has no/);
  });

  it("compares addresses case-insensitively", () => {
    expect(() => assertCowLegBelongsToRoute(BASE_USDC.address.toUpperCase())).toThrow(
      /USDC order has no/,
    );
  });
});
