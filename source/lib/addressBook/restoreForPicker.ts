// A recipient picker that opens on its own (e.g. Bank Transfer, #1997) must
// not depend on the user first visiting Settings → Address book to pull the
// contacts from the relays. This shows the local copy at once, then runs one
// relay sync and reports whether the result is confirmed or only this
// device's copy, so "no saved recipients" is never shown while a read is
// still running or after it failed.
import type { AddressBook } from "./AddressBook";
import type { Contact } from "./contact";

/**
 * - `loading`: nothing read yet.
 * - `syncing`: local copy shown, relay read running.
 * - `ready`: at least one relay answered completely; the list is confirmed.
 * - `offline`: no relay answered completely (or the book could not be read);
 *   the list is this device's copy only and may be missing contacts.
 */
export type PickerRestoreStatus = "loading" | "syncing" | "ready" | "offline";

type Book = Pick<AddressBook, "current" | "sync">;

/**
 * Show the local contacts, then sync once and show the result. `show` gets
 * every step; `cancelled` stops updates once the picker closed (or the
 * wallet changed). Never throws; cached contacts survive a failed sync.
 */
export async function restoreForPicker(
  book: Book,
  show: (contacts: Contact[], status: PickerRestoreStatus) => void,
  cancelled: () => boolean = () => false,
): Promise<void> {
  let local: Contact[] = [];
  try {
    local = await book.current();
  } catch {
    if (!cancelled()) show([], "offline");
    return;
  }
  if (cancelled()) return;
  show(local, "syncing");
  let confirmed = false;
  try {
    const report = await book.sync();
    confirmed = report.relays.some((relay) => relay.complete);
  } catch {}
  if (cancelled()) return;
  let after = local;
  try {
    after = await book.current();
  } catch {
    // Closed meanwhile (wallet switch): keep what was shown.
    confirmed = false;
  }
  if (cancelled()) return;
  show(after, confirmed ? "ready" : "offline");
}
