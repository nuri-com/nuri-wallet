// A recipient typed on a send screen, saved once the send went out: added to
// the contact of that name, or a new contact; nothing when that destination is
// already saved. Shared by push to card (a card) and bank transfer (an IBAN).
// Pure, so the rule is testable without the book or a renderer.
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
};

/**
 * Save a recipient into the book of the account that sent to it. `origin` is
 * that account's book, taken BEFORE the send went out; `now` is the book signed
 * in at completion. A wallet switch in between makes them differ (and closes
 * the origin book, so a later write rejects): nothing is written, so one
 * account's recipient never lands in another's book. True when a contact was
 * written.
 */
export async function saveRecipientToOriginBook<B extends RecipientBook>(
  origin: Promise<B | null>,
  now: () => Promise<B>,
  name: string,
  destination: Destination,
): Promise<boolean> {
  const book = await origin;
  if (!book || (await now()) !== book) return false;
  const write = recipientContactWrite(await book.current(), name, destination);
  if (!write) return false;
  if (write.id) await book.update(write.id, write.input);
  else await book.add(write.input);
  return true;
}
