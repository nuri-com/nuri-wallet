// Which saved contact an activity row is with, and the rows of one contact.
//
// One rule for the whole app: the activity lists name a row after the contact
// this finds, and a contact's own page lists exactly the rows this gives to
// it, so a payment that reads "To Emil" in the activity is the one in Emil's
// history, never somebody else's. Pure: the Arkade script decoder is passed in.
import { type Contact, savedContactFor } from "./contact";

/** The parts of an activity row that name the other side. */
export type ActivityCounterparty = {
  key: string;
  /** Arkade: the other party's output scripts (hex). */
  counterpartyScripts?: string[];
  /** The other party's address (a sender, for money in). */
  counterpartyAddress?: string;
  /** Arkade: the other party's addresses, rebuilt from its scripts. */
  counterpartyAddresses?: string[];
  /** The recipient of an outgoing row (an address or an IBAN). */
  saveOffer?: { destination: { raw: string } } | null;
  pending?: boolean;
  createdAt?: string;
};

/** Saved Arkade addresses by output script (lowercase hex), first contact wins. */
export function contactsByArkScript(
  contacts: readonly Contact[],
  scriptOf: (address: string) => string | null | undefined,
): Map<string, Contact> {
  const map = new Map<string, Contact>();
  for (const contact of contacts) {
    if (contact.deleted) continue;
    for (const d of contact.destinations) {
      if (d.type !== "crypto" || d.network !== "ark") continue;
      const script = scriptOf(d.raw)?.toLowerCase();
      if (script && !map.has(script)) map.set(script, contact);
    }
  }
  return map;
}

/**
 * The saved contact on the other side of a row: by its Arkade scripts, then
 * its recipient or sender address (an IBAN for a bank row), then the sender
 * addresses an Arkade deposit carries over from its onchain row (#1782).
 */
export function activityContactOf(
  item: ActivityCounterparty,
  contacts: Contact[],
  byScript: ReadonlyMap<string, Contact>,
): Contact | null {
  for (const script of item.counterpartyScripts ?? []) {
    const contact = byScript.get(script.toLowerCase());
    if (contact) return contact;
  }
  const address = item.saveOffer?.destination.raw ?? item.counterpartyAddress;
  const direct = address ? savedContactFor(contacts, address, () => true) : null;
  if (direct) return direct;
  for (const other of item.counterpartyAddresses ?? []) {
    const contact = savedContactFor(contacts, other, () => true);
    if (contact) return contact;
  }
  return null;
}

/**
 * The rows with one contact, pending first, then newest first, each row once.
 * A row belongs to the contact the activity names it after: their saved
 * details, or, for a row no saved contact claims, the Nuri username the server
 * names for its address when that is this contact's username.
 */
export function contactHistory<T extends ActivityCounterparty>(
  items: readonly T[],
  contact: Pick<Contact, "id" | "nuriUsername">,
  contactOf: (item: T) => Contact | null,
  usernameOf: (item: T) => string | null,
): T[] {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    const saved = contactOf(item);
    const belongs = saved
      ? saved.id === contact.id
      : Boolean(contact.nuriUsername) && usernameOf(item) === contact.nuriUsername;
    if (!belongs) continue;
    seen.add(item.key);
    rows.push(item);
  }
  const time = (row: T) => {
    const ms = Date.parse(String(row.createdAt ?? ""));
    return Number.isFinite(ms) ? ms : 0;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ap = a.row.pending === true;
      const bp = b.row.pending === true;
      if (ap !== bp) return ap ? -1 : 1;
      return time(b.row) - time(a.row) || a.index - b.index;
    })
    .map(({ row }) => row);
}
