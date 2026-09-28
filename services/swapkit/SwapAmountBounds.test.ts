import { describe, expect, it } from "vitest";

import { foldSwapAmountBounds, swapBoundBlock } from "./SwapAmountBounds";
import type { SwapKitV2LimitsResponse } from "./SwapKitV2Service";

const answer = (from: string, min: string | null, max: string | null): SwapKitV2LimitsResponse => ({
  from,
  to: "EURC_BASE",
  min,
  max,
  routes: [],
});

describe("foldSwapAmountBounds", () => {
  it("states a Bitcoin bound in sats, exactly as the server's decimal BTC", () => {
    expect(foldSwapAmountBounds([answer("BTC_ARKADE", "0.00005925", "0.0005")])).toEqual({
      min: 5_925,
      max: 50_000,
    });
  });

  it("keeps a stable bound in whole tokens", () => {
    expect(foldSwapAmountBounds([answer("USDC_BASE", "5", "1274.36")])).toEqual({
      min: 5,
      max: 1274.36,
    });
  });

  it("takes the least restrictive bound across the pairs one move quotes", () => {
    // arkade funds both the Arkade rail and the on-chain rail: the move works
    // if either takes it, so the smaller floor and the larger ceiling win.
    expect(
      foldSwapAmountBounds([
        answer("BTC_ARKADE", "0.00005925", "0.0005"),
        answer("BTC", "0.00005921", "0.01508612"),
      ]),
    ).toEqual({ min: 5_921, max: 1_508_612 });
  });

  it("leaves a bound open when any pair has none — never invents one", () => {
    expect(
      foldSwapAmountBounds([answer("BTC_ARKADE", "0.00005925", null), answer("BTC", null, "0.01")]),
    ).toEqual({ min: null, max: null });
  });

  it("leaves both bounds open when the server could not answer (old server)", () => {
    expect(foldSwapAmountBounds([null])).toEqual({ min: null, max: null });
    expect(foldSwapAmountBounds([answer("BTC", "0.0001", "0.01"), null])).toEqual({
      min: null,
      max: null,
    });
    expect(foldSwapAmountBounds([])).toEqual({ min: null, max: null });
  });

  it("rounds sub-sat bounds outward so a floor never drops below the provider's", () => {
    expect(foldSwapAmountBounds([answer("BTC", "0.000059251", "0.000500009")])).toEqual({
      min: 5_926,
      max: 50_000,
    });
  });
});

describe("swapBoundBlock", () => {
  const bounds = { min: 5_925, max: 50_000 };

  it("blocks below the minimum and names it", () => {
    expect(swapBoundBlock(5_000, bounds)).toEqual({ kind: "min", value: 5_925 });
  });

  it("blocks above the maximum and names it", () => {
    expect(swapBoundBlock(60_000, bounds)).toEqual({ kind: "max", value: 50_000 });
  });

  it("lets an amount inside the band through, bounds included", () => {
    expect(swapBoundBlock(5_925, bounds)).toBeNull();
    expect(swapBoundBlock(50_000, bounds)).toBeNull();
  });

  it("never blocks without an amount or without a known bound", () => {
    expect(swapBoundBlock(0, bounds)).toBeNull();
    expect(swapBoundBlock(10, null)).toBeNull();
    expect(swapBoundBlock(10, { min: null, max: null })).toBeNull();
  });
});
