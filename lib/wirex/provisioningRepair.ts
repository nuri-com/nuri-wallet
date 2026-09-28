// lib/wirex/provisioningRepair.ts
// Pure decision logic for the provisioning repair (#1090): which Wirex products
// an account is entitled to but does not have. Kept out of the service so it can
// be tested without network or Keychain.
//
// Card and IBAN are provisioned independently by separate Wirex rails and their
// capabilities flip on at different times, so each is judged on its own: holding
// a card says nothing about whether the IBAN is due, and vice versa.

// A per-rail capability as Wirex returns it (getUserV2 / onboarding summary).
// `type` names the rail ("VisaVirtualCard", "SepaAccount"); `status` is the rail
// state ("Active", "NotAvailable", "NotFulfilled"). Everything else is metadata.
export interface WirexCapabilityLike {
  type?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

export const WIREX_CARD_CAPABILITY = "visavirtualcard";
export const WIREX_SEPA_CAPABILITY = "sepaaccount";

const normalize = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * Status of one rail, lowercased, or null when the account carries no entry for
 * it. Absent is NOT the same as inactive: an account that has never reached the
 * rail simply has nothing to report yet.
 */
export function capabilityStatus(
  capabilities: readonly WirexCapabilityLike[] | null | undefined,
  type: string,
): string | null {
  if (!capabilities) return null;
  const wanted = normalize(type);
  for (const capability of capabilities) {
    if (normalize(capability?.type) === wanted) return normalize(capability?.status) || null;
  }
  return null;
}

export function isCapabilityActive(
  capabilities: readonly WirexCapabilityLike[] | null | undefined,
  type: string,
): boolean {
  return capabilityStatus(capabilities, type) === "active";
}

export interface ProvisioningRepairInput {
  capabilities: readonly WirexCapabilityLike[] | null | undefined;
  // The user route reports the card rail twice: in the capability list, and in a
  // dedicated `visa_virtual_card` field that can carry it when the list does
  // not. Consulted only when the list has no entry for the rail — a list that
  // names it is the more specific answer.
  visaVirtualCard?: WirexCapabilityLike | null;
  hasUsableCard: boolean;
  hasIban: boolean;
  // Every card the account has is closed. That is the account deliberately
  // having no card, so the rail is not "missing" and must not be re-provisioned
  // — a repair here would mint a card the user closed on purpose. Only a
  // never-provisioned account (no cards at all) is due.
  allCardsClosed: boolean;
}

export interface ProvisioningRepairDecision {
  cardDue: boolean;
  ibanDue: boolean;
  due: boolean;
}

/**
 * Entitled but missing, per rail. A capability that is not Active is not
 * "settled" — Wirex enables e.g. SepaAccount per country long after KYC — so it
 * is simply not due yet and gets re-checked on a later launch.
 */
export function decideProvisioningRepair(
  input: ProvisioningRepairInput,
): ProvisioningRepairDecision {
  const listedCardStatus = capabilityStatus(input.capabilities, WIREX_CARD_CAPABILITY);
  const cardStatus = listedCardStatus ?? (normalize(input.visaVirtualCard?.status) || null);
  const cardDue = cardStatus === "active" && !input.hasUsableCard && !input.allCardsClosed;
  const ibanDue = isCapabilityActive(input.capabilities, WIREX_SEPA_CAPABILITY) && !input.hasIban;
  return { cardDue, ibanDue, due: cardDue || ibanDue };
}

/**
 * The account identity the retrigger needs, read out of the raw user payload the
 * user route returns. `country` drives which rails the server provisions, so a
 * wrong one provisions the wrong thing — it is returned as null when absent and
 * the caller omits the parameter rather than substituting a default.
 *
 * Accepts the response either way round: the route nests the Wirex user under
 * `user`, and the same fields sit at the top level of the user object itself.
 */
export function readAccountIdentity(raw: unknown): {
  email: string | null;
  country: string | null;
} {
  const payload = (raw ?? {}) as Record<string, unknown>;
  const user = (payload.user ?? payload) as Record<string, unknown>;
  const profile = (user.profile ?? {}) as Record<string, unknown>;
  const residence = (user.residence_address ?? user.residenceAddress ?? {}) as Record<
    string,
    unknown
  >;
  const email = typeof profile.email === "string" ? profile.email.trim() : "";
  const country = typeof residence.country === "string" ? residence.country.trim() : "";
  return { email: email || null, country: country || null };
}
