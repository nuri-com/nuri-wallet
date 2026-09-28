import { describe, expect, it } from "vitest";
import {
  carriedAmountText,
  formatBalance,
  formatEuro,
  formatSats,
  parseEurAmount,
  parseFiatAmount,
  stableAmountText,
  toSatsFromBtcAmount,
  truncateBalanceToCents,
  truncateDecimalString,
} from "./amounts";

describe("amount helpers", () => {
  it("truncates decimal strings without rounding and pads missing fractional digits", () => {
    expect(truncateDecimalString("12.999", 2)).toBe("12.99");
    expect(truncateDecimalString("12", 2)).toBe("12.00");
    expect(truncateDecimalString("12.9", 4)).toBe("12.9000");
    expect(truncateDecimalString("12.99", 0)).toBe("12");
  });

  it("parses whole-euro entry by stripping non-digits", () => {
    expect(parseEurAmount("€1,234abc")).toBe(1234);
    expect(parseEurAmount("")).toBe(0);
    expect(parseEurAmount("abc")).toBe(0);
  });

  it("parses fiat decimals only when finite", () => {
    expect(parseFiatAmount(" 12.34 ")).toBe(12.34);
    expect(parseFiatAmount("-12.34")).toBe(-12.34);
    expect(parseFiatAmount("abc")).toBe(0);
    expect(parseFiatAmount(null)).toBe(0);
  });

  it("formats euros and sats for display", () => {
    expect(formatEuro(1.2)).toBe("EUR 1.20");
    expect(formatSats(1234567.9)).toBe("1\u00A0234\u00A0567");
    expect(formatSats(-5)).toBe("0");
  });

  it("converts positive BTC amounts to rounded sats and rejects invalid values", () => {
    expect(toSatsFromBtcAmount("0.00000001")).toBe(1);
    expect(toSatsFromBtcAmount("1.234567895")).toBe(123456790);
    expect(toSatsFromBtcAmount("0")).toBe(0);
    expect(toSatsFromBtcAmount("abc")).toBe(0);
  });

  it("truncates balances to cents and splits fixed two-decimal balances", () => {
    expect(truncateBalanceToCents(1.239)).toBe(1.23);
    expect(formatBalance(12)).toEqual({ whole: "12", decimal: "00" });
  });

  // Moving the focus or flipping the pair re-expresses the typed amount on the
  // other rail. Deciding its precision by magnitude rounded every fiat figure of
  // 1000 and up to whole units — before the move was quoted and executed.
  it("carries an amount at the precision of the rail that receives it", () => {
    expect(carriedAmountText(2340.49, false)).toBe("2340.49");
    expect(carriedAmountText(25.5, false)).toBe("25.50");
    expect(carriedAmountText(1200.4, true)).toBe("1200");
    expect(carriedAmountText(999.6, true)).toBe("1000");
  });
});

describe("stableAmountText", () => {
  it("keeps every stablecoin decimal of a full balance, never rounding up", () => {
    expect(stableAmountText(0.995018)).toBe("0.995018");
    expect(stableAmountText(12.5)).toBe("12.5");
    expect(stableAmountText(3)).toBe("3");
    // Beyond the token's 6 decimals it cuts; it never asks for more than held.
    expect(stableAmountText(0.9999999)).toBe("0.999999");
  });
});
