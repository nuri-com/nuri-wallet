import { describe, expect, it } from "vitest";

import {
  cardCreditForMove,
  cardSwapTargetFor,
  cardTransferToken,
  spendsArkadeBalance,
  walletCreditForMove,
} from "./moveBookkeeping";

const order = (quotedReceive: number | null, orderId: string | null = "order-1") => ({
  quotedReceive,
  orderId,
});

describe("cardCreditForMove", () => {
  it("credits the card with what the executed order bought — the dollar → card move", () => {
    // USDC sold for EURC settling on the card: the debit is on chain within
    // seconds, so the card has to state its side now and not at the next poll.
    expect(cardCreditForMove("visa", { receiveAmount: 90.5 }, order(91.2))).toEqual({
      amount: 91.2,
      currency: "EUR",
      orderId: "order-1",
    });
    expect(cardCreditForMove("iban", { receiveAmount: 90.5 }, order(91.2))).toEqual({
      amount: 91.2,
      currency: "EUR",
      orderId: "order-1",
    });
  });

  it("states the dollar pocket's credit in dollars", () => {
    // EURC sold for USDC settling on the card: the figure that arrives is USD,
    // and crediting the card's euro total with it would inflate the balance.
    expect(cardCreditForMove("visaUsd", { receiveAmount: 90.5 }, order(91.2))).toEqual({
      amount: 91.2,
      currency: "USD",
      orderId: "order-1",
    });
  });

  it("falls back to the accepted quote when the order states no figure", () => {
    expect(cardCreditForMove("visa", { receiveAmount: 90.5 }, order(null))).toEqual({
      amount: 90.5,
      currency: "EUR",
      orderId: "order-1",
    });
  });

  it("credits nothing when no order can ever settle it", () => {
    // A swap that failed AFTER paying returns no execution: the durable tracker
    // owns that outcome, and a credit parked under no id is one nothing could
    // confirm or take back.
    expect(cardCreditForMove("visa", { receiveAmount: 90.5 }, null)).toBeNull();
    expect(cardCreditForMove("visa", { receiveAmount: 90.5 }, order(91.2, null))).toBeNull();
    expect(cardCreditForMove("visa", { receiveAmount: 90.5 }, order(91.2, "  "))).toBeNull();
  });

  it("credits nothing when the destination is not the card", () => {
    expect(cardCreditForMove("wallet", { receiveAmount: 90.5 }, order(91.2))).toBeNull();
    expect(cardCreditForMove("arkade", { receiveAmount: 90.5 }, order(91.2))).toBeNull();
    expect(cardCreditForMove(null, { receiveAmount: 90.5 }, order(91.2))).toBeNull();
  });

  it("credits nothing for a figure that cannot be shown", () => {
    expect(cardCreditForMove("visa", { receiveAmount: 0 }, order(0))).toBeNull();
    expect(cardCreditForMove("visa", { receiveAmount: -5 }, order(null))).toBeNull();
    expect(cardCreditForMove("visa", { receiveAmount: Number.NaN }, order(null))).toBeNull();
  });
});

describe("cardSwapTargetFor", () => {
  const ADDRESS = "0x1111111111111111111111111111111111111111";

  it("prices the euro pocket from the dollar rail, and the dollar pocket from the euro one", () => {
    expect(cardSwapTargetFor("dollar", "visa", ADDRESS)).toEqual({
      asset: "EURC_BASE",
      settleAddress: ADDRESS,
      settleKind: "card",
    });
    expect(cardSwapTargetFor("dollar", "iban", ADDRESS)).toEqual({
      asset: "EURC_BASE",
      settleAddress: ADDRESS,
      settleKind: "card",
    });
    expect(cardSwapTargetFor("wallet", "visaUsd", ADDRESS)).toEqual({
      asset: "USDC_BASE",
      settleAddress: ADDRESS,
      settleKind: "card",
    });
  });

  it("recovers when the address arrives after the sheet was opened", () => {
    // Move opened from Dollar while Wirex was still loading: nothing to offer
    // yet, and the SAME question answered once the address lands must offer the
    // route — no toggling the source rail to wake it up.
    expect(cardSwapTargetFor("dollar", "visa", null)).toBeNull();
    expect(cardSwapTargetFor("dollar", "visa", "")).toBeNull();
    expect(cardSwapTargetFor("dollar", "visa", "   ")).toBeNull();
    expect(cardSwapTargetFor("dollar", "visa", ADDRESS)).not.toBeNull();
  });

  it("prices nothing when the same currency stands on both ends", () => {
    // Those are transfers, and the caller sends them.
    expect(cardSwapTargetFor("wallet", "visa", ADDRESS)).toBeNull();
    expect(cardSwapTargetFor("dollar", "visaUsd", ADDRESS)).toBeNull();
  });

  it("prices the card pocket from a bitcoin source, like any other destination", () => {
    // #1458: the card is a destination, not a different flow. Bitcoin buys the stable the pocket needs and
    // settles it on the card account, so the move flow prices exactly what the top-up screen used to.
    expect(cardSwapTargetFor("arkade", "visa", ADDRESS)).toEqual({
      asset: "EURC_BASE",
      settleAddress: ADDRESS,
      settleKind: "card",
    });
    expect(cardSwapTargetFor("onchain", "iban", ADDRESS)).toEqual({
      asset: "EURC_BASE",
      settleAddress: ADDRESS,
      settleKind: "card",
    });
    expect(cardSwapTargetFor("arkade", "visaUsd", ADDRESS)).toEqual({
      asset: "USDC_BASE",
      settleAddress: ADDRESS,
      settleKind: "card",
    });
    // No address yet is still nothing to price, whatever the source.
    expect(cardSwapTargetFor("arkade", "visa", null)).toBeNull();
  });

  it("prices nothing for a destination that is not the card", () => {
    expect(cardSwapTargetFor("dollar", "wallet", ADDRESS)).toBeNull();
    expect(cardSwapTargetFor("dollar", null, ADDRESS)).toBeNull();
  });
});

describe("cardTransferToken", () => {
  it("names the token a transfer into each card pocket sends", () => {
    expect(cardTransferToken("visa")?.asset).toBe("EURC_BASE");
    expect(cardTransferToken("iban")?.asset).toBe("EURC_BASE");
    expect(cardTransferToken("visaUsd")?.asset).toBe("USDC_BASE");
  });

  it("names nothing for a rail that is not the card", () => {
    expect(cardTransferToken("wallet")).toBeNull();
    expect(cardTransferToken(null)).toBeNull();
  });
});

describe("spendsArkadeBalance", () => {
  // The outgoing hold restates the ARKADE balance. Arming it for a move off the
  // legacy on-chain wallet hid arkade sats that never left, for the length of
  // the hold, while the rail that actually paid was left unchanged.
  it("holds only for a move funded by the arkade rail", () => {
    expect(spendsArkadeBalance({ engine: "btc-to-stable", sendSource: "arkade" })).toBe(true);
    expect(spendsArkadeBalance({ engine: "btc-to-stable", sendSource: "onchain" })).toBe(false);
  });

  it("reads an unnamed source as arkade — the default the send path applies", () => {
    expect(spendsArkadeBalance({ engine: "btc-to-stable" })).toBe(true);
  });

  it("holds nothing for a move that spends no bitcoin", () => {
    expect(spendsArkadeBalance({ engine: "stable-to-btc" })).toBe(false);
    expect(spendsArkadeBalance({ engine: "direct-evm" })).toBe(false);
  });
});

describe("walletCreditForMove", () => {
  const base = { engine: "btc-to-stable", receiveAmount: 15.8, to: "EURC_BASE" } as const;

  it("credits the wallet for a bitcoin move into the wallet", () => {
    expect(walletCreditForMove(base)).toEqual({ amount: 15.8, asset: "EURC_BASE" });
  });

  it("never credits the wallet for a card-bound move", () => {
    expect(walletCreditForMove({ ...base, destination: "card" })).toBeNull();
  });

  it("credits nothing for an engine that spends no bitcoin", () => {
    expect(walletCreditForMove({ ...base, engine: "direct-evm" as never })).toBeNull();
  });
});
