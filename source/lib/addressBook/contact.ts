// Address book contact model: typed destinations, validation and the size
// ceiling. Pure data, no I/O, no React Native — shared by the app and the
// local CLI/MCP (tools/address-book).
//
// A destination keeps the raw text the user entered plus the one canonical
// field this module can derive WITHOUT guessing: an IBAN is normalized, an
// email lowercased, a phone number must already be E.164. A crypto destination
// names its network and asset explicitly — a ticker alone never identifies an
// asset, and nothing here infers a network from an address shape.

export const ADDRESS_BOOK_SCHEMA = "nuri.address-book.contact.v1";
export const MAX_CONTACTS = 2000;
export const MAX_CONTACT_BYTES = 16 * 1024;
export const MAX_DESTINATIONS = 20;
export const MAX_LABEL_CHARS = 120;
export const MAX_NOTE_CHARS = 1000;

export type DestinationType = "crypto" | "lightning" | "bank" | "card" | "phone" | "email";

export type Destination =
  | {
      type: "crypto";
      /** Address exactly as entered. */
      raw: string;
      /** Chain the address lives on, e.g. "bitcoin", "ark", "base", "solana". */
      network: string;
      /** Asset symbol on that network, e.g. "BTC", "EURC", "USDC". */
      asset: string;
      label?: string;
    }
  | { type: "lightning"; raw: string; label?: string }
  | { type: "bank"; raw: string; iban: string; bic: string; holder?: string; label?: string }
  /** A Visa or Mastercard to send money to; `number` is the digits only. */
  | { type: "card"; raw: string; number: string; holder?: string; label?: string }
  | { type: "phone"; raw: string; e164: string; label?: string }
  | { type: "email"; raw: string; email: string; label?: string };

export type Contact = {
  schema: typeof ADDRESS_BOOK_SCHEMA;
  /** Stable random id; the relay only ever sees its HMAC. */
  id: string;
  label: string;
  note?: string;
  /** The contact's Nuri username, when they are a Nuri user (e.g. "emino"). */
  nuriUsername?: string;
  destinations: Destination[];
  /** Milliseconds; the writer's clock, informational only. */
  updatedAt: number;
  deleted?: boolean;
};

export type ContactInput = {
  label: string;
  note?: string;
  nuriUsername?: string;
  destinations: Destination[];
};

export class ContactValidationError extends Error {}

const NETWORK_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Same alphabet as Nuri usernames (lib/arkade/usernameAvailability USERNAME_REGEX);
// kept here so the core stays dependency-free for the CLI/MCP.
const NURI_USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;
const ASSET_RE = /^[A-Za-z0-9.]{1,16}$/;
const E164_RE = /^\+[1-9][0-9]{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IBAN_RE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/;
export const BIC_RE = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

const trim = (value: unknown): string => String(value ?? "").trim();

export function normalizeIban(value: string): string {
  return trim(value)
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

/** Digits of a card number, 12 to 19 long and passing the Luhn check; else "". */
export function normalizeCardNumber(value: string): string {
  const digits = trim(value).replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(digits)) return "";
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0 ? digits : "";
}

/** ISO 13616 mod-97 check. */
export function isValidIbanChecksum(iban: string): boolean {
  if (!IBAN_RE.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function optionalLabel(value: unknown): string | undefined {
  const label = trim(value);
  if (!label) return undefined;
  if (label.length > MAX_LABEL_CHARS)
    throw new ContactValidationError("destination label too long");
  return label;
}

/**
 * Validate one destination and return it in canonical form. Every write needs
 * a bank BIC; `stored` reads a record saved before that rule (BIC left empty,
 * filled when the contact is next edited).
 */
export function normalizeDestination(input: Destination, stored = false): Destination {
  const raw = trim(input?.raw);
  if (!raw) throw new ContactValidationError("destination is empty");
  if (raw.length > 2048) throw new ContactValidationError("destination too long");
  const label = optionalLabel(input.label);
  switch (input?.type) {
    case "crypto": {
      const network = trim(input.network).toLowerCase();
      const asset = trim(input.asset).toUpperCase();
      if (!NETWORK_RE.test(network))
        throw new ContactValidationError("crypto destination needs a network");
      if (!ASSET_RE.test(asset))
        throw new ContactValidationError("crypto destination needs an asset");
      return { type: "crypto", raw, network, asset, ...(label ? { label } : {}) };
    }
    case "lightning":
      return { type: "lightning", raw, ...(label ? { label } : {}) };
    case "bank": {
      const iban = normalizeIban(input.iban || raw);
      if (!isValidIbanChecksum(iban)) throw new ContactValidationError("invalid IBAN");
      const bic = trim(input.bic).toUpperCase();
      if (!(stored && !bic) && !BIC_RE.test(bic))
        throw new ContactValidationError("bank destination needs a valid BIC");
      const holder = trim(input.holder);
      return {
        type: "bank",
        raw,
        iban,
        bic,
        ...(holder ? { holder: holder.slice(0, MAX_LABEL_CHARS) } : {}),
        ...(label ? { label } : {}),
      };
    }
    case "card": {
      const number = normalizeCardNumber(input.number || raw);
      if (!number) throw new ContactValidationError("invalid card number");
      const holder = trim(input.holder);
      return {
        type: "card",
        raw,
        number,
        ...(holder ? { holder: holder.slice(0, MAX_LABEL_CHARS) } : {}),
        ...(label ? { label } : {}),
      };
    }
    case "phone": {
      const e164 = trim(input.e164 || raw).replace(/[\s()-]/g, "");
      if (!E164_RE.test(e164)) {
        throw new ContactValidationError(
          "phone number must be in international format (+country…)",
        );
      }
      return { type: "phone", raw, e164, ...(label ? { label } : {}) };
    }
    case "email": {
      const email = trim(input.email || raw).toLowerCase();
      if (!EMAIL_RE.test(email)) throw new ContactValidationError("invalid email");
      return { type: "email", raw, email, ...(label ? { label } : {}) };
    }
    default:
      throw new ContactValidationError("unknown destination type");
  }
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Build a validated contact record from user input. */
export function buildContact(
  id: string,
  input: ContactInput,
  now: number,
  stored = false,
): Contact {
  const label = trim(input?.label);
  if (!label) throw new ContactValidationError("contact needs a name");
  if (label.length > MAX_LABEL_CHARS) throw new ContactValidationError("name too long");
  const note = trim(input.note);
  if (note.length > MAX_NOTE_CHARS) throw new ContactValidationError("note too long");
  const nuriUsername = trim(input.nuriUsername).toLowerCase().replace(/^@/, "");
  if (nuriUsername && !NURI_USERNAME_RE.test(nuriUsername))
    throw new ContactValidationError("invalid Nuri username");
  const destinations = (input.destinations ?? []).map((d) => normalizeDestination(d, stored));
  if (destinations.length === 0) throw new ContactValidationError("contact needs a destination");
  if (destinations.length > MAX_DESTINATIONS)
    throw new ContactValidationError("too many destinations");
  const contact: Contact = {
    schema: ADDRESS_BOOK_SCHEMA,
    id,
    label,
    ...(note ? { note } : {}),
    ...(nuriUsername ? { nuriUsername } : {}),
    destinations,
    updatedAt: now,
  };
  if (encodedBytes(contact) > MAX_CONTACT_BYTES)
    throw new ContactValidationError("contact too large");
  return contact;
}

export function tombstone(id: string, now: number): Contact {
  return {
    schema: ADDRESS_BOOK_SCHEMA,
    id,
    label: "",
    destinations: [],
    updatedAt: now,
    deleted: true,
  };
}

/** Parse decrypted content; returns null for anything that is not a contact. */
export function parseContact(json: string): Contact | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const record = value as Contact;
  if (!record || record.schema !== ADDRESS_BOOK_SCHEMA) return null;
  if (typeof record.id !== "string" || !/^[0-9a-f]{32}$/.test(record.id)) return null;
  if (record.deleted) return tombstone(record.id, Number(record.updatedAt) || 0);
  try {
    return {
      ...buildContact(record.id, record, Number(record.updatedAt) || 0, true),
      updatedAt: Number(record.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

/** Case-insensitive search over name, note and every destination field. */
export function contactMatches(contact: Contact, query: string): boolean {
  const q = trim(query).toLowerCase();
  if (!q) return true;
  const haystack = [
    contact.label,
    contact.note ?? "",
    // "@emino" finds the contact saved from the Nuri lookup, whatever its name.
    contact.nuriUsername ? `@${contact.nuriUsername}` : "",
    ...contact.destinations.flatMap((d) => Object.values(d).map(String)),
  ]
    .join("\n")
    .toLowerCase();
  const compact = (s: string) => s.replace(/\s+/g, "");
  return haystack.includes(q) || compact(haystack).includes(compact(q));
}

/**
 * Identity of a destination for "is this already saved?": the canonical field
 * of its type (IBAN, E.164, lowercased email), and for crypto the network, the
 * asset (EURC and USDC at one Base address are two destinations) and the
 * address as entered (case kept: only bech32/hex are case-insensitive).
 */
export function destinationKey(destination: Destination): string {
  switch (destination.type) {
    case "crypto": {
      const raw = destination.raw.trim();
      const folded = /^(bc1|tb1|bcrt1|ark1|tark1|0x)/i.test(raw) ? raw.toLowerCase() : raw;
      return `crypto:${destination.network}:${destination.asset.trim().toUpperCase()}:${folded}`;
    }
    case "lightning":
      return `lightning:${destination.raw.trim().toLowerCase()}`;
    case "bank":
      return `bank:${destination.iban}`;
    case "card":
      return `card:${destination.number}`;
    case "phone":
      return `phone:${destination.e164}`;
    case "email":
      return `email:${destination.email}`;
  }
}

export type DestinationSuggestion = { contact: Contact; destination: Destination; index: number };

/**
 * Saved destinations that match what the user is typing into a recipient
 * field. Matches a contact's name or note (then every accepted destination of
 * it) or a destination's own fields. Nothing when the text is empty or already
 * IS a saved destination (the pick is done), so the dropdown only shows while
 * there is something to offer.
 */
export function suggestDestinations(
  contacts: Contact[],
  query: string,
  accepts: (destination: Destination) => boolean,
  max = 5,
  /**
   * Cost of paying a destination from this screen, lower is cheaper, Infinity
   * when it cannot be paid. When set, each contact is suggested once, at its
   * cheapest payable destination: a person is one row, not one per address.
   */
  cost?: (destination: Destination) => number,
): DestinationSuggestion[] {
  const q = trim(query).toLowerCase();
  if (!q) return [];
  const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const cq = compact(q);
  const hit = (value: string) => {
    const v = value.toLowerCase();
    return v.includes(q) || compact(v).includes(cq);
  };
  const out: DestinationSuggestion[] = [];
  for (const contact of contacts) {
    if (contact.deleted) continue;
    const byName =
      hit(contact.label) ||
      hit(contact.note ?? "") ||
      (contact.nuriUsername ? hit(`@${contact.nuriUsername}`) : false);
    out.push(
      ...cheapestPerContact(
        payableDestinations(contact, accepts, cost).filter(
          (m) => byName || Object.values(m.destination).some((v) => hit(String(v))),
        ),
        cost,
      ),
    );
  }
  // The field already holds exactly a saved destination: the pick is done.
  if (
    out.some(
      (s) =>
        compact(s.destination.raw) === cq ||
        (s.destination.type === "bank" && s.destination.iban.toLowerCase() === cq) ||
        (s.destination.type === "card" && s.destination.number === cq.replace(/-/g, "")),
    )
  ) {
    return [];
  }
  return out.slice(0, max);
}

/** A contact's destinations this screen accepts and can pay. */
function payableDestinations(
  contact: Contact,
  accepts: (destination: Destination) => boolean,
  cost?: (destination: Destination) => number,
): DestinationSuggestion[] {
  const out: DestinationSuggestion[] = [];
  contact.destinations.forEach((destination, index) => {
    if (!accepts(destination)) return;
    if (cost && !Number.isFinite(cost(destination))) return;
    out.push({ contact, destination, index });
  });
  return out;
}

/** With a cost, a person is one row: their cheapest destination. */
function cheapestPerContact(
  matches: DestinationSuggestion[],
  cost?: (destination: Destination) => number,
): DestinationSuggestion[] {
  if (!cost || matches.length <= 1) return matches;
  return [matches.reduce((best, m) => (cost(m.destination) < cost(best.destination) ? m : best))];
}

/**
 * Every saved contact this screen can pay, by name, for a recipient field that
 * is still empty: one row per person, at the cheapest destination when the
 * screen has a cost, else the first one it can pay.
 */
export function payableContacts(
  contacts: Contact[],
  accepts: (destination: Destination) => boolean,
  cost?: (destination: Destination) => number,
): DestinationSuggestion[] {
  return contacts
    .filter((contact) => !contact.deleted)
    .flatMap((contact) => {
      const payable = payableDestinations(contact, accepts, cost);
      return cost ? cheapestPerContact(payable, cost) : payable.slice(0, 1);
    })
    .sort((a, b) => a.contact.label.localeCompare(b.contact.label));
}

/** Two typed addresses are the same (bech32/hex/Lightning ignore case; base58 doesn't). */
function sameAddress(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return true;
  const folds = /^(bc1|tb1|bcrt1|ark1|tark1|0x|lnurl)/i;
  const lightning = /^[^@\s]+@[^@\s]+$/;
  return (
    ((folds.test(x) && folds.test(y)) || (lightning.test(x) && lightning.test(y))) &&
    x.toLowerCase() === y.toLowerCase()
  );
}

/**
 * The saved contact a recipient belongs to, if any: the one with a destination
 * this screen pays whose address is exactly what the field holds. Send screens
 * show its name instead of a bare address.
 */
/** A saved contact already holds this destination (same address or IBAN, any kind). */
export function isRecipientSaved(contacts: Contact[], destination: Destination): boolean {
  const address =
    destination.type === "bank"
      ? destination.iban || destination.raw
      : destination.type === "card"
        ? destination.number || destination.raw
        : destination.raw;
  return savedContactFor(contacts, address, () => true) !== null;
}

export function savedContactFor(
  contacts: Contact[],
  recipient: string,
  accepts: (destination: Destination) => boolean,
): Contact | null {
  if (!recipient.trim()) return null;
  return (
    contacts.find(
      (c) =>
        !c.deleted &&
        c.destinations.some(
          (d) =>
            accepts(d) &&
            (sameAddress(d.raw, recipient) ||
              (d.type === "bank" &&
                sameAddress(d.iban, recipient.replace(/\s+/g, "").toUpperCase())) ||
              (d.type === "card" && d.number === recipient.replace(/[\s-]/g, ""))),
        ),
    ) ?? null
  );
}

/** "Emin (0xd353…4e02)": the saved name, with enough address to verify it. */
export function recipientWithName(name: string, address: string): string {
  const a = address.trim();
  const short = a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
  return `${name} (${short})`;
}
