// The ASP only signs in the round that is currently running, and that round is
// gone the moment its nonce window closes. An unlock whose approval or signing
// outlasts the window fails with the session expired even though nothing about
// the request was wrong: the registration is not refused, it merely points at a
// round that no longer exists, so getting into a valid session means registering
// once more. The same goes for a registration no round ever picked up
// (roundWatchdog.ts), and for a round that failed because not every
// registration confirmed in time: either way Arkade dropped the registration,
// and only a new one gets into a round. A phone that missed its round's start
// gets exactly that failure (seen live, 13 Nov 2026).
//
// Those are the only failures this retries, and it retries once. A round can also
// end for reasons that have nothing to do with our registration (another
// participant's bad signature, liquidity), and retrying those only added
// registration attempts without changing the outcome. A refused
// registration is not retried here either: the inputs are in a round that is
// still running (see duplicatedIntent.ts), so an immediate retry is refused too.
import { isDuplicatedIntentError, isOrphanedIntentRegistrationRefusal } from "./duplicatedIntent";
import { ROUND_NOT_STARTED_MESSAGE } from "./roundWatchdog";

/**
 * Failures that mean our registration is no longer in any round.
 *
 * The ASP's signing session timed out collecting nonces, or it answered a nonce
 * or signature submission for a round it had already dropped (arkd v0.9.26 says
 * "for round" or "for batch" depending on where it notices), or no round picked
 * the registration up, or the round failed waiting for confirmations.
 */
const SESSION_EXPIRED_RES: RegExp[] = [
  /SIGNING_SESSION_TIMED_OUT/i,
  /signing session not found for (round|batch)/i,
  /not[ _]enough[ _]intent[ _]confirmations[ _]received/i,
];

/** One join attempt plus one re-registration into a valid session. */
export const BOARDING_SWEEP_JOIN_ATTEMPTS = 2;
/** Pause before re-registering; the join itself waits for the next round. */
export const BOARDING_SWEEP_JOIN_RETRY_DELAY_MS = 2_000;

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    return `${error.message} ${causeText}`.trim();
  }
  return String(error);
}

/**
 * Did the session expire under this attempt?
 *
 * A refusal to register is never one of them, however it arrives: it means the
 * inputs are held, which a retry cannot change.
 */
export function isSessionExpiredFailure(error: unknown): boolean {
  if (!error) return false;
  if (isDuplicatedIntentError(error)) return false;
  if (isOrphanedIntentRegistrationRefusal(error)) return false;
  const text = errorText(error);
  if (!text) return false;
  if (text.includes(ROUND_NOT_STARTED_MESSAGE)) return true;
  return SESSION_EXPIRED_RES.some((pattern) => pattern.test(text));
}

export type SessionExpiryRetryOptions = {
  attempts?: number;
  delayMs?: number;
  /** Called before the re-registration, so the log shows why it happened. */
  onRetry?: (attempt: number, error: unknown) => void;
};

/**
 * Run a round-bound call, registering once more only when the session expired
 * under it. Any other failure is thrown as it is.
 */
export async function retryExpiredSession<T>(
  run: () => Promise<T>,
  options: SessionExpiryRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? BOARDING_SWEEP_JOIN_ATTEMPTS);
  const delayMs = Math.max(0, options.delayMs ?? BOARDING_SWEEP_JOIN_RETRY_DELAY_MS);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= attempts || !isSessionExpiredFailure(error)) throw error;
      options.onRetry?.(attempt, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
