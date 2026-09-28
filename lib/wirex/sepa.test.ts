import { describe, expect, it } from "vitest";
import { pickSepaDebitToken } from "./sepa";

describe("pickSepaDebitToken", () => {
  it("prefers the highest-balance EUR-pegged token over non-EUR tokens", () => {
    expect(
      pickSepaDebitToken([
        { tokenAddress: "0xusd", tokenSymbol: "USDC", balance: "1000" },
        { tokenAddress: "0xeur-low", tokenSymbol: "EURC", balance: "10" },
        { tokenAddress: "0xeur-high", tokenSymbol: "WEUR", balance: "20" },
      ]),
    ).toEqual({ tokenAddress: "0xeur-high", tokenSymbol: "WEUR", balance: 20 });
  });

  it("falls back to the highest positive usable token when no EUR token is available", () => {
    expect(
      pickSepaDebitToken([
        { tokenAddress: "0xusd", tokenSymbol: "USDC", balance: "12" },
        { tokenAddress: "0xgbp", tokenSymbol: "GBPe", balance: "15" },
      ]),
    ).toEqual({ tokenAddress: "0xgbp", tokenSymbol: "GBPe", balance: 15 });
  });

  it("returns null when balances are missing, non-positive, or unusable", () => {
    expect(pickSepaDebitToken([])).toBeNull();
    expect(
      pickSepaDebitToken([
        { tokenAddress: "", tokenSymbol: "EURC", balance: "10" },
        { tokenAddress: "0xzero", tokenSymbol: "EURC", balance: "0" },
        { tokenAddress: "0xbad", tokenSymbol: "EURC", balance: "nope" },
      ]),
    ).toBeNull();
  });
});
