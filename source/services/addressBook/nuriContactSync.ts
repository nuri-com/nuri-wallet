// Wires lib/addressBook/nuriContacts to the signed-in wallet's book (#1770).
//
// `rememberNuriPayment` is called once a payment with a known Nuri user is
// seen: a send to a username, or an activity row the server names. Writes run
// one at a time, so two rows of the same user never make two contacts. Open
// screens see the change through the book's own subscription.
//
// A Nuri contact the user deletes stays deleted: its username is kept in a
// small dismissed list (keychain, wiped with the book) and not added again.
import type { Contact, Destination } from "../../lib/addressBook/contact";
import { nuriContactWrite } from "../../lib/addressBook/nuriContacts";
import { NOSTR_ADDRESS_BOOK_DISMISSED_KEY } from "../../lib/nostr/storage";
import { getAuthData, storeAuthData } from "../../lib/secureKeyStorage";
import { getAddressBook } from "./AddressBookService";

const MAX_DISMISSED = 500;

let queue: Promise<void> = Promise.resolve();

function serial(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return queue;
}

async function loadDismissed(): Promise<string[]> {
  try {
    const raw = await getAuthData(NOSTR_ADDRESS_BOOK_DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Save (or extend) the contact of Nuri user `username`, paid at `seen`
 * (newest first; see nuriContactWrite).
 */
export function rememberNuriPayment(username: string, seen: Destination[]): Promise<void> {
  return serial(async () => {
    const book = await getAddressBook();
    const contacts = await book.current();
    const write = nuriContactWrite(contacts, username, seen, new Set(await loadDismissed()));
    if (!write) return;
    if (write.kind === "add") await book.add(write.input);
    else await book.update(write.id, write.input);
  });
}

/** The user removed this Nuri contact: do not add it back by itself. */
export function dismissNuriContact(contact: Contact): Promise<void> {
  const name = contact.nuriUsername;
  if (!name) return Promise.resolve();
  return serial(async () => {
    const list = (await loadDismissed()).filter((n) => n !== name);
    list.push(name);
    await storeAuthData(
      NOSTR_ADDRESS_BOOK_DISMISSED_KEY,
      JSON.stringify(list.slice(-MAX_DISMISSED)),
    );
  });
}

/** Saved by hand again: it is wanted after all. */
export function undismissNuriUsername(username: string): Promise<void> {
  const name = username.trim().toLowerCase();
  if (!name) return Promise.resolve();
  return serial(async () => {
    const list = await loadDismissed();
    if (!list.includes(name)) return;
    await storeAuthData(
      NOSTR_ADDRESS_BOOK_DISMISSED_KEY,
      JSON.stringify(list.filter((n) => n !== name)),
    );
  });
}
