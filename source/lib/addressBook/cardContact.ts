// A card typed on the push-to-card screen, as an address-book write: added to
// the contact of that name, or a new contact; nothing when it is already saved.
// Pure, so the rule is testable without the book or a renderer.
import { type Contact, type ContactInput, MAX_DESTINATIONS, normalizeCardNumber } from "./contact";

export type CardContactWrite = { id?: string; input: ContactInput } | null;

export function cardContactWrite(
  contacts: Contact[],
  name: string,
  number: string,
): CardContactWrite {
  const holder = name.trim().replace(/\s+/g, " ");
  const digits = normalizeCardNumber(number);
  if (!holder || !digits) return null;
  const live = contacts.filter((c) => !c.deleted);
  if (live.some((c) => c.destinations.some((d) => d.type === "card" && d.number === digits))) {
    return null;
  }
  const card = { type: "card" as const, raw: digits, number: digits, holder };
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
        destinations: [...same.destinations, card],
      },
    };
  }
  return { input: { label: holder, destinations: [card] } };
}

type CardBook = {
  current(): Promise<Contact[]>;
  add(input: ContactInput): Promise<unknown>;
  update(id: string, input: ContactInput): Promise<unknown>;
};

/**
 * Save a card Wirex accepted into the book of the account that submitted it.
 * `origin` is that account's book, taken BEFORE the card went out; `now` is
 * the book signed in at completion. A wallet switch in between makes them
 * differ (and closes the origin book, so a later write rejects): nothing is
 * written, so one account's card never lands in another's book. True when a
 * contact was written.
 */
export async function saveCardToOriginBook<B extends CardBook>(
  origin: Promise<B | null>,
  now: () => Promise<B>,
  name: string,
  number: string,
): Promise<boolean> {
  const book = await origin;
  if (!book || (await now()) !== book) return false;
  const write = cardContactWrite(await book.current(), name, number);
  if (!write) return false;
  if (write.id) await book.update(write.id, write.input);
  else await book.add(write.input);
  return true;
}
