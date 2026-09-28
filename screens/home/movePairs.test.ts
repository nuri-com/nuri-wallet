import { describe, expect, it } from "vitest";

import { CARD_USD_RAIL } from "./moveBookkeeping";
import {
  CARD_EUR_RAIL,
  moveDestinationsFor,
  moveRailPairOpen,
  moveRailPickOpen,
  moveSourcePick,
} from "./movePairs";

// #1467 as refined: every source is pickable and the destination follows it
// onto a pair that can run; a destination the source cannot reach is refused
// (greyed out), never silently swapped for something else.
const pick = (
  pair: { fromKey: string | null; toKey: string | null },
  side: "from" | "to",
  key: string,
) => moveRailPickOpen(moveDestinationsFor, pair, side, key);
const pickSource = (pair: { fromKey: string | null; toKey: string | null }, key: string) =>
  moveSourcePick(moveDestinationsFor, pair, key);
const ALL = ["wallet", "dollar", "arkade", "onchain", CARD_EUR_RAIL, CARD_USD_RAIL];

describe("Move sheet card pairs", () => {
  it("every source is pickable whatever the destination", () => {
    for (const toKey of ALL) {
      for (const key of ALL) {
        expect(pick({ fromKey: "arkade", toKey }, "from", key)).toBe(true);
      }
    }
  });

  it("picking a source keeps the destination when the pair is open", () => {
    expect(pickSource({ fromKey: "arkade", toKey: "wallet" }, CARD_EUR_RAIL)).toEqual({
      fromKey: CARD_EUR_RAIL,
      toKey: "wallet",
    });
    expect(pickSource({ fromKey: "wallet", toKey: "arkade" }, "onchain")).toEqual({
      fromKey: "onchain",
      toKey: "arkade",
    });
  });

  it("picking a source with no route to the destination moves it to the source's default", () => {
    // Lightning, then VISA Euro as the source: the destination becomes the euro wallet.
    expect(pickSource({ fromKey: "wallet", toKey: "arkade" }, CARD_EUR_RAIL)).toEqual({
      fromKey: CARD_EUR_RAIL,
      toKey: "wallet",
    });
    expect(pickSource({ fromKey: "arkade", toKey: "wallet" }, CARD_USD_RAIL)).toEqual({
      fromKey: CARD_USD_RAIL,
      toKey: "dollar",
    });
  });

  it("picking the destination as the source swaps the ends, or moves to a valid one", () => {
    expect(pickSource({ fromKey: "arkade", toKey: "wallet" }, "wallet")).toEqual({
      fromKey: "wallet",
      toKey: "arkade",
    });
    expect(pickSource({ fromKey: "arkade", toKey: CARD_EUR_RAIL }, CARD_EUR_RAIL)).toEqual({
      fromKey: CARD_EUR_RAIL,
      toKey: "wallet",
    });
  });

  it("a source pick never leaves an impossible or collapsed pair", () => {
    for (const fromKey of ALL) {
      for (const toKey of ALL) {
        for (const key of ALL) {
          const next = pickSource({ fromKey, toKey }, key);
          expect(next.fromKey).toBe(key);
          expect(next.toKey).not.toBe(key);
          if (next.toKey) {
            expect(moveRailPairOpen(moveDestinationsFor, next.fromKey, next.toKey)).toBe(true);
          }
        }
      }
    }
  });

  it("the destination picker refuses what a card pocket cannot reach", () => {
    const euro = { fromKey: CARD_EUR_RAIL, toKey: "wallet" };
    expect(pick(euro, "to", "wallet")).toBe(true);
    for (const key of ["arkade", "onchain", "dollar", CARD_USD_RAIL]) {
      expect(pick(euro, "to", key)).toBe(false);
    }
    const dollar = { fromKey: CARD_USD_RAIL, toKey: "dollar" };
    expect(pick(dollar, "to", "dollar")).toBe(true);
    for (const key of ["arkade", "onchain", "wallet", CARD_EUR_RAIL]) {
      expect(pick(dollar, "to", key)).toBe(false);
    }
  });

  it("leaves every non-card source open, to be answered by pricing", () => {
    expect(pick({ fromKey: "arkade", toKey: null }, "to", CARD_EUR_RAIL)).toBe(true);
  });
});
