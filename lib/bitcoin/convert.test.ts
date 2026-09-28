import { describe, expect, it } from "vitest";
import { SATS_PER_BTC, classifyTransaction, satsToFiat } from "./convert";

describe("bitcoin conversions", () => {
  it("converts sats and fiat at the configured BTC price", () => {
    expect(SATS_PER_BTC).toBe(100_000_000);
    expect(satsToFiat(50_000_000, 60_000)).toBe(30_000);
  });

  it("returns null when price data cannot support conversion", () => {
    expect(satsToFiat(1, null)).toBeNull();
  });
});

describe("classifyTransaction", () => {
  const self = "bc1pself";
  const other = "bc1pmerchant";

  it("classifies external payments to self as incoming", () => {
    expect(
      classifyTransaction(
        {
          vin: [{ prevout: { scriptpubkey_address: other, value: 12_000 } }],
          vout: [{ scriptpubkey: "", scriptpubkey_address: self, value: 10_000 }],
        },
        self,
      ),
    ).toEqual({ isIncoming: true, amountSats: 10_000 });
  });

  it("reports only the recipient amount for outgoing transactions with change output", () => {
    expect(
      classifyTransaction(
        {
          vin: [{ prevout: { scriptpubkey_address: self, value: 100_000 } }],
          vout: [
            { scriptpubkey: "", scriptpubkey_address: other, value: 35_000 },
            { scriptpubkey: "", scriptpubkey_address: self, value: 64_000 },
          ],
        },
        self,
      ),
    ).toEqual({ isIncoming: false, amountSats: 35_000 });
  });

  it("falls back to input minus change for self-only consolidation", () => {
    expect(
      classifyTransaction(
        {
          vin: [{ prevout: { scriptpubkey_address: self, value: 100_000 } }],
          vout: [{ scriptpubkey: "", scriptpubkey_address: self, value: 99_000 }],
        },
        self,
      ),
    ).toEqual({ isIncoming: false, amountSats: 1_000 });
  });
});
