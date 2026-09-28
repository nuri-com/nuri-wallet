import { describe, expect, it } from "vitest";
import {
  CIRCLE_EURC_BASE_MAINNET,
  CURRENCIES,
  fiatCodeFromTokenSymbol,
  findCurrencyByAddress,
  getAddress,
  getDecimals,
  resolveFiatCode,
} from "./tokens";

describe("token registry", () => {
  it("resolves configured deployment addresses", () => {
    expect(getAddress("EUR", 8453)).toBe(CURRENCIES.EUR.deployments[8453]?.address);
    expect(getAddress("GBP", 84532)).toBeUndefined();
  });

  it("prefers per-deployment decimals over currency-level defaults", () => {
    expect(getDecimals("EUR", 84532)).toBe(6);
    expect(getDecimals("EUR", 1)).toBe(18);
    expect(getDecimals("USD", 84532)).toBe(6);
  });

  it("keeps the Circle EURC Base mainnet deployment pinned to 6 decimals", () => {
    expect(CIRCLE_EURC_BASE_MAINNET).toMatchObject({
      fiatCode: "EUR",
      tokenSymbol: "EURC",
      chainId: 8453,
      decimals: 6,
    });
  });

  it("finds currencies and codes case-insensitively", () => {
    expect(findCurrencyByAddress("0xF70461FFB413981852683657A310892227E3989E")?.fiatCode).toBe(
      "EUR",
    );
    expect(fiatCodeFromTokenSymbol("eure")).toBe("EUR");
    expect(resolveFiatCode("USDC.e")).toBe("USD");
    expect(resolveFiatCode(null)).toBe("EUR");
  });
});
