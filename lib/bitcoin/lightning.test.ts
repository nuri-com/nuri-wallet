import { describe, expect, it } from "vitest";
import {
  decodeBolt11Debug,
  extractOnchainAddress,
  isBolt11Invoice,
  isValidRequestPrefill,
} from "./lightning";

describe("lightning request helpers", () => {
  it.each([
    ["bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT?amount=0.1", "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"],
    [
      "  BITCOIN:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080  ",
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
    ],
    ["", null],
  ] as const)("extracts on-chain address from %s", (raw, expected) => {
    expect(extractOnchainAddress(raw)).toBe(expected);
  });

  it.each([
    ["lnbc1pvjluez", true],
    ["LNBC1PVJLUEZ", true],
    ["lnurl1dp68gurn8ghj7", false],
    // A BOLT-12 offer is `ln`-prefixed too, and nothing here can pay one.
    ["lno1pqps7sjqpgtyzm3qv4uxzmtsd3jjqer9wd3hy6tsw35k7msjzfpy7nz5yqcn", false],
    ["LNO1PQPS7SJQPGTYZM3QV4UXZMTSD3JJQER9WD3HY6TSW35K7MSJZFPY7NZ5YQCN", false],
    ["ln bc1pvjluez", false],
    ["bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT", false],
  ] as const)("classifies bolt11-shaped input %s", (raw, expected) => {
    expect(isBolt11Invoice(raw)).toBe(expected);
  });

  it("accepts valid on-chain prefill and rejects malformed requests", () => {
    expect(isValidRequestPrefill("bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT?amount=0.1")).toBe(
      true,
    );
    expect(isValidRequestPrefill("not a payment request")).toBe(false);
  });

  it("returns structured debug failure for empty or malformed invoices", () => {
    expect(decodeBolt11Debug("")).toMatchObject({ ok: false, err: "invoice_empty" });
    expect(decodeBolt11Debug("lnbc1notvalid")).toMatchObject({ ok: false, network: "lnbc" });
  });
});
