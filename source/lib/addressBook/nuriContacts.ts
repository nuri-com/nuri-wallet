// Nuri users you paid or were paid by land in the address book by themselves
// (#1770): one contact per username, holding every address seen for them.
//
// Those addresses only name payments (old and new) as that person. A send to a
// Nuri contact never uses them: it looks the username up when it is made, so a
// user who changed address is paid at the new one.
//
// Pure decisions; the book, the dismissed list and the lookup are wired in
// services/addressBook/nuriContactSync.
import {
  type Contact,
  type ContactInput,
  type Destination,
  MAX_DESTINATIONS,
  sameAddress,
} from "./contact";

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

export type NuriContactWrite =
  | { kind: "add"; input: ContactInput }
  | { kind: "update"; id: string; input: ContactInput };

/** The live contact saved for this Nuri username, if any. */
export function nuriContactFor(contacts: Contact[], username: string): Contact | null {
  const name = username.trim().toLowerCase();
  return contacts.find((c) => !c.deleted && c.nuriUsername === name) ?? null;
}

const holds = (contact: Contact, destination: Destination): boolean =>
  contact.destinations.some((d) => sameAddress(d.raw, destination.raw));

/**
 * What payments with Nuri user `username` change in the book, or null for
 * nothing. `seen` are the addresses of those payments, NEWEST FIRST.
 *
 * - An address is compared as an address, whatever rail it was saved for (a
 *   Base EURC address and the same `0x` seen in a payment are one recipient).
 *   One that another contact already holds stays that contact's: it is never
 *   added here, so a contact the user saved by hand keeps its payments.
 * - Their contact exists: it gets the new addresses. It keeps the newest
 *   MAX_DESTINATIONS; the addresses it held that these payments did not show
 *   go first, then the oldest payments.
 * - None exists: nothing if the user removed theirs before (`dismissed`), else
 *   a new contact named after the username.
 * - Nothing new to add: null, so the same history read again writes nothing.
 */
export function nuriContactWrite(
  contacts: Contact[],
  username: string,
  seen: Destination[],
  dismissed: ReadonlySet<string>,
): NuriContactWrite | null {
  const name = username.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return null;
  const existing = nuriContactFor(contacts, name);
  const others = contacts.filter((c) => !c.deleted && c.id !== existing?.id);
  const newest: Destination[] = [];
  for (const destination of seen) {
    if (newest.length >= MAX_DESTINATIONS) break;
    if (newest.some((d) => sameAddress(d.raw, destination.raw))) continue;
    if (others.some((c) => holds(c, destination))) continue;
    newest.push(destination);
  }
  if (newest.length === 0) return null;
  const oldestFirst = [...newest].reverse();
  if (existing) {
    if (newest.every((d) => holds(existing, d))) return null;
    const kept = existing.destinations.filter(
      (d) => !newest.some((n) => sameAddress(n.raw, d.raw)),
    );
    return {
      kind: "update",
      id: existing.id,
      input: {
        label: existing.label,
        ...(existing.note ? { note: existing.note } : {}),
        nuriUsername: name,
        destinations: [...kept, ...oldestFirst].slice(-MAX_DESTINATIONS),
      },
    };
  }
  if (dismissed.has(name)) return null;
  return {
    kind: "add",
    input: { label: name, nuriUsername: name, destinations: oldestFirst },
  };
}

/** One activity row's other side: its address and who it is, if known. */
export type NuriActivityRow = {
  address: string;
  /** The Nuri user: their saved contact's username, else the server's name. */
  username: string | null;
  /** A saved contact already names this row. */
  saved: boolean;
};

/**
 * The payments to save, per Nuri user, from an activity list NEWEST FIRST:
 * each user's newest MAX_DESTINATIONS distinct addresses, and only for users
 * with an unsaved address among them. A row older than that is never
 * submitted, so it cannot push a newer address out of the contact, and a
 * list whose newest addresses are all saved asks for nothing.
 */
export function nuriActivityPayments(rows: NuriActivityRow[]): Map<string, string[]> {
  const byUser = new Map<string, { addresses: string[]; unsaved: boolean }>();
  for (const row of rows) {
    if (!row.username) continue;
    const entry = byUser.get(row.username) ?? { addresses: [], unsaved: false };
    byUser.set(row.username, entry);
    if (entry.addresses.length >= MAX_DESTINATIONS) continue;
    if (entry.addresses.some((a) => sameAddress(a, row.address))) continue;
    entry.addresses.push(row.address);
    if (!row.saved) entry.unsaved = true;
  }
  const out = new Map<string, string[]>();
  for (const [username, entry] of byUser) {
    if (entry.unsaved) out.set(username, entry.addresses);
  }
  return out;
}

/** How an EVM address seen in a payment is kept: one address, any EVM token. */
export function evmDestination(address: string): Destination {
  return { type: "crypto", raw: address.trim(), network: "evm", asset: "ANY" };
}

/** How a Bitcoin send's destination is kept: an Arkade or a Bitcoin address. */
export function bitcoinDestination(address: string, arkade: boolean): Destination {
  return {
    type: "crypto",
    raw: address.trim(),
    network: arkade ? "ark" : "bitcoin",
    asset: "BTC",
  };
}
