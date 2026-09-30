// The app's address book: the shared core (lib/addressBook) wired to the
// wallet's key, secure local storage and the default relay set.
//
// Local storage holds only signed ciphertext (the same bytes the relays hold)
// under NOSTR_ADDRESS_BOOK_CACHE_KEY, which logout/factory reset wipe. Logout
// reloads the JS runtime; a wallet replacement does not, so the wipe also calls
// resetAddressBook() to close the in-memory instance and zeroize its keys.
import { AddressBook } from "../../lib/addressBook/AddressBook";
import type { Contact } from "../../lib/addressBook/contact";
import { clearAvatarCache } from "../../lib/addressBook/petAvatar";
import { deriveAddressBookKeys, deriveAddressBookSecret } from "../../lib/addressBook/crypto";
import { relayTransport } from "../../lib/addressBook/relayTransport";
import { zeroize } from "../../lib/crypto";
import { getOrCreateNostrKeypair } from "../../lib/nostr/nostr";
import { NOSTR_ADDRESS_BOOK_CACHE_KEY } from "../../lib/nostr/storage";
import { getAuthData, storeAuthData } from "../../lib/secureKeyStorage";
import { bech32 } from "bech32";

let instance: Promise<AddressBook> | null = null;
// The contacts last shown by any screen, so a screen mounting later can draw
// saved names on its first frame. Cleared with the book on a wallet change.
let lastShownContacts: Contact[] = [];

export function lastAddressBookContacts(): Contact[] {
  return lastShownContacts;
}

export function rememberAddressBookContacts(contacts: Contact[]): void {
  lastShownContacts = contacts;
}
// While a reset is closing the previous wallet's book, nothing may open a new
// one: it would derive from whatever key is in storage mid-wipe.
let resetting: Promise<void> | null = null;

async function create(): Promise<AddressBook> {
  const nostr = await getOrCreateNostrKeypair();
  const bookSk = deriveAddressBookSecret(nostr.sk);
  zeroize(nostr.sk);
  const keys = deriveAddressBookKeys(bookSk);
  try {
    // The book keeps its own copies (zeroized by close()).
    return new AddressBook(keys, relayTransport(), {
      load: () => getAuthData(NOSTR_ADDRESS_BOOK_CACHE_KEY),
      save: (value) => storeAuthData(NOSTR_ADDRESS_BOOK_CACHE_KEY, value),
    });
  } finally {
    zeroize(keys.sk);
    zeroize(keys.encKey);
    zeroize(keys.tagKey);
  }
}

/** The signed-in wallet's address book (created on first use). */
export function getAddressBook(): Promise<AddressBook> {
  if (resetting) return resetting.then(() => getAddressBook());
  if (!instance) {
    const created: Promise<AddressBook> = create().catch((error) => {
      if (instance === created) instance = null;
      throw error;
    });
    instance = created;
  }
  return instance;
}

/**
 * Forget the current wallet's address book: close the instance (zeroizes its
 * keys, drops decrypted contacts, rejects queued calls). The next
 * getAddressBook() opens the book of whichever wallet is signed in then.
 */
export function resetAddressBook(): Promise<void> {
  if (resetting) return resetting;
  const run = (async () => {
    // The old instance stays installed (and new callers wait on `resetting`)
    // until it is closed, so no second instance can come from the old key.
    const current = instance;
    lastShownContacts = [];
    clearAvatarCache();
    if (current) {
      try {
        await (await current).close();
      } catch {
        // Never opened (e.g. no key): nothing to close.
      }
    }
    instance = null;
  })();
  resetting = run.finally(() => {
    resetting = null;
  });
  return resetting;
}

/**
 * The address-book-only key as an nsec, for the desktop CLI/MCP
 * (tools/address-book). It opens the address book and nothing else.
 */
export async function exportAddressBookKey(): Promise<string> {
  const nostr = await getOrCreateNostrKeypair();
  const bookSk = deriveAddressBookSecret(nostr.sk);
  zeroize(nostr.sk);
  try {
    return bech32.encode("nsec", bech32.toWords(bookSk));
  } finally {
    zeroize(bookSk);
  }
}
