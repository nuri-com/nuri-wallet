import { describe, expect, it } from "vitest";
import { assertMeetsVtxoMinimum, requireVtxoMinimumSats } from "./sendMinimums";

describe("the node's VTXO floor", () => {
  // The live figure, whatever it is. It moved from 3000 to 330 without a
  // release, which is why nothing here states a number of its own.
  it.each([
    ["the current mainnet floor", 330, 330],
    ["the floor it replaced", 3000, 3000],
    ["a string, as the node encodes it", "330", 330],
  ])("reads %s off the node info", (_label, vtxoMinAmount, expected) => {
    expect(requireVtxoMinimumSats({ vtxoMinAmount })).toBe(expected);
  });

  // An unknown floor is not a floor of zero: letting the send through would
  // spend a passkey prompt and an approval on an amount the server refuses
  // moments later.
  it.each([
    ["node info is unavailable", null, /missing_node_info/],
    ["the field is absent", {}, /missing_vtxo_minimum/],
    ["the field is zero", { vtxoMinAmount: 0 }, /missing_vtxo_minimum/],
    ["the field is not a number", { vtxoMinAmount: "many" }, /missing_vtxo_minimum/],
  ])("fails closed when %s", (_label, info, message) => {
    expect(() => requireVtxoMinimumSats(info as never)).toThrow(message);
  });
});

describe("the amount check", () => {
  it("passes an amount at or above the floor", () => {
    expect(() => assertMeetsVtxoMinimum(330, 330)).not.toThrow();
    expect(() => assertMeetsVtxoMinimum(500, 330)).not.toThrow();
  });

  // 500 used to be hardcoded here. Against today's 330 it passes; against the
  // floor that preceded it, it does not — and the refusal names both figures.
  it("refuses an amount below the floor and states both numbers", () => {
    expect(() => assertMeetsVtxoMinimum(500, 3000)).toThrow(/requested=500 min_vtxo_sats=3000/);
  });
});
