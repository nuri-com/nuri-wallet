import { describe, expect, it } from "vitest";
import type { ArkadeWalletSummary } from "../arkade/types/wallet";
import { balanceFromArkadeSummary } from "./balanceShape";

describe("balanceFromArkadeSummary", () => {
  it("headline equals the off-chain send gate: available + tooFresh", () => {
    const balance = balanceFromArkadeSummary({
      balanceAvailableSats: "12000",
      balanceSettledSats: "7000",
      balanceTooFreshSats: "1500",
      balancePreconfirmedSats: "5000",
      balanceBoardingConfirmedSats: "2999",
      balanceBoardingUnconfirmedSats: "1000",
      balanceRecoverableSats: "333",
    } as ArkadeWalletSummary);

    // Headline ≡ off-chain send gate: settled + tooFresh + preconfirmed all
    // fund an offchain send (BitcoinSendScreen `spendable` sums exactly
    // these). tooFresh is spendable offchain, only barred from on-chain
    // settlement inputs — the on-chain settleable cap stays separate there.
    expect(balance.total).toBe(13_500);
    expect(balance.byChannel.arkade).toBe(13_500);
    expect(balance.detail.arkade).toEqual({
      boardingConfirmed: 2_999,
      boardingUnconfirmed: 1_000,
      recoverable: 333,
    });
  });

  it("a wallet with only too-fresh VTXOs shows them off-chain spendable", () => {
    const balance = balanceFromArkadeSummary({
      balanceSettledSats: "0",
      balanceTooFreshSats: "1500",
      balancePreconfirmedSats: "0",
      balanceBoardingConfirmedSats: "0",
      balanceBoardingUnconfirmedSats: "0",
      balanceRecoverableSats: "0",
    } as ArkadeWalletSummary);

    // Regression for the review P1: a wallet holding only VTXOs inside the
    // settlement min-expiry gap can still send them offchain — the headline
    // must not show 0. The on-chain settleable cap remains the send screen's
    // own concern.
    expect(balance.total).toBe(1_500);
  });

  // Boarding sats are on-chain until they are swept, and recoverable ones need
  // a recovery action first. Neither funds a send, so neither is the balance.
  it("leaves boarding and recoverable sats out of the spendable figure", () => {
    const balance = balanceFromArkadeSummary({
      balanceSettledSats: "0",
      balanceTooFreshSats: "0",
      balancePreconfirmedSats: "0",
      balanceBoardingConfirmedSats: "50000",
      balanceBoardingUnconfirmedSats: "0",
      balanceRecoverableSats: "9000",
    } as ArkadeWalletSummary);

    expect(balance.total).toBe(0);
  });
});
