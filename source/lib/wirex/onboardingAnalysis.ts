import { asObject, asArray, asString, asNumber } from "./debugHelpers";

export const isExpectedStepIssue = (
  name: string,
  note: string,
  status: number,
  payload: Record<string, unknown> | null,
): boolean => {
  const errorDescription = asString(payload?.error_description).toLowerCase();
  if (name === "create_user" && note === "already_exists") return true;
  if (name === "kyc_link" && status === 400 && errorDescription.includes("already verified"))
    return true;
  if (name === "kyc_token" && status === 400 && errorDescription.includes("already verified"))
    return true;
  if (name === "activate_bank_sepa" && status === 400) return true;
  if (name === "sandbox_activate_ach_customer") return true;
  return false;
};

export const isStepHealthy = (step: Record<string, unknown>): boolean => {
  const ok = step.ok === true;
  const note = asString(step.note);
  const name = asString(step.name);
  const status = asNumber(step.status) || 0;
  const payload = asObject(step.payload);
  if (ok) return true;
  if (
    note === "already_exists" ||
    note === "accepted" ||
    note === "skipped_existing_card" ||
    note === "retrying"
  )
    return true;
  return isExpectedStepIssue(name, note, status, payload);
};

export const hasActiveSepa = (accounts: Record<string, unknown>[]): boolean =>
  accounts.some((entry) => {
    const accountType = asString(entry.account_type).toLowerCase();
    const status = asString(entry.status).toLowerCase();
    return accountType === "sepa" && status === "active";
  });

export const hasActiveCard = (cards: Record<string, unknown>[]): boolean =>
  cards.some((entry) => asString(entry.status).toLowerCase() === "active");

export const getKycSdkTokenFromPayload = (
  payload: Record<string, unknown> | null,
): string | null => {
  const steps = asArray(payload?.steps);
  for (const entry of steps) {
    const step = asObject(entry);
    if (asString(step?.name) !== "kyc_token") continue;
    const token = asString(asObject(step?.payload)?.token).trim();
    if (token) return token;
  }
  return null;
};

export const hasOnboardingStep = (
  payload: Record<string, unknown> | null,
  name: string,
  note?: string,
): boolean => {
  const steps = asArray(payload?.steps);
  return steps.some((entry) => {
    const step = asObject(entry);
    if (!step) return false;
    if (asString(step.name) !== name) return false;
    if (note === undefined) return true;
    return asString(step.note) === note;
  });
};

export const needsOnDeviceAaBootstrap = (payload: Record<string, unknown> | null): boolean => {
  const errorCode = asString(payload?.error);
  if (errorCode === "aa_bootstrap_required_on_device") return true;
  if (hasOnboardingStep(payload, "aa_bootstrap_required_on_device")) return true;
  return hasOnboardingStep(payload, "create_user", "not_registered_onchain");
};
