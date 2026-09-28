/**
 * Determines the display status of a card transaction event.
 */

const FAILED_STATUSES = [
  "IncorrectPin",
  "InsufficientFunds",
  "InvalidAmount",
  "PinEntryTriesExceeded",
  "IncorrectSecurityCode",
  "Other",
] as const;

type FailedStatus = (typeof FAILED_STATUSES)[number];

export type CardTransactionStatus = {
  isApproved: boolean;
  isRefund: boolean;
  isReversal: boolean;
  isPending: boolean;
  isFailed: boolean;
  failReason: FailedStatus | null;
  sign: "+" | "-";
};

export function getCardTransactionStatus(event: {
  kind?: string;
  status?: string;
  isPending?: boolean;
}): CardTransactionStatus {
  const { kind, status, isPending } = event;

  const isApproved = kind === "Payment" && status === "Approved";

  const isRefund =
    kind === "Refund" ||
    (kind === "Payment" && !!status && (status === "Reversal" || status === "PartialReversal"));

  const isReversal = kind === "Reversal";

  const pending = !!isPending;

  const isFailed =
    !isApproved &&
    !isRefund &&
    !isReversal &&
    kind === "Payment" &&
    !!status &&
    FAILED_STATUSES.includes(status as FailedStatus);

  const failReason = isFailed ? (status as FailedStatus) : null;

  const sign = kind === "Payment" && !isRefund ? "-" : "+";

  return { isApproved, isRefund, isReversal, isPending: pending, isFailed, failReason, sign };
}
