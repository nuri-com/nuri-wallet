import { describe, expect, it } from "vitest";
import type { PayRecipient } from "./resolvePayRecipient";
import {
  availablePaySources,
  type PaySourceAsset,
  railRequiresAmount,
  selectPayRail,
} from "./selectPayRail";

const full: PayRecipient = {
  username: "alice",
  lightningAddress: "alice@nuri.com",
  evmAddress: "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B",
  arkadeAddress: "ark1qtest",
  btcAddress: "bc1ptest",
};

describe("pay rail selection", () => {
  it("sends a matching source straight to the recipient's own rail", () => {
    expect(selectPayRail("BTC", full)).toEqual({
      kind: "btc-onchain",
      source: "BTC",
      address: full.btcAddress,
    });
    expect(selectPayRail("BTC_LN", full)).toEqual({
      kind: "lightning",
      source: "BTC_LN",
      lightningAddress: full.lightningAddress,
    });
    expect(selectPayRail("BTC_ARKADE", full)).toEqual({
      kind: "arkade",
      source: "BTC_ARKADE",
      address: full.arkadeAddress,
    });
    expect(selectPayRail("EURC_BASE", full)).toEqual({
      kind: "evm-stable",
      source: "EURC_BASE",
      asset: "EURC_BASE",
      address: full.evmAddress,
    });
  });

  it("swaps a source the recipient cannot use where it lands", () => {
    expect(selectPayRail("USDC_ARBITRUM", full)).toEqual({
      kind: "swap",
      source: "USDC_ARBITRUM",
      from: "USDC_ARBITRUM",
      to: "USDC_BASE",
      settleTarget: full.evmAddress,
    });
  });

  it("returns null rather than substituting another destination", () => {
    const btcOnly: PayRecipient = {
      username: "bob",
      lightningAddress: null,
      evmAddress: null,
      arkadeAddress: null,
      btcAddress: "bc1ptest",
    };
    expect(selectPayRail("BTC_LN", btcOnly)).toBeNull();
    expect(selectPayRail("USDC_BASE", btcOnly)).toBeNull();
    expect(availablePaySources(btcOnly)).toEqual(["BTC"]);
  });

  it("offers every rail a fully published recipient has", () => {
    expect(availablePaySources(full)).toEqual([
      "BTC",
      "BTC_LN",
      "BTC_ARKADE",
      "USDC_BASE",
      "EURC_BASE",
      "USDC_ARBITRUM",
    ]);
  });

  it("needs an amount only where one has to be priced or invoiced", () => {
    const needsAmount = (source: PaySourceAsset) => {
      const rail = selectPayRail(source, full);
      expect(rail).not.toBeNull();
      return rail ? railRequiresAmount(rail) : null;
    };
    expect(needsAmount("BTC_LN")).toBe(true);
    expect(needsAmount("USDC_ARBITRUM")).toBe(true);
    expect(needsAmount("BTC")).toBe(false);
    expect(needsAmount("USDC_BASE")).toBe(false);
  });
});
