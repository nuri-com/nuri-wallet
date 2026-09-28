import { describe, expect, it } from "vitest";
import { getCardTransactionStatus } from "./cardTransactionStatus";

describe("getCardTransactionStatus", () => {
  it.each([
    [
      "approved card payment",
      { kind: "Payment", status: "Approved" },
      {
        isApproved: true,
        isRefund: false,
        isReversal: false,
        isFailed: false,
        failReason: null,
        sign: "-",
      },
    ],
    [
      "refund event",
      { kind: "Refund", status: "Approved" },
      {
        isApproved: false,
        isRefund: true,
        isReversal: false,
        isFailed: false,
        failReason: null,
        sign: "+",
      },
    ],
    [
      "payment reversal",
      { kind: "Payment", status: "Reversal" },
      {
        isApproved: false,
        isRefund: true,
        isReversal: false,
        isFailed: false,
        failReason: null,
        sign: "+",
      },
    ],
    [
      "partial payment reversal",
      { kind: "Payment", status: "PartialReversal" },
      {
        isApproved: false,
        isRefund: true,
        isReversal: false,
        isFailed: false,
        failReason: null,
        sign: "+",
      },
    ],
    [
      "standalone reversal",
      { kind: "Reversal", status: "Approved" },
      {
        isApproved: false,
        isRefund: false,
        isReversal: true,
        isFailed: false,
        failReason: null,
        sign: "+",
      },
    ],
    [
      "failed payment",
      { kind: "Payment", status: "InsufficientFunds" },
      {
        isApproved: false,
        isRefund: false,
        isReversal: false,
        isFailed: true,
        failReason: "InsufficientFunds",
        sign: "-",
      },
    ],
  ] as const)("classifies %s", (_name, event, expected) => {
    expect(getCardTransactionStatus(event)).toMatchObject(expected);
  });

  it("preserves the pending flag independently from final status classification", () => {
    expect(
      getCardTransactionStatus({ kind: "Payment", status: "Approved", isPending: true }),
    ).toMatchObject({
      isApproved: true,
      isPending: true,
    });
  });
});
