// Stage timings for one outgoing Lightning payment (#1514): how long each
// step from the confirm tap to the funded lockup took, and the last step it
// reached when it stopped. One line per attempt, so a slow or missing passkey
// prompt in a support dump can be told apart: still preparing/quoting, waiting
// on the record or server intent, arming the approval and the funding guards,
// inside wallet.send (passkey + signing + submit), or waiting on funding
// evidence after the broadcast.
//
// Diagnostics only: it never throws, never awaits and never changes what the
// payment does or in which order.
import { isUserCancelledAuth } from "../../../lib/support/isUserCancelledAuth";

/** Steps in the order a payment reaches them. */
export const LN_PAY_PHASES = [
  "lnurl_resolved",
  "prepared",
  "quoted",
  "recorded",
  "approval_started",
  "signing",
  "broadcast",
  "funded",
] as const;

export type LnPayPhase = (typeof LN_PAY_PHASES)[number];

export type LnPayOutcome = "funded" | "cancelled" | "in_progress" | "failed";

export type LnPayPhaseTimer = {
  /** First arrival at a step counts; later calls for the same step are ignored.
   * `resumed` says the step was reached by an earlier attempt (a broadcast
   * recovered on resume); the line then carries `resumed=1`. */
  mark(phase: LnPayPhase, opts?: { resumed?: boolean }): void;
  /** Log fields: outcome, total_ms, last_phase and `<phase>_ms` per reached step,
   * each the time since the step before it (or since the start). Once funded,
   * total_ms ends at the funded step and after_funded_ms holds the rest. */
  fields(outcome: LnPayOutcome): Record<string, string | number>;
};

export function createLnPayPhaseTimer(now: () => number = Date.now): LnPayPhaseTimer {
  const startedAt = now();
  const reached = new Map<LnPayPhase, number>();
  let resumed = false;
  return {
    mark(phase, opts) {
      if (reached.has(phase)) return;
      reached.set(phase, now());
      if (opts?.resumed) resumed = true;
    },
    fields(outcome) {
      const out: Record<string, string | number> = { outcome };
      if (resumed) out.resumed = 1;
      let previous = startedAt;
      let last = "start";
      for (const phase of LN_PAY_PHASES) {
        const at = reached.get(phase);
        if (at === undefined) continue;
        out[`${phase}_ms`] = Math.max(0, at - previous);
        previous = at;
        last = phase;
      }
      out.last_phase = last;
      // Tap to funded ends at the funded milestone; bookkeeping after it
      // (funding record write, tracking) gets its own field so the total
      // never holds time no step explains.
      const fundedAt = reached.get("funded");
      const endedAt = now();
      if (fundedAt !== undefined) {
        out.after_funded_ms = Math.max(0, endedAt - fundedAt);
        out.total_ms = Math.max(0, fundedAt - startedAt);
      } else {
        out.total_ms = Math.max(0, endedAt - startedAt);
      }
      return out;
    },
  };
}

/** The timing line as logged: `ln_pay_phase_timing key=value ...` in field
 * order. Values are step names and integers, so no quoting is needed. */
export function formatLnPayPhaseTiming(fields: Record<string, string | number>): string {
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, "_")}`)
    .join(" ");
  return `ln_pay_phase_timing ${detail}`.trim();
}

/** How an attempt ended, for the timing line only. */
export function classifyLnPayOutcome(error: unknown): LnPayOutcome {
  if (isUserCancelledAuth(error)) return "cancelled";
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (name === "ArkadeLightningPaymentInProgressError") return "in_progress";
  // The same per-order loop guard before it had its own error type (#2004).
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (message === "This Lightning payment is already in progress.") return "in_progress";
  // Another outgoing approval holds the signer (web browserApproval, native
  // ArkadeRemoteIdentity): the attempt was refused, not failed.
  if (
    message === "outgoing send approval already in progress" ||
    message === "outgoing spend approval already in progress"
  ) {
    return "in_progress";
  }
  return "failed";
}
