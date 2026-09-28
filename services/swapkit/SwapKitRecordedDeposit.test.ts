import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SwapKitOrder } from "./SwapKitOrderStore";
import { hasRecordedSignedDeposit, settleRecordedDeposit } from "./SwapKitRecordedDeposit";

const TXID = "a".repeat(64);
const RAW = "0200000001deadbeef";

const recorded = (): SwapKitOrder => ({
  txId: "sk_psbt",
  destination: "card",
  settleTarget: "0x2222222222222222222222222222222222222222",
  expectedUsdc: 0,
  minEurc: 9.9,
  usdcBaseline: "0",
  stable: "EURC_BASE",
  sats: 1_000,
  createdAt: 1,
  attempts: 0,
  recovery: {
    status: "FUNDING",
    externallyFundedDeposit: true,
    depositTo: "bc1qdeposit",
    depositAmount: "1000",
    depositTxHash: TXID,
    depositRawTx: RAW,
  },
});

const deps = () => ({
  getTransactionStatus: vi.fn(),
  broadcastTransaction: vi.fn(),
  saveOrder: vi.fn(async () => {}),
  log: vi.fn(),
});

let d: ReturnType<typeof deps>;
beforeEach(() => {
  d = deps();
});

describe("a recorded deposit whose broadcast outcome is unknown", () => {
  it("is recognised only while it is in the funding state with its signed transaction", () => {
    expect(hasRecordedSignedDeposit(recorded())).toBe(true);
    const funded = recorded();
    funded.recovery = { ...funded.recovery, status: undefined };
    expect(hasRecordedSignedDeposit(funded)).toBe(false);
    const noRaw = recorded();
    noRaw.recovery = { ...noRaw.recovery, depositRawTx: undefined };
    expect(hasRecordedSignedDeposit(noRaw)).toBe(false);
  });

  it("becomes the funded order when the chain already has the transaction, without sending it", async () => {
    d.getTransactionStatus.mockResolvedValue({ confirmed: false });
    const funded = await settleRecordedDeposit(recorded(), d);

    expect(d.broadcastTransaction).not.toHaveBeenCalled();
    expect(funded?.recovery).toMatchObject({ depositTxHash: TXID, externallyFundedDeposit: true });
    expect(funded?.recovery?.status).toBeUndefined();
    expect(funded?.recovery?.depositRawTx).toBeUndefined();
    expect(d.saveOrder).toHaveBeenCalledWith(funded);
  });

  it("re-sends exactly the recorded transaction when the chain does not know it", async () => {
    d.getTransactionStatus.mockRejectedValue(new Error("Not Found"));
    d.broadcastTransaction.mockResolvedValue(TXID);
    const funded = await settleRecordedDeposit(recorded(), d);

    expect(d.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(d.broadcastTransaction).toHaveBeenCalledWith(RAW);
    expect(funded?.recovery?.status).toBeUndefined();
  });

  it("treats an 'already known' answer as the transaction being out there", async () => {
    d.getTransactionStatus.mockRejectedValue(new Error("Not Found"));
    d.broadcastTransaction.mockRejectedValue(new Error("Transaction already confirmed"));
    const funded = await settleRecordedDeposit(recorded(), d);
    expect(funded?.recovery?.status).toBeUndefined();
  });

  it("keeps the row as it is when nothing proves the transaction is out", async () => {
    d.getTransactionStatus.mockRejectedValue(new Error("Not Found"));
    d.broadcastTransaction.mockRejectedValue(new Error("network down"));
    const funded = await settleRecordedDeposit(recorded(), d);

    expect(funded).toBeNull();
    expect(d.saveOrder).not.toHaveBeenCalled();
  });

  it("does not adopt an answer naming another transaction", async () => {
    d.getTransactionStatus.mockRejectedValue(new Error("Not Found"));
    d.broadcastTransaction.mockResolvedValue("b".repeat(64));
    expect(await settleRecordedDeposit(recorded(), d)).toBeNull();
    expect(d.saveOrder).not.toHaveBeenCalled();
  });
});
