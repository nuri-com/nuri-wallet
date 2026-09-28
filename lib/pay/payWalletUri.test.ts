import { describe, expect, it } from "vitest";
import { addressTarget, type PayTarget } from "./payTarget";
import { payWalletUri } from "./payWalletUri";

const address = "bc1qpublictestaddress";
const btc = addressTarget({ kind: "btc-onchain", source: "BTC", address }, address, 25_000n);

describe("external wallet handoff", () => {
  it("hands off the same BIP-21 amount as the QR", () => {
    expect(payWalletUri(btc)).toBe(btc.uri);
    expect(payWalletUri(btc)).toBe(`bitcoin:${address}?amount=0.00025000`);
  });
  it("supports amountless Bitcoin without changing its QR", () => {
    const target: PayTarget = { ...btc, uri: address, amount: null };
    expect(payWalletUri(target)).toBe(`bitcoin:${address}`);
    expect(target.uri).toBe(address);
  });
  it("wraps the existing verified Lightning invoice without changing it", () => {
    const target: PayTarget = {
      ...btc,
      kind: "invoice",
      asset: "BTC_LN",
      value: "lnbc250nfixture",
      uri: "lnbc250nfixture",
    };
    expect(payWalletUri(target)).toBe("lightning:lnbc250nfixture");
  });
  it.each(["BTC_ARKADE", "USDC_BASE", "EURC_BASE", "USDC_ARBITRUM"])(
    "does not invent a handoff for %s",
    (asset) => {
      expect(payWalletUri({ ...btc, asset })).toBeNull();
    },
  );
});
