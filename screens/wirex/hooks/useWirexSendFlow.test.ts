import { beforeEach, describe, expect, it, vi } from "vitest";

// The hook's withdrawal handler is plain async logic behind useCallback; a
// pass-through React stub runs it without a renderer.
const mocks = vi.hoisted(() => ({
  withdrawToWallet: vi.fn(),
  applyOptimisticDebit: vi.fn(),
  applyOptimisticDebitIn: vi.fn(),
  revertOptimisticBalance: vi.fn(),
  silentRefresh: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: <T>(fn: T) => fn,
  useState: <T>(initial: T) => [initial, () => {}],
}));
vi.mock("../../../lib/OperationLogUtils", () => ({
  LOG_EMOJI: { card: "" },
  errorWithId: vi.fn(),
  logWithId: vi.fn(),
}));
vi.mock("../../../services/events/AppEventBusService", () => ({
  EventBus: { emit: mocks.emit },
}));
vi.mock("../../../services/wirex/WirexAccountService", () => ({
  wirexAccountService: {
    applyOptimisticDebit: mocks.applyOptimisticDebit,
    applyOptimisticDebitIn: mocks.applyOptimisticDebitIn,
    revertOptimisticBalance: mocks.revertOptimisticBalance,
    silentRefresh: mocks.silentRefresh,
  },
}));
vi.mock("../../../services/wirex/WirexService", () => ({
  wirexService: { withdrawToWallet: mocks.withdrawToWallet },
}));
vi.mock("../../../services/swapkit/SwapKitStableAssets", () => ({
  USDC_BASE_TOKEN: { asset: "USDC_BASE" },
}));

import { WIREX_WITHDRAW_UNCONFIRMED_ERROR_NAME } from "../../../lib/wirex/withdrawRollback";
import { useWirexSendFlow } from "./useWirexSendFlow";

type WithdrawOpts = { onRequestApproved?: () => void; onSubmitted?: () => void };

const creditEvents = () => mocks.emit.mock.calls.filter(([e]) => e === "wallet:optimisticCredit");
const revokeEvents = () =>
  mocks.emit.mock.calls.filter(([e]) => e === "wallet:revokeOptimisticCredit");

describe("useWirexSendFlow.handleWithdraw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyOptimisticDebit.mockReturnValue(7);
  });

  it("moves both balances at the request approval, before the execution approval", async () => {
    let debitedBeforeExecution = false;
    let creditedBeforeExecution = false;
    mocks.withdrawToWallet.mockImplementation(async (_amount: string, opts: WithdrawOpts) => {
      opts.onRequestApproved?.();
      // The execution approval is still ahead here (~15s in production).
      debitedBeforeExecution = mocks.applyOptimisticDebit.mock.calls.length === 1;
      creditedBeforeExecution = creditEvents().length === 1;
      opts.onSubmitted?.();
      return { ok: true, amount: "12.50", asset: "EURC" };
    });

    await useWirexSendFlow({ bankReady: true }).handleWithdraw("12.50");

    expect(debitedBeforeExecution).toBe(true);
    expect(creditedBeforeExecution).toBe(true);
    expect(mocks.applyOptimisticDebit).toHaveBeenCalledTimes(1);
    expect(mocks.applyOptimisticDebit).toHaveBeenCalledWith(12.5);
    expect(creditEvents()).toHaveLength(1);
    expect(creditEvents()[0][1]).toMatchObject({ amount: 12.5 });
    expect(mocks.revertOptimisticBalance).not.toHaveBeenCalled();
  });

  it("takes both sides back when the flow fails before the point of no return", async () => {
    mocks.withdrawToWallet.mockImplementation(async (_amount: string, opts: WithdrawOpts) => {
      opts.onRequestApproved?.();
      throw new Error("wirex_withdraw_execute_approval_invalid");
    });

    await expect(useWirexSendFlow({ bankReady: true }).handleWithdraw("12.50")).rejects.toThrow(
      "wirex_withdraw_execute_approval_invalid",
    );

    expect(mocks.revertOptimisticBalance).toHaveBeenCalledWith(7);
    const credited = creditEvents()[0][1] as { moveId: string };
    expect(revokeEvents()).toEqual([
      ["wallet:revokeOptimisticCredit", { moveId: credited.moveId }],
    ]);
  });

  it("keeps both sides when the outcome is unconfirmed after the point of no return", async () => {
    mocks.withdrawToWallet.mockImplementation(async (_amount: string, opts: WithdrawOpts) => {
      opts.onRequestApproved?.();
      const error = new Error("wirex_withdraw_unconfirmed");
      error.name = WIREX_WITHDRAW_UNCONFIRMED_ERROR_NAME;
      throw error;
    });

    await expect(useWirexSendFlow({ bankReady: true }).handleWithdraw("12.50")).rejects.toThrow(
      "wirex_withdraw_unconfirmed",
    );

    expect(mocks.revertOptimisticBalance).not.toHaveBeenCalled();
    expect(revokeEvents()).toHaveLength(0);
  });

  it("moves nothing when the flow fails before the request approval", async () => {
    mocks.withdrawToWallet.mockRejectedValue(new Error("wirex_withdraw_start_invalid"));

    await expect(useWirexSendFlow({ bankReady: true }).handleWithdraw("12.50")).rejects.toThrow(
      "wirex_withdraw_start_invalid",
    );

    expect(mocks.applyOptimisticDebit).not.toHaveBeenCalled();
    expect(creditEvents()).toHaveLength(0);
    // Nothing held, nothing to take back: a null handle is a no-op.
    expect(mocks.revertOptimisticBalance).toHaveBeenCalledWith(null);
  });
});
