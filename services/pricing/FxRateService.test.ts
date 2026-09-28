import { describe, expect, it } from "vitest";
import { convert, fxRateService, type FxRates } from "./FxRateService";

const rates: FxRates = {
  EUR: 1.25,
  GBP: 1.5,
  USD: 1,
};

describe("FxRateService.convert", () => {
  it("returns the input amount for same-currency conversions", () => {
    expect(fxRateService.convert(12.34, "EUR", "EUR", rates)).toBe(12.34);
  });

  it("converts through USD-relative rates", () => {
    expect(fxRateService.convert(100, "EUR", "USD", rates)).toBe(125);
    expect(fxRateService.convert(150, "GBP", "EUR", rates)).toBe(180);
  });

  it("pins the missing-rate fallback to the original amount", () => {
    expect(fxRateService.convert(42, "EUR", "GBP", { ...rates, GBP: 0 })).toBe(42);
    expect(fxRateService.convert(42, "EUR", "GBP", { ...rates, EUR: 0 })).toBe(42);
    expect(fxRateService.convert(42, "EUR", "GBP", { EUR: 1.25 } as FxRates)).toBe(42);
    expect(convert(42, "EUR", "GBP", { ...rates, GBP: 0 })).toBe(42);
  });
});
