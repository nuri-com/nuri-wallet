// Invites put both people in each other's address book: the user who invited
// them, and every user they invited, saved as Nuri contacts by
// `rememberNuriUser` (a contact already saved, or one the user removed, is left
// alone). Fed by every live account status read, which carries both.
import { resolvePayRecipient } from "../../lib/pay/resolvePayRecipient";
import { rememberNuriUser } from "../addressBook/nuriContactSync";
import type { ArkadeLnurlStatus } from "../arkade/types/lnurl";

/** The usernames an account status says belong in the book, own name excluded. */
export function inviteContactNames(status: ArkadeLnurlStatus): string[] {
  const own = (status.username ?? "").trim().toLowerCase();
  const names = [status.invitedBy, ...status.invitees.map((row) => row.username)]
    .map((name) => (name ?? "").trim().toLowerCase())
    .filter((name) => name && name !== own);
  return [...new Set(names)];
}

// One lookup at a time: the username resolver's gateway answers HTTP 500 to a
// few concurrent reads, and a failed name must not stop the rest.
export function syncInviteContacts(status: ArkadeLnurlStatus, stillCurrent: () => boolean): void {
  if (!status.registered) return;
  const names = inviteContactNames(status);
  void (async (): Promise<void> => {
    for (const name of names) {
      if (!stillCurrent()) return;
      await rememberNuriUser(name, resolvePayRecipient, stillCurrent).catch(() => {});
    }
  })();
}
