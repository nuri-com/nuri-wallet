// When a failed Payment Received unlock goes to support (#1815).
//
// The screen used to wait for three failures, cancels included, before opening
// the support chat. Two things went wrong with that:
//   · a boarding sweep closes the screen as soon as its passkey approval is
//     done, and the settlement runs on behind the pill. A failure after that
//     point counted as one stumble, and the next open of the screen reset the
//     count, so a genuine failure never reached support;
//   · a deliberate cancel of the passkey prompt counted too, so three cancels
//     opened the chat with a payment-failure message.
import { isUserCancelledAuth } from "./isUserCancelledAuth";

/** Failures on the open screen before support is pulled in. */
export const SUPPORT_AFTER_FAILURES = 3;

/** Progress phases after which the unlock screen closes and the run goes on behind the pill. */
export function closesUnlockScreen(
  phase: string | null | undefined,
  usesReceiveClaimPasskey: boolean,
): boolean {
  if (phase === "sweep_approved") return true;
  return usesReceiveClaimPasskey && (phase === "claim_signed" || phase === "claim_waiting");
}

/**
 * True when the failure is the user declining the passkey prompt. A failed run
 * counts only when every error it collected is a cancel: one real error next to
 * a cancel is still a real failure.
 */
export function isCancelledUnlockFailure(failure: unknown): boolean {
  if (failure !== null && typeof failure === "object" && "errors" in failure) {
    const errors = (failure as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      const texts = errors.filter((entry): entry is string => typeof entry === "string");
      return texts.length > 0 && texts.every((entry) => isUserCancelledAuth(entry));
    }
  }
  return isUserCancelledAuth(failure);
}

/**
 * What one failed attempt does: whether it is reported now, and the failure
 * count the screen keeps afterwards.
 */
export function nextUnlockFailureStep(opts: {
  failure: unknown;
  failuresSoFar: number;
  /** The screen already closed for this run (approval done), so there is no retry to count. */
  closedEarly: boolean;
}): { report: boolean; failures: number } {
  if (isCancelledUnlockFailure(opts.failure)) {
    return { report: false, failures: opts.failuresSoFar };
  }
  if (opts.closedEarly) return { report: true, failures: 0 };
  const failures = opts.failuresSoFar + 1;
  if (failures >= SUPPORT_AFTER_FAILURES) return { report: true, failures: 0 };
  return { report: false, failures };
}

/**
 * What a finished run means for the screen. Failure and closing are separate
 * answers: the service closes the screen when no work is left, which says
 * nothing about whether this run failed, so a failed run that closes the screen
 * is still reported, and at once (there is no screen left to retry on).
 */
export function unlockRunOutcome(
  result: { ok: boolean; shouldCloseModal: boolean },
  closedEarly: boolean,
): { failed: boolean; closedEarly: boolean; close: boolean } {
  return {
    failed: !result.ok,
    closedEarly: closedEarly || result.shouldCloseModal,
    close: result.shouldCloseModal,
  };
}
