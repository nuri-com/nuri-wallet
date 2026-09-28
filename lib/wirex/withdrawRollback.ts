// Whether a failed withdrawal should put the optimistic balances back.
//
// Once the execution approval is submitted the withdrawal may still settle, and
// the caller has already credited the wallet side. Reverting the card side
// there would show the same money on both — so an UNCONFIRMED outcome keeps
// both optimistic moves standing and lets the hold expire or the next live read
// settle it. Only a failure that is known to have gone nowhere rolls back.
//
// Kept in its own import-free module so it is unit-testable without pulling the
// (native-dependency-heavy) Wirex service into the test environment.

export const WIREX_WITHDRAW_UNCONFIRMED_ERROR_NAME = "WirexWithdrawUnconfirmedError";

export function shouldRevertOptimisticWithdraw(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return String(name ?? "") !== WIREX_WITHDRAW_UNCONFIRMED_ERROR_NAME;
}
