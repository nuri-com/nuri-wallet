import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The Arkade rail funds from Arkade: its quote and commit declare the Arkade
// signer, the same value on both. The on-chain rail stays EVM-only.
const source = readFileSync("services/swapkit/SwapKitV2BtcToStableService.ts", "utf8");

describe("BTC to stable signer class", () => {
  it("Arkade declares the Arkade signer; on-chain stays EVM", () => {
    expect(source).toMatch(
      /rail === "BTC_ARKADE" \? \{ evm: "eoa", arkade: "arkade-vhtlc" \} : \{ evm: "eoa" \}/,
    );
  });

  it("quote and commit use the same value", () => {
    const uses = source.match(/signerClass: btcToStableSignerClass\(args\.rail\)/g) ?? [];
    expect(uses).toHaveLength(2);
    expect(source).not.toMatch(/signerClass: \{ evm: "eoa" \}/);
  });
});
