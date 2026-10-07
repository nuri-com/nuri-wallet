// Address book encryption and relay-visible tags.
//
// Keys: the address book has its OWN signing key, derived one-way from the
// wallet's Nostr key (which is derived from the wallet seed):
//   bookSk = HKDF-SHA256(sha256(nostrSk), salt, "nuri:address-book:sign:v1")
// so restoring the wallet restores the book, while the book key grants the
// address book and nothing else: not support chat, not the Nostr backups. The
// desktop tools never hold it; they get the book through a passkey approval
// at connect.nuri.com, which re-derives it there. From bookSk:
//   encKey = HKDF-SHA256(sha256(bookSk), salt, "nuri:address-book:enc:v1")
//   tagKey = HKDF-SHA256(sha256(bookSk), salt, "nuri:address-book:tag:v1")
// The relay sees only:
//   d = HMAC(tagKey, "contact:" + id)  — stable per contact, opaque
//   t = HMAC(tagKey, "contacts-v1")    — lets the owner query all contacts
// Content is XChaCha20-Poly1305; the AAD binds the ciphertext to its d tag, so
// a stored ciphertext cannot be replayed under another contact's slot.
import {
  aeadDecryptX,
  aeadEncryptX,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  bytesToUtf8,
  hkdfSha256,
  hmacSha256,
  randomBytes,
  schnorr,
  secp256k1,
  sha256,
  utf8ToBytes,
  zeroize,
} from "../crypto";
import { type NostrEvent, signEvent, verifyEvent } from "../nostr/event";
import { type Contact, parseContact } from "./contact";

export const ADDRESS_BOOK_KIND = 30078;
export const ADDRESS_BOOK_FORMAT = "nuri-address-book-v1";
const ENCRYPTION = "xchacha20poly1305-hkdf-sha256-nostr-key-v1";
const SALT = utf8ToBytes("nuri-address-book-salt-v1");

export type AddressBookKeys = {
  pubkey: string;
  /** Nostr signing key (the caller owns and zeroizes it). */
  sk: Uint8Array;
  encKey: Uint8Array;
  tagKey: Uint8Array;
  /** HMAC(tagKey, "contacts-v1"), hex. */
  collectionTag: string;
};

/**
 * The address book's signing secret, from the wallet's Nostr secret key.
 * One-way and domain-separated. The caller owns and zeroizes both keys.
 */
export function deriveAddressBookSecret(nostrSk: Uint8Array): Uint8Array {
  const ikm = sha256(nostrSk);
  try {
    let candidate = hkdfSha256(ikm, SALT, utf8ToBytes("nuri:address-book:sign:v1"), 32);
    for (let attempt = 0; attempt < 256; attempt += 1) {
      if (secp256k1.utils.isValidSecretKey(candidate)) return candidate;
      const next = sha256(candidate);
      zeroize(candidate);
      candidate = next;
    }
    throw new Error("unable to derive address book key");
  } finally {
    zeroize(ikm);
  }
}

/** Keys for one address book, from its signing secret (see deriveAddressBookSecret). */
export function deriveAddressBookKeys(sk: Uint8Array): AddressBookKeys {
  const ikm = sha256(sk);
  try {
    const encKey = hkdfSha256(ikm, SALT, utf8ToBytes("nuri:address-book:enc:v1"), 32);
    const tagKey = hkdfSha256(ikm, SALT, utf8ToBytes("nuri:address-book:tag:v1"), 32);
    return {
      pubkey: bytesToHex(schnorr.getPublicKey(sk)),
      sk,
      encKey,
      tagKey,
      collectionTag: bytesToHex(hmacSha256(tagKey, utf8ToBytes("contacts-v1"))),
    };
  } finally {
    zeroize(ikm);
  }
}

export function contactSlot(keys: AddressBookKeys, contactId: string): string {
  return bytesToHex(hmacSha256(keys.tagKey, utf8ToBytes(`contact:${contactId}`)));
}

export function newContactId(): string {
  return bytesToHex(randomBytes(16));
}

type Envelope = {
  format: typeof ADDRESS_BOOK_FORMAT;
  encryption: typeof ENCRYPTION;
  nonce_b64u: string;
  ciphertext_b64u: string;
};

function aadFor(slot: string): Uint8Array {
  return utf8ToBytes(
    JSON.stringify({ format: ADDRESS_BOOK_FORMAT, encryption: ENCRYPTION, d: slot }),
  );
}

/**
 * Encrypt and sign one contact (or tombstone) as a replaceable kind-30078
 * event. `createdAt` must move forward per slot or relays keep the old one.
 */
export function sealContact(
  keys: AddressBookKeys,
  contact: Contact,
  createdAt: number,
): NostrEvent {
  const slot = contactSlot(keys, contact.id);
  const nonce = randomBytes(24);
  const plaintext = utf8ToBytes(JSON.stringify(contact));
  try {
    const ciphertext = aeadEncryptX(keys.encKey, nonce, plaintext, aadFor(slot));
    const envelope: Envelope = {
      format: ADDRESS_BOOK_FORMAT,
      encryption: ENCRYPTION,
      nonce_b64u: bytesToBase64url(nonce),
      ciphertext_b64u: bytesToBase64url(ciphertext),
    };
    return signEvent(
      {
        kind: ADDRESS_BOOK_KIND,
        pubkey: keys.pubkey,
        created_at: createdAt,
        tags: [
          ["d", slot],
          ["t", keys.collectionTag],
        ],
        content: JSON.stringify(envelope),
      },
      keys.sk,
    );
  } finally {
    zeroize(plaintext);
  }
}

export type OpenedContact = { slot: string; contact: Contact; event: NostrEvent };

const tagValue = (event: NostrEvent, name: string): string | undefined =>
  event.tags.find((tag) => tag[0] === name)?.[1];

/**
 * Verify and decrypt one event. Returns null for anything that is not a valid
 * address-book record of THIS owner: wrong author, bad signature, wrong tags,
 * tampered ciphertext, a ciphertext moved to another slot, or a contact whose
 * id does not hash to the slot it sits in.
 */
export function openContact(keys: AddressBookKeys, event: NostrEvent): OpenedContact | null {
  if (!event || event.kind !== ADDRESS_BOOK_KIND) return null;
  if (event.pubkey !== keys.pubkey) return null;
  if (!verifyEvent(event)) return null;
  const slot = tagValue(event, "d");
  if (!slot || tagValue(event, "t") !== keys.collectionTag) return null;
  let envelope: Envelope;
  try {
    envelope = JSON.parse(event.content) as Envelope;
  } catch {
    return null;
  }
  if (envelope?.format !== ADDRESS_BOOK_FORMAT || envelope.encryption !== ENCRYPTION) return null;
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = aeadDecryptX(
      keys.encKey,
      base64urlToBytes(envelope.nonce_b64u),
      base64urlToBytes(envelope.ciphertext_b64u),
      aadFor(slot),
    );
  } catch {
    return null;
  }
  if (!plaintext) return null;
  try {
    const contact = parseContact(bytesToUtf8(plaintext));
    if (!contact || contactSlot(keys, contact.id) !== slot) return null;
    return { slot, contact, event };
  } finally {
    zeroize(plaintext);
  }
}
