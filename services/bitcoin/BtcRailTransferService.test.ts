// Regression coverage for the bitcoin rail↔rail transfer orchestration.
//
// The two rails are one asset, so the move is a plain offboard/onboard — but
// each direction carries bookkeeping that must not be dropped:
//   arkade → on-chain  arms the arkade outgoing-balance hold before dispatch
//                      and clears/reverts it, or a collaborative-exit change
//                      publishes a transient zero balance.
//   on-chain → arkade  reserves the miner fee before sending, so a max send
//                      fails up front instead of after the user confirms.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendArkadeBitcoinOnchain: vi.fn(),
  estimateOnchainSendFeeSats: vi.fn(),
  sendBitcoinOnchainFromMusig2: vi.fn(),
  holdArkadeOutgoingBalance: vi.fn(),
  clearArkadeOutgoingBalanceHold: vi.fn(),
  revertArkadeOutgoingBalance: vi.fn(),
  pendingAdd: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("../arkade/ArkadeSendService", () => ({
  sendArkadeBitcoinOnchain: mocks.sendArkadeBitcoinOnchain,
}));
vi.mock("./OnchainSendService", () => ({
  estimateOnchainSendFeeSats: mocks.estimateOnchainSendFeeSats,
  sendBitcoinOnchainFromMusig2: mocks.sendBitcoinOnchainFromMusig2,
}));
vi.mock("./BitcoinBalanceStore", () => ({
  bitcoinBalanceStore: {
    holdArkadeOutgoingBalance: mocks.holdArkadeOutgoingBalance,
    clearArkadeOutgoingBalanceHold: mocks.clearArkadeOutgoingBalanceHold,
    revertArkadeOutgoingBalance: mocks.revertArkadeOutgoingBalance,
  },
}));
vi.mock("./PendingBitcoinSendsStore", () => ({
  PendingBitcoinSendsStore: { add: mocks.pendingAdd },
}));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: mocks.emit },
}));

import {
  boardOnchainToArkade,
  getOnchainToArkadeTransferableSats,
  offboardArkadeToOnchain,
} from "./BtcRailTransferService";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendArkadeBitcoinOnchain.mockResolvedValue({ txid: "ark-txid", offboardSats: 5300 });
  mocks.estimateOnchainSendFeeSats.mockResolvedValue(200);
  mocks.sendBitcoinOnchainFromMusig2.mockResolvedValue({
    txid: "onchain-txid",
    sats: 1000,
    feeSats: 200,
  });
  mocks.pendingAdd.mockResolvedValue(undefined);
});

describe("on-chain → arkade transferable balance", () => {
  it("subtracts the current miner fee from the displayed spendable balance", async () => {
    await expect(getOnchainToArkadeTransferableSats(10_000)).resolves.toBe(9_800);
    expect(mocks.estimateOnchainSendFeeSats).toHaveBeenCalledOnce();
  });

  it("never exposes a negative transferable balance", async () => {
    await expect(getOnchainToArkadeTransferableSats(100)).resolves.toBe(0);
  });
});

describe("offboardArkadeToOnchain (arkade → on-chain)", () => {
  it("sends to the on-chain address and records an arkade-source pending send", async () => {
    const result = await offboardArkadeToOnchain({ toAddress: "bc1q...", amountSats: 5000 });

    expect(mocks.sendArkadeBitcoinOnchain).toHaveBeenCalledWith({
      address: "bc1q...",
      amountSats: 5000,
    });
    expect(mocks.pendingAdd).toHaveBeenCalledWith(
      expect.objectContaining({ txid: "ark-txid", amountSats: 5000, source: "arkade" }),
    );
    expect(mocks.emit).toHaveBeenCalledWith("bitcoin:refresh");
    expect(result.txid).toBe("ark-txid");
  });

  it("arms the hold before dispatch, re-arms with the gross debit, and clears on success", async () => {
    await offboardArkadeToOnchain({ toAddress: "bc1q...", amountSats: 5000 });

    expect(mocks.holdArkadeOutgoingBalance).toHaveBeenCalledWith("btc_rail_offboard", 5000);
    // The offboard grosses the receiver amount up with the output fee (5300);
    // the anchor must be re-armed with that, not the receiver amount.
    expect(mocks.holdArkadeOutgoingBalance).toHaveBeenCalledWith("btc_rail_offboard_gross", 5300);
    expect(mocks.clearArkadeOutgoingBalanceHold).toHaveBeenCalled();
    expect(mocks.revertArkadeOutgoingBalance).not.toHaveBeenCalled();
  });

  it("reverts the hold when the offboard fails", async () => {
    mocks.sendArkadeBitcoinOnchain.mockRejectedValue(new Error("arkade_offboard_failed"));

    await expect(
      offboardArkadeToOnchain({ toAddress: "bc1q...", amountSats: 5000 }),
    ).rejects.toThrow();

    expect(mocks.revertArkadeOutgoingBalance).toHaveBeenCalled();
    expect(mocks.pendingAdd).not.toHaveBeenCalled();
  });
});

describe("boardOnchainToArkade (on-chain → arkade)", () => {
  it("sends the MuSig2 on-chain transaction to the boarding address and records an onchain-source pending send", async () => {
    const result = await boardOnchainToArkade({
      toAddress: "bc1qboarding...",
      amountSats: 5000,
      onchainSpendableSats: 10_000,
    });

    expect(mocks.sendBitcoinOnchainFromMusig2).toHaveBeenCalledWith({
      toAddress: "bc1qboarding...",
      amountSats: 5000,
    });
    expect(mocks.pendingAdd).toHaveBeenCalledWith(
      expect.objectContaining({ txid: "onchain-txid", amountSats: 5000, source: "onchain" }),
    );
    expect(mocks.emit).toHaveBeenCalledWith("bitcoin:refresh");
    expect(result.txid).toBe("onchain-txid");
  });

  it("rejects before sending when the amount plus miner fee exceeds the on-chain spendable balance", async () => {
    await expect(
      boardOnchainToArkade({
        toAddress: "bc1qboarding...",
        amountSats: 5000,
        onchainSpendableSats: 5100,
      }),
    ).rejects.toThrow(/after fees/);

    expect(mocks.sendBitcoinOnchainFromMusig2).not.toHaveBeenCalled();
    expect(mocks.pendingAdd).not.toHaveBeenCalled();
  });

  it("never touches the arkade hold — onboarding spends the on-chain rail", async () => {
    await boardOnchainToArkade({
      toAddress: "bc1qboarding...",
      amountSats: 5000,
      onchainSpendableSats: 10_000,
    });

    expect(mocks.holdArkadeOutgoingBalance).not.toHaveBeenCalled();
  });
});
