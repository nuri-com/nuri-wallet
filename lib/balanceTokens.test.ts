import { describe, expect, it } from "vitest";
import { tokenizeFiatBalance, tokenizeSatsBalance } from "./balanceTokens";

const chars = (tokens: ReturnType<typeof tokenizeFiatBalance>["tokens"]) =>
  tokens.map((token) => ("char" in token ? token.char : "_")).join("");

describe("tokenizeFiatBalance", () => {
  it("formats fiat balances with fixed cents and a dot token", () => {
    const { tokens, isNegative } = tokenizeFiatBalance(12.3);
    expect(isNegative).toBe(false);
    expect(chars(tokens)).toBe("12.30");
    expect(tokens.map((token) => token.type)).toEqual(["digit", "digit", "dot", "digit", "digit"]);
  });

  it("tracks negative values and leading zero digits", () => {
    const { tokens, isNegative } = tokenizeFiatBalance(-0.01);
    expect(isNegative).toBe(true);
    expect(chars(tokens)).toBe("0.01");
    expect(
      tokens
        .filter((token) => token.type === "digit" && token.leading)
        .map((token) => ("char" in token ? token.char : "_")),
    ).toEqual(["0", "0"]);
  });
});

describe("tokenizeSatsBalance", () => {
  it("truncates fractional sats and tokenizes integer digits", () => {
    const { tokens, isNegative } = tokenizeSatsBalance(123.9);
    expect(isNegative).toBe(false);
    expect(chars(tokens)).toBe("123");
  });

  it("handles non-finite and negative sats safely", () => {
    expect(tokenizeSatsBalance(Number.NaN)).toEqual({
      isNegative: false,
      tokens: [{ key: "int-0", type: "digit", char: "0", leading: true }],
    });
    expect(tokenizeSatsBalance(-12).isNegative).toBe(true);
  });
});
