import { describe, expect, it } from "vitest";

// Reported repeatedly: a Bitcoin -> Bitcoin move (arkade/Lightning -> on-chain
// BTC, and on-chain -> arkade) showed NO pending row on the arkade balance
// screen while the sats were in flight. The row builder asked once whether the
// move as a whole spends or receives Bitcoin; with Bitcoin on BOTH sides the
// answer was "neither", so the move was skipped entirely.
import { btcAssetRail, btcMoveRailLeg } from "./btcMoveRail";

const OWN = { arkade: "ark1own", onchain: "bc1own" };

describe("every Bitcoin leg lands on the rail that actually moves the sats", () => {
  it("arkade -> own on-chain address: spend on arkade, arrival on onchain", () => {
    const move = { from: "BTC_ARKADE", to: "BTC", settleTarget: "bc1own" };
    expect(btcMoveRailLeg(move, "arkade", OWN)).toBe("out");
    expect(btcMoveRailLeg(move, "onchain", OWN)).toBe("in");
  });

  it("the arkade -> BTC flow commits as BTC_LN -> BTC and still shows on arkade", () => {
    // SwapKitV2ArkadeToBtcService commits FROM_ASSET "BTC_LN", TO_ASSET "BTC".
    const move = { from: "BTC_LN", to: "BTC", settleTarget: "bc1own" };
    expect(btcMoveRailLeg(move, "arkade", OWN)).toBe("out");
    expect(btcMoveRailLeg(move, "onchain", OWN)).toBe("in");
  });

  it("a send to SOMEONE ELSE's address debits arkade and credits nothing", () => {
    // Same corridor, external recipient: crediting the on-chain rail here would
    // state money arriving that is in fact leaving the wallet.
    const move = { from: "BTC_LN", to: "BTC", settleTarget: "bc1qstranger" };
    expect(btcMoveRailLeg(move, "arkade", OWN)).toBe("out");
    expect(btcMoveRailLeg(move, "onchain", OWN)).toBe(null);
  });

  it("on-chain -> arkade draws the spend on onchain and the credit on arkade", () => {
    const move = { from: "BTC", to: "BTC_ARKADE" };
    expect(btcMoveRailLeg(move, "onchain", OWN)).toBe("out");
    expect(btcMoveRailLeg(move, "arkade", OWN)).toBe("in");
  });

  it("stable -> Bitcoin credits the rail that receives it", () => {
    // Boarding address: the sats land on-chain and board into arkade.
    const boarding = { from: "EURC_BASE", to: "BTC", settleTarget: "ark1own" };
    expect(btcMoveRailLeg(boarding, "arkade", OWN)).toBe("in");
    expect(btcMoveRailLeg(boarding, "onchain", OWN)).toBe(null);
    // Plain on-chain receive.
    const onchain = { from: "EURC_BASE", to: "BTC", settleTarget: "bc1own" };
    expect(btcMoveRailLeg(onchain, "onchain", OWN)).toBe("in");
    expect(btcMoveRailLeg(onchain, "arkade", OWN)).toBe(null);
    // Explicit arkade asset.
    const ark = { from: "USDC_BASE", to: "BTC_ARKADE" };
    expect(btcMoveRailLeg(ark, "arkade", OWN)).toBe("in");
    expect(btcMoveRailLeg(ark, "onchain", OWN)).toBe(null);
  });

  it("Bitcoin -> stable debits the paying rail and credits neither", () => {
    const fromArkade = { from: "BTC_ARKADE", to: "EURC_BASE" };
    expect(btcMoveRailLeg(fromArkade, "arkade", OWN)).toBe("out");
    expect(btcMoveRailLeg(fromArkade, "onchain", OWN)).toBe(null);
    const fromOnchain = { from: "BTC", to: "USDC_BASE" };
    expect(btcMoveRailLeg(fromOnchain, "onchain", OWN)).toBe("out");
    expect(btcMoveRailLeg(fromOnchain, "arkade", OWN)).toBe(null);
  });

  it("a stable -> stable move touches no Bitcoin rail", () => {
    const move = { from: "EURC_BASE", to: "USDC_BASE" };
    expect(btcMoveRailLeg(move, "arkade", OWN)).toBe(null);
    expect(btcMoveRailLeg(move, "onchain", OWN)).toBe(null);
  });

  it("an unknown BTC recipient credits nothing, even with no own addresses known", () => {
    const move = { from: "EURC_BASE", to: "BTC", settleTarget: "bc1qstranger" };
    expect(btcMoveRailLeg(move, "onchain", {})).toBe(null);
    expect(btcMoveRailLeg(move, "arkade", {})).toBe(null);
  });

  it("accepts the arkade address as a bare string (older call shape)", () => {
    const move = { from: "EURC_BASE", to: "BTC", settleTarget: "ark1own" };
    expect(btcMoveRailLeg(move, "arkade", "ark1own")).toBe("in");
    expect(btcMoveRailLeg(move, "onchain", "ark1own")).toBe(null);
  });

  it("maps each asset id to its rail", () => {
    expect(btcAssetRail("BTC")).toBe("onchain");
    expect(btcAssetRail("BTC_ARKADE")).toBe("arkade");
    expect(btcAssetRail("BTC_LN")).toBe("arkade");
    expect(btcAssetRail("EURC_BASE")).toBe(null);
    expect(btcAssetRail("")).toBe(null);
  });
});
