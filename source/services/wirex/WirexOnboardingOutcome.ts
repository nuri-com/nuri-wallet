export type LinklessOnboardClassification =
  | "approved_without_link"
  | "has_continuation"
  | "invalid";

export function classifyLinklessOnboardResult(params: {
  status?: string | null;
  kycUrl?: string | null;
  registerApprovalUrl?: string | null;
  registerSessionId?: string | null;
}): LinklessOnboardClassification {
  if (params.kycUrl) return "has_continuation";
  if (params.registerApprovalUrl || params.registerSessionId) {
    return params.registerApprovalUrl && params.registerSessionId ? "has_continuation" : "invalid";
  }
  return params.status?.trim().toLowerCase() === "approved" ? "approved_without_link" : "invalid";
}

export type ApprovedOnboardingNextStep = "complete" | "open_kyc";

export function nextStepAfterApprovedOnboarding(
  verificationStatus: string | null | undefined,
): ApprovedOnboardingNextStep {
  return verificationStatus?.trim().toLowerCase() === "approved" ? "complete" : "open_kyc";
}
