// A failed move's support report, for the failure details sheet (#1932).
//
// The pill keeps what the failed attempt threw or returned. Reporting it from
// the sheet sends that same attempt's context in the silent report only: the
// visible chat never carries its text (#1383), and the sheet itself shows where
// the report got to. Nothing here retries, signs or changes the move.
import { errDescription } from "../../lib/errorMessage";
import { reportErrorToSupport } from "../../lib/support/reportErrorToSupport";
import {
  UNLOCK_HELP_MESSAGE,
  isUnlockResult,
  unlockFailureReportError,
} from "../arkade/ArkadeUnlockSupportService";

const MOVE_HELP_MESSAGE = "My move failed, please help!";

export type MoveFailureAttempt = {
  /** What the attempt threw or returned; undefined when nothing said why. */
  error: unknown;
  at: number;
  /** The value the report is tracked by: the error itself when it is an
   * object (so an automatic report of it counts), otherwise one made once for
   * this attempt, so a retry is the same report and not a new one. */
  subject: object;
};

export function moveFailureAttempt(failure: { error: unknown; at: number }): MoveFailureAttempt {
  const { error, at } = failure;
  const subject =
    error !== null && typeof error === "object"
      ? error
      : new Error(
          typeof error === "string" && error
            ? `Move failed: ${error}`
            : "Move failed, no error was recorded",
        );
  return { error, at, subject };
}

/**
 * What the screen may show of a failure: its class and code, never its message
 * (#1383). null when nothing was recorded; "" when something was, but nothing
 * of it is fit for the screen (a returned result, a string).
 */
export function moveFailureReference(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  if (!(error instanceof Error)) return "";
  const { errClass, errCode } = errDescription(error);
  return errCode ? `${errClass} (${errCode})` : errClass;
}

/** Send the attempt's report. The sheet follows it through supportReportState(attempt.subject). */
export function sendMoveFailureReport(attempt: MoveFailureAttempt): Promise<void> {
  const unlock = isUnlockResult(attempt.subject);
  return reportErrorToSupport({
    // A failed unlock run carries its context in errors, logs and state, not a
    // message: the same formatting its automatic report uses.
    error: unlock ? unlockFailureReportError(attempt.subject) : attempt.subject,
    subject: attempt.subject,
    userMessage: unlock ? UNLOCK_HELP_MESSAGE : MOVE_HELP_MESSAGE,
    openChat: false,
  }).catch(() => {});
}
