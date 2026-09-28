import { describe, expect, it } from "vitest";
import { parseBitcoinUri } from "./uri";

const bech32Address = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

describe("parseBitcoinUri", () => {
  it.each([
    ["plain address", `  ${bech32Address}  `, { address: bech32Address }],
    ["bitcoin URI", `bitcoin:${bech32Address}`, { address: bech32Address }],
    ["btc URI", `BTC:${bech32Address}`, { address: bech32Address }],
    ["uppercase bech32 URI", `bitcoin:${bech32Address.toUpperCase()}`, { address: bech32Address }],
  ] as const)("parses %s", (_label, raw, expected) => {
    expect(parseBitcoinUri(raw)).toEqual(expected);
  });

  it("parses positive BTC amounts into rounded sats and preserves lightning fallback", () => {
    expect(
      parseBitcoinUri(`bitcoin:${bech32Address}?amount=0.00001234&lightning= lnbc1invoice `),
    ).toEqual({
      address: bech32Address,
      amountSats: 1234,
      lightning: "lnbc1invoice",
    });
  });

  it.each(["", "bitcoin:", "btc:?amount=1"])("rejects empty input %s", (raw) => {
    expect(parseBitcoinUri(raw)).toBeNull();
  });

  it.each(["0", "-1", "not-a-number"])("ignores non-positive or invalid amounts: %s", (amount) => {
    expect(parseBitcoinUri(`bitcoin:${bech32Address}?amount=${amount}`)).toEqual({
      address: bech32Address,
    });
  });
});
