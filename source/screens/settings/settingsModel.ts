// The Settings screen's decisions, kept out of the component so they can be
// tested without a renderer. Nothing here touches UI or a service.
import { canResumeWirexKyc } from "../../lib/wirex/kycPermalink";

type WirexVerificationInput = {
  loading: boolean;
  isApproved: boolean;
  isRejected: boolean;
  verificationStatus: string;
  /** Card, balance and smart account are in — the account is usable. */
  cardReady: boolean;
  /** Approved and every card closed: usable, nothing left to verify. */
  awaitingReplacementCard: boolean;
};

/**
 * What activating the Wirex account still needs — the ONE rule behind both the
 * home's inactive VISA/IBAN rows and the Settings verification row.
 *
 *   ready   nothing: the account is usable.
 *   resume  an account exists and is still in verification, or was approved but
 *           its products never provisioned. Restarting signup would ask for an
 *           email that is already pinned server-side, so the permalink resumes.
 *   start   no account yet: signup begins with the email step.
 */
export function wirexActivationStep(input: WirexVerificationInput): "ready" | "resume" | "start" {
  if (input.cardReady || input.awaitingReplacementCard) return "ready";
  const pending =
    canResumeWirexKyc(input.verificationStatus, input.isApproved, input.isRejected) ||
    input.isApproved;
  return pending ? "resume" : "start";
}

export type VerificationRowState =
  | "checking"
  | "none"
  | "inReview"
  | "finishing"
  | "verified"
  | "rejected";

/** The Settings verification row: the status it states and what a tap does. */
export function verificationRow(input: WirexVerificationInput): {
  state: VerificationRowState;
  action: "start" | "resume" | null;
} {
  const step = wirexActivationStep(input);
  if (step === "ready") return { state: "verified", action: null };
  // Final: signing up again cannot change a rejection.
  if (input.isRejected) return { state: "rejected", action: null };
  if (step === "resume") {
    return { state: input.isApproved ? "finishing" : "inReview", action: "resume" };
  }
  // Nothing read yet: starting a signup for an account that may already exist
  // would ask for an email it has pinned, so wait for the first read.
  if (input.loading && String(input.verificationStatus || "").toLowerCase() === "unknown") {
    return { state: "checking", action: null };
  }
  return { state: "none", action: "start" };
}
