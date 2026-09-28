import { describe, expect, it } from "vitest";
import {
  shouldRevertOptimisticWithdraw,
  WIREX_WITHDRAW_UNCONFIRMED_ERROR_NAME,
} from "./withdrawRollback";

const unconfirmed = () => {
  const error = new Error("wirex withdrawal unconfirmed");
  error.name = WIREX_WITHDRAW_UNCONFIRMED_ERROR_NAME;
  return error;
};

describe("shouldRevertOptimisticWithdraw", () => {
  it("keeps both optimistic moves when the withdrawal is unconfirmed", () => {
    // It may still settle, and the wallet side is already credited — putting
    // the euros back on the card too would show the same money twice.
    expect(shouldRevertOptimisticWithdraw(unconfirmed())).toBe(false);
  });

  it("reverts a failure that went nowhere", () => {
    expect(shouldRevertOptimisticWithdraw(new Error("wirex_withdraw_failed"))).toBe(true);
  });

  it("reverts for anything unrecognisable", () => {
    expect(shouldRevertOptimisticWithdraw(null)).toBe(true);
    expect(shouldRevertOptimisticWithdraw("boom")).toBe(true);
    expect(shouldRevertOptimisticWithdraw({ name: 123 })).toBe(true);
  });
});
