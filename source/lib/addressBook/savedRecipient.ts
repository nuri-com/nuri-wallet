// A recipient typed on a send screen, saved once the send went out: added to
// the contact of that name, or a new contact; nothing when that destination is
// already saved. Shared by push to card (a card) and bank transfer (an IBAN).
// Pure, so the rule is testable without the book or a renderer.
import type { ContactConflict } from "./AddressBook";
import {
  type Contact,
  type ContactInput,
  type Destination,
  destinationKey,
  MAX_DESTINATIONS,
  normalizeDestination,
} from "./contact";

export type RecipientContactWrite = { id?: string; input: ContactInput } | null;

/** The write that saves `destination` under `name`, or null when there is nothing to save. */
export function recipientContactWrite(
  contacts: Contact[],
  name: string,
  destination: Destination,
): RecipientContactWrite {
  const holder = name.trim().replace(/\s+/g, " ");
  if (!holder) return null;
  let normalized: Destination;
  try {
    normalized = normalizeDestination(destination);
  } catch {
    return null;
  }
  const key = destinationKey(normalized);
  const live = contacts.filter((c) => !c.deleted);
  if (live.some((c) => c.destinations.some((d) => destinationKey(d) === key))) return null;
  const same = live.find(
    (c) =>
      c.label.trim().toLowerCase() === holder.toLowerCase() &&
      c.destinations.length < MAX_DESTINATIONS,
  );
  if (same) {
    return {
      id: same.id,
      input: {
        label: same.label,
        note: same.note,
        nuriUsername: same.nuriUsername,
        destinations: [...same.destinations, normalized],
      },
    };
  }
  return { input: { label: holder, destinations: [normalized] } };
}

export type RecipientBook = {
  current(): Promise<Contact[]>;
  add(input: ContactInput): Promise<unknown>;
  update(id: string, input: ContactInput): Promise<unknown>;
  /** Pull the relays' contacts into the local copy (AddressBook.sync). */
  sync?(): Promise<unknown>;
  /** Open conflicts: a local edit and a newer remote one of the same contact. */
  currentConflicts?(): Promise<ContactConflict[]>;
};

// One save at a time per book: the "already saved?" read and the write are
// separate book calls, so two sends finishing together would both see the
// IBAN missing and both add a contact.
const saving = new WeakMap<object, Promise<unknown>>();

function oneAtATime<T>(book: object, fn: () => Promise<T>): Promise<T> {
  const previous = saving.get(book) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  saving.set(
    book,
    next.catch((): undefined => undefined),
  );
  return next;
}

/**
 * Save a recipient into the book of the account that sent to it. `origin` is
 * that account's book, taken BEFORE the send went out; `now` is the book signed
 * in at completion. A wallet switch in between makes them differ (and closes
 * the origin book, so a later write rejects): nothing is written, so one
 * account's recipient never lands in another's book. True when a contact was
 * written.
 *
 * The local copy can lag the relays (a fresh web session, a second device): a
 * contact saved elsewhere is not in it yet, and a save checked only against it
 * adds the same IBAN or card a second time as a new contact (#1751). So the
 * book syncs first; a sync that fails (offline) still lets the save go ahead
 * against what is local.
 */
export async function saveRecipientToOriginBook<B extends RecipientBook>(
  origin: Promise<B | null>,
  now: () => Promise<B>,
  name: string,
  destination: Destination,
): Promise<boolean> {
  const book = await origin;
  if (!book || (await now()) !== book) return false;
  return oneAtATime(book, async () => {
    if (book.sync) {
      try {
        await book.sync();
      } catch {
        // Offline or closed: closed fails the read below; offline saves locally.
      }
      // The wallet may have switched while the relays answered.
      if ((await now()) !== book) return false;
    }
    // A contact with an open conflict waits for the user to pick a side: any
    // edit to it counts as that choice (AddressBook.write) and would drop the
    // other device's version. Its remote side also counts as saved.
    const conflicts = book.currentConflicts ? await book.currentConflicts() : [];
    const conflicted = new Set(conflicts.map((c) => c.id));
    const contacts = [...(await book.current()), ...conflicts.map((c) => c.remote)];
    const write = recipientContactWrite(contacts, name, destination);
    if (!write || (write.id && conflicted.has(write.id))) return false;
    if (write.id) await book.update(write.id, write.input);
    else await book.add(write.input);
    return true;
  });
}
