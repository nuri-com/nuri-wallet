import { describe, expect, it } from "vitest";
import { canonicalizeBitcoinAddress, isValidBitcoinAddressMainnet } from "./address";

const bech32Address = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const mixedCaseBech32 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt08A";

describe("bitcoin address helpers", () => {
  it("canonicalizes uniformly cased bech32 addresses only", () => {
    expect(canonicalizeBitcoinAddress(bech32Address.toUpperCase())).toBe(bech32Address);
    expect(canonicalizeBitcoinAddress("  1BoatSLRHtKNngkdXEeobR76b53LETtpyT  ")).toBe(
      "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
    );
    expect(canonicalizeBitcoinAddress(mixedCaseBech32)).toBe(mixedCaseBech32);
  });

  it("rejects mixed-case bech32 addresses instead of normalizing substitution risk", () => {
    expect(isValidBitcoinAddressMainnet("1BoatSLRHtKNngkdXEeobR76b53LETtpyT")).toBe(true);
    expect(isValidBitcoinAddressMainnet(mixedCaseBech32)).toBe(false);
  });
});
