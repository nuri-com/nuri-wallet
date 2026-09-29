// Single source for the wallet's account email. It is entered during Wirex
// onboarding and pinned per wallet; WirexService owns the write + mismatch
// guard, this exposes a read so other features (the Arkade LNURL profile sync)
// can pick it up without importing WirexService. Keep the key in lockstep with
// WirexService.
import { getAuthData } from "./secureKeyStorage";

export const ACCOUNT_EMAIL_KEY = "@wirex:onboard_email";

export function accountEmailKeyFor(wallet: string): string {
  return `${ACCOUNT_EMAIL_KEY}:${wallet.toLowerCase()}`;
}

/** The pinned account email for this wallet, or null when none is stored. */
export async function getAccountEmail(wallet: string): Promise<string | null> {
  if (!wallet) return null;
  try {
    return (await getAuthData(accountEmailKeyFor(wallet)))?.trim() || null;
  } catch {
    return null;
  }
}
