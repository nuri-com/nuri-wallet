// A card typed on the push-to-card screen, as an address-book write: added to
// the contact of that name, or a new contact; nothing when it is already saved.
// Pure, so the rule is testable without the book or a renderer.
import { type Contact, normalizeCardNumber } from "./contact";
import {
  type RecipientBook,
  type RecipientContactWrite,
  recipientContactWrite,
  saveRecipientToOriginBook,
} from "./savedRecipient";

export type CardContactWrite = RecipientContactWrite;

export function cardContactWrite(
  contacts: Contact[],
  name: string,
  number: string,
): CardContactWrite {
  const holder = name.trim().replace(/\s+/g, " ");
  const digits = normalizeCardNumber(number);
  if (!holder || !digits) return null;
  return recipientContactWrite(contacts, holder, {
    type: "card",
    raw: digits,
    number: digits,
    holder,
  });
}

/** Save a card Wirex accepted into the book of the account that submitted it (see savedRecipient). */
export async function saveCardToOriginBook<B extends RecipientBook>(
  origin: Promise<B | null>,
  now: () => Promise<B>,
  name: string,
  number: string,
): Promise<boolean> {
  const holder = name.trim().replace(/\s+/g, " ");
  const digits = normalizeCardNumber(number);
  if (!holder || !digits) return false;
  return saveRecipientToOriginBook(origin, now, holder, {
    type: "card",
    raw: digits,
    number: digits,
    holder,
  });
}
