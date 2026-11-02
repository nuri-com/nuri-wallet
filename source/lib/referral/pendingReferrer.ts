import { deleteAuthData, getAuthData, storeAuthData } from "../secureKeyStorage";

// The inviter from an invite link, kept until this device claims a username.
// Sent with the claim; the server records it only for a new user, so a stale
// value on a device that already has an account does nothing.
export const PENDING_REFERRER_KEY = "pending_referrer";

// Every read and write of the slot runs one after another, in the order they
// were asked for. An invite accepted before a claim is therefore stored before
// that claim reads it, two invites cannot both see an empty slot, and a
// claim's cleanup cannot interleave with a later invite's write.
let tail: Promise<unknown> = Promise.resolve();
function serialized<T>(op: () => Promise<T>): Promise<T> {
  const run = tail.then(op, op);
  tail = run.catch(() => {});
  return run;
}

/** Keeps the first invite opened on this device; later links do not replace it. */
export function rememberReferrer(username: string): Promise<void> {
  return serialized(async () => {
    if (await getAuthData(PENDING_REFERRER_KEY)) return;
    await storeAuthData(PENDING_REFERRER_KEY, username);
  });
}

/** The invite to send with a claim, after every invite accepted before it is stored. */
export function getPendingReferrer(): Promise<string | null> {
  return serialized(async () => (await getAuthData(PENDING_REFERRER_KEY))?.trim() || null);
}

/**
 * After a successful claim: forget the invite that claim sent, and only that
 * one. A claim that sent none leaves the slot alone.
 */
export function consumePendingReferrer(sent: string | null): Promise<void> {
  return serialized(async () => {
    if (!sent) return;
    if ((await getAuthData(PENDING_REFERRER_KEY))?.trim() !== sent) return;
    await deleteAuthData(PENDING_REFERRER_KEY);
  });
}
