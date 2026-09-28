import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARBITRUM_TBTC, ARBITRUM_USDC, BASE_EURC } from "../../config/network";
import { validateSwapKitRecoveryQuote, type SwapKitRecoveryQuote } from "./SwapKitRecoveryQuote";

// Captured without modification from parent-export-recovery-quote.mjs using backend
// 19957f5187df56214fd5ad64963cc5d951065087: actual MCP/store/crypto, mocked HTTP only.
// Set SWAPKIT_RECOVERY_QUOTE_FILE to freshly generated output for a current-clock
// integration check. The committed fixture uses a fixed clock, never altered terms.
const freshQuoteFile = process.env.SWAPKIT_RECOVERY_QUOTE_FILE;
const quote: SwapKitRecoveryQuote = JSON.parse(
  readFileSync(
    freshQuoteFile ?? new URL("./__fixtures__/backend-recovery-quote.json", import.meta.url),
    "utf8",
  ),
);
const expected = { txId: quote.txId, owner: quote.owner, recipient: quote.recipient };

beforeEach(() => {
  if (!freshQuoteFile) {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(quote.expiresAt) - 1000);
  }
});
afterEach(() => vi.useRealTimers());

describe("real backend recovery quote contract (offline)", () => {
  it("accepts the original tBTC input with the actual current app validator", () => {
    expect(ARBITRUM_TBTC).toEqual({
      address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
      decimals: 18,
      chainId: 42161,
    });
    expect(quote.sourceToken).toBe(ARBITRUM_TBTC.address);
    expect(quote.sourceAmountUnits).toBe("5000000000000000");
    expect(Date.parse(quote.expiresAt)).toBeGreaterThan(Date.now());
    expect(() => validateSwapKitRecoveryQuote(quote, expected)).not.toThrow();
  });

  it.each([ARBITRUM_USDC.address, BASE_EURC.address, "0x1111111111111111111111111111111111111111"])(
    "rejects substituted source token %s even when preview and message agree",
    (sourceToken) => {
      const changed = structuredClone(quote);
      changed.sourceToken = sourceToken;
      changed.typedData.message.sourceToken = sourceToken;
      expect(() => validateSwapKitRecoveryQuote(changed, expected)).toThrow(
        "Invalid or expired recovery quote.",
      );
    },
  );
});
