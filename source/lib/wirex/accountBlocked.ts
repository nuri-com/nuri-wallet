// lib/wirex/accountBlocked.ts
// Pure decision logic for "is this Wirex account blocked?" (#1336). Kept out of
// the service so it can be tested without network or Keychain.
//
// A blocklisted account reads as healthy on the two fields the app used to trust:
// bank_accounts[].status stays "Active" (so the IBAN row renders) and
// verification_status stays "Approved" (historic KYC, never the account status).
// The authoritative signals are the Wirex profile's user_status (anything but
// "Active") and any bank-eligibility rail reporting the profile is not active.

export const WIREX_PROFILE_NOT_ACTIVE_REASON = "User profile is not active";

/** One bank-eligibility rail as the status response carries it. */
export interface WirexBankEligibility {
  type?: string | null;
  status?: string | null;
  status_reason?: string | null;
  [key: string]: unknown;
}

export interface WirexAccountBlockedInput {
  // The Wirex profile's user_status ("Active" | "Deleted" | "Blocked" | …).
  // Absent (backend not reporting it yet) is NOT a block — the only positive
  // user_status signal is a present value that is not "Active".
  userStatus?: string | null;
  bankEligibility?: readonly WirexBankEligibility[] | null;
}

export function isAccountBlocked(input: WirexAccountBlockedInput): boolean {
  const userStatus = (input.userStatus ?? "").trim();
  if (userStatus && userStatus !== "Active") return true;
  const eligibility = input.bankEligibility ?? [];
  for (const capability of eligibility) {
    if (capability?.status_reason === WIREX_PROFILE_NOT_ACTIVE_REASON) return true;
  }
  return false;
}

// A blocked account must not look like it can receive money or mint a card, and
// it must not start a card-secret reveal (a passkey signing) either. These gates
// are shared by every path that could, so the block is terminal everywhere.

/** Bank details the sheet may show: none for a blocked account. */
export function visibleBankDetails(
  isBlocked: boolean,
  iban: { iban?: string | null; bic?: string | null } | null | undefined,
): { iban: string | null; bic: string | null } {
  if (isBlocked) return { iban: null, bic: null };
  return { iban: iban?.iban ?? null, bic: iban?.bic ?? null };
}

/** Issue and close card are dropped for a blocked account. */
export function withoutBlockedCardActions<
  T extends { onIssueNewCard?: () => void; onCloseCard?: () => void },
>(props: T, isBlocked: boolean): T {
  if (!isBlocked) return props;
  return { ...props, onIssueNewCard: undefined, onCloseCard: undefined };
}

/** Whether the card's secrets may be fetched: never for a blocked account. */
export function mayRevealCardSecrets(
  isBlocked: boolean,
  cardId: string | null | undefined,
): boolean {
  return !isBlocked && Boolean(cardId);
}

/**
 * The page the details sheet shows. A block replaces every page, including a
 * close-card confirm or limit editor that was already open when it arrived.
 */
export function detailsSheetPage<P extends string>(page: P, isBlocked: boolean): P | "details" {
  return isBlocked ? "details" : page;
}
