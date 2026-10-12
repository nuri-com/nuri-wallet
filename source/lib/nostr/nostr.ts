import { bech32 } from "@scure/base";
import { cbc } from "@noble/ciphers/aes";
import { chacha20 } from "@noble/ciphers/chacha";
import { hmac } from "@noble/hashes/hmac";
import { sha256 as sha256Hash } from "@noble/hashes/sha2";
import {
  aeadDecryptX,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  bytesToUtf8,
  hexToBytes,
  hkdfSha256,
  randomBytes,
  secp256k1,
  sha256,
  schnorr,
  utf8ToBytes,
  zeroize,
} from "../crypto";
import {
  getPrivateKey,
  getNostrPrivateKey,
  hasNostrPrivateKey,
  storeNostrPrivateKey,
} from "../secureKeyStorage";
import { deriveNostrPrivateKeyFromBitcoinKey } from "../walletDerivation";

export type NostrKeypair = {
  sk: Uint8Array;
  pkHex: string;
  npub: string;
};

import { getEventHash, type NostrEvent, signEvent, verifyEvent } from "./event";

export { getEventHash, type NostrEvent, signEvent, verifyEvent };

const NIP44_INFO = utf8ToBytes("nip44-v2");
const NIP44_EMPTY_SALT = new Uint8Array(0);
const NIP44_V2_SALT = utf8ToBytes("nip44-v2");

const KIND_DM = 4;
const KIND_RUMOR = 14;
const KIND_SEAL = 13;
const KIND_GIFT_WRAP = 1059;

function toStandardBase64(value: string): string {
  const base = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = base.length % 4 === 0 ? 0 : 4 - (base.length % 4);
  return base + "=".repeat(pad);
}

function toBase64Url(value: string): string {
  return String(value || "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Derive the wallet's Nostr identity straight from a Bitcoin private key held
 * in memory, bypassing secure storage entirely. Same derivation as
 * getOrCreateNostrKeypair's Bitcoin branch, so it yields the SAME npub — the
 * support thread is continuous. Used on the blocked-restore path, where the
 * wallet keys are never persisted to the keychain. The caller owns `sk` and
 * must zeroize it.
 */
export function deriveNostrKeypairFromBitcoinKey(btcKey: Uint8Array): NostrKeypair {
  const sk = deriveNostrPrivateKeyFromBitcoinKey(btcKey);
  const pkHex = bytesToHex(schnorr.getPublicKey(sk));
  return { sk, pkHex, npub: toNpub(pkHex) };
}

export function normalizeNostrPubkey(value: string): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(lower)) return lower;
  if (lower.startsWith("npub")) {
    try {
      const decoded = bech32.decode(lower as `${string}1${string}`);
      if (decoded.prefix !== "npub") return null;
      const bytes = bech32.fromWords(decoded.words);
      if (bytes.length !== 32) return null;
      return bytesToHex(bytes);
    } catch {
      return null;
    }
  }
  return null;
}

export function toNpub(pubkeyHex: string): string {
  const bytes = hexToBytes(pubkeyHex);
  return bech32.encode("npub", bech32.toWords(bytes));
}

export async function getOrCreateNostrKeypair(): Promise<NostrKeypair> {
  let sk: Uint8Array | null = null;

  if (await hasNostrPrivateKey()) {
    sk = await getNostrPrivateKey();
  } else {
    const btcKey = await getPrivateKey("bitcoin");
    let derived: Uint8Array;
    try {
      derived = deriveNostrPrivateKeyFromBitcoinKey(btcKey);
    } finally {
      zeroize(btcKey);
    }
    try {
      await storeNostrPrivateKey(derived);
    } catch (error) {
      zeroize(derived);
      throw error;
    }
    sk = derived;
  }

  const pkBytes = schnorr.getPublicKey(sk);
  const pkHex = bytesToHex(pkBytes);
  return { sk, pkHex, npub: toNpub(pkHex) };
}

function sharedSecretKey(sk: Uint8Array, pubkeyHex: string): Uint8Array {
  const pubkey = hexToBytes(pubkeyHex);
  const isXOnly = pubkey.length === 32;
  const candidates = isXOnly
    ? [new Uint8Array([0x02, ...pubkey]), new Uint8Array([0x03, ...pubkey])]
    : [pubkey];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return secp256k1.getSharedSecret(sk, candidate, true);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("Invalid public key");
}

export function nip04Encrypt(
  sk: Uint8Array,
  recipientPubkeyHex: string,
  plaintext: string,
): string {
  const key = sharedSecretKey(sk, recipientPubkeyHex).slice(1, 33);
  const iv = randomBytes(16);
  const cipher = cbc(key, iv);
  const ciphertext = cipher.encrypt(utf8ToBytes(plaintext));
  const ct = toStandardBase64(bytesToBase64url(ciphertext));
  const ivB64 = toStandardBase64(bytesToBase64url(iv));
  return `${ct}?iv=${ivB64}`;
}

export function nip04Decrypt(sk: Uint8Array, senderPubkeyHex: string, content: string): string {
  const parts = content.split("?iv=");
  if (parts.length !== 2) {
    throw new Error("Invalid NIP-04 payload");
  }
  const ciphertext = base64urlToBytes(toBase64Url(parts[0]));
  const iv = base64urlToBytes(toBase64Url(parts[1]));
  const key = sharedSecretKey(sk, senderPubkeyHex).slice(1, 33);
  const cipher = cbc(key, iv);
  const plaintext = cipher.decrypt(ciphertext);
  return bytesToUtf8(plaintext);
}

function randomizedTimestamp(): number {
  const skewPastSec = 30 + Math.floor(Math.random() * 871); // 30..900s in the past
  return Math.floor(Date.now() / 1000) - skewPastSec;
}

function deriveLegacyNip44Key(sharedSecret: Uint8Array, legacy = false): Uint8Array {
  if (legacy) {
    return hkdfSha256(sharedSecret, NIP44_EMPTY_SALT, NIP44_INFO, 32);
  }
  const xOnly = sharedSecret.length === 33 ? sharedSecret.slice(1) : sharedSecret;
  const ikm = sha256(xOnly);
  return hkdfSha256(ikm, NIP44_EMPTY_SALT, NIP44_INFO, 32);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function hkdfExpandFromPrk(prk: Uint8Array, info: Uint8Array, outputLength: number): Uint8Array {
  const out = new Uint8Array(outputLength);
  let generated = 0;
  let block = new Uint8Array(0);
  let round = 1;
  while (generated < outputLength) {
    const roundInput = new Uint8Array(block.length + info.length + 1);
    roundInput.set(block, 0);
    roundInput.set(info, block.length);
    roundInput[roundInput.length - 1] = round;
    block = new Uint8Array(hmac(sha256Hash, prk, roundInput));
    const take = Math.min(block.length, outputLength - generated);
    out.set(block.slice(0, take), generated);
    generated += take;
    round += 1;
  }
  return out;
}

function calcNip44PaddedLen(length: number): number {
  if (length < 1) {
    throw new Error("Invalid NIP-44 plaintext length");
  }
  if (length <= 32) return 32;
  const nextPower = 1 << Math.ceil(Math.log2(length));
  const chunk = nextPower <= 256 ? 32 : Math.floor(nextPower / 8);
  return chunk * (Math.floor((length - 1) / chunk) + 1);
}

function writeU16BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("Invalid NIP-44 plaintext size");
  }
  const out = new Uint8Array(2);
  out[0] = (value >>> 8) & 0xff;
  out[1] = value & 0xff;
  return out;
}

function nip44Pad(plaintext: string): Uint8Array {
  const bytes = utf8ToBytes(plaintext);
  const prefix = writeU16BE(bytes.length);
  const suffix = new Uint8Array(calcNip44PaddedLen(bytes.length) - bytes.length);
  return concatBytes(prefix, bytes, suffix);
}

function nip44Unpad(padded: Uint8Array): string {
  if (padded.length < 2) {
    throw new Error("Invalid NIP-44 padding");
  }
  const declaredLen = (padded[0] << 8) | padded[1];
  if (declaredLen < 1 || declaredLen > 65535) {
    throw new Error("Invalid NIP-44 plaintext length");
  }
  const expectedTotal = 2 + calcNip44PaddedLen(declaredLen);
  if (padded.length !== expectedTotal) {
    throw new Error("Invalid NIP-44 padding");
  }
  const content = padded.slice(2, 2 + declaredLen);
  if (content.length !== declaredLen) {
    throw new Error("Invalid NIP-44 plaintext length");
  }
  return bytesToUtf8(content);
}

function deriveNip44ConversationKey(sharedSecret: Uint8Array): Uint8Array {
  const xOnly = sharedSecret.length === 33 ? sharedSecret.slice(1) : sharedSecret;
  return new Uint8Array(hmac(sha256Hash, NIP44_V2_SALT, xOnly));
}

function deriveNip44MessageKeys(conversationKey: Uint8Array, nonce: Uint8Array) {
  if (conversationKey.length !== 32 || nonce.length !== 32) {
    throw new Error("Invalid NIP-44 key material");
  }
  const keys = hkdfExpandFromPrk(conversationKey, nonce, 76);
  return {
    chachaKey: keys.slice(0, 32),
    chachaNonce: keys.slice(32, 44),
    hmacKey: keys.slice(44, 76),
  };
}

function nip44HmacAad(key: Uint8Array, message: Uint8Array, aad: Uint8Array): Uint8Array {
  if (aad.length !== 32) {
    throw new Error("Invalid NIP-44 AAD");
  }
  return new Uint8Array(hmac(sha256Hash, key, concatBytes(aad, message)));
}

function nip44DecryptLegacy(
  ciphertext: string,
  senderPubkeyHex: string,
  recipientSk: Uint8Array,
): string {
  const rawPayload = ciphertext.startsWith("v2:") ? ciphertext.slice(3) : ciphertext;
  const payload = base64urlToBytes(toBase64Url(rawPayload));
  if (payload.length <= 40) {
    throw new Error("Invalid NIP-44 payload");
  }
  const nonce = payload.slice(0, 24);
  const ct = payload.slice(24);
  const shared = sharedSecretKey(recipientSk, senderPubkeyHex);
  const key = deriveLegacyNip44Key(shared);
  const plaintext = aeadDecryptX(key, nonce, ct);
  if (plaintext) {
    return bytesToUtf8(plaintext);
  }
  const legacyKey = deriveLegacyNip44Key(shared, true);
  const legacyPlaintext = aeadDecryptX(legacyKey, nonce, ct);
  if (!legacyPlaintext) {
    throw new Error("NIP-44 decrypt failed");
  }
  return bytesToUtf8(legacyPlaintext);
}

function nip44DecryptV2Payload(
  payloadBase64: string,
  senderPubkeyHex: string,
  recipientSk: Uint8Array,
): string {
  const payload = base64urlToBytes(toBase64Url(payloadBase64));
  if (payload.length < 99 || payload.length > 65603) {
    throw new Error("Invalid NIP-44 payload");
  }
  const version = payload[0];
  if (version !== 2) {
    throw new Error(`Invalid NIP-44 version ${version}`);
  }
  const nonce = payload.slice(1, 33);
  const ct = payload.slice(33, payload.length - 32);
  const mac = payload.slice(payload.length - 32);
  const shared = sharedSecretKey(recipientSk, senderPubkeyHex);
  const conversationKey = deriveNip44ConversationKey(shared);
  const keys = deriveNip44MessageKeys(conversationKey, nonce);
  const expectedMac = nip44HmacAad(keys.hmacKey, ct, nonce);
  if (!timingSafeEqual(expectedMac, mac)) {
    throw new Error("Invalid NIP-44 MAC");
  }
  const padded = chacha20(keys.chachaKey, keys.chachaNonce, ct);
  return nip44Unpad(padded);
}

export function nip44Encrypt(
  plaintext: string,
  recipientPubkeyHex: string,
  senderSk: Uint8Array,
): string {
  const shared = sharedSecretKey(senderSk, recipientPubkeyHex);
  const conversationKey = deriveNip44ConversationKey(shared);
  const nonce = randomBytes(32);
  const keys = deriveNip44MessageKeys(conversationKey, nonce);
  const padded = nip44Pad(plaintext);
  const ciphertext = chacha20(keys.chachaKey, keys.chachaNonce, padded);
  const mac = nip44HmacAad(keys.hmacKey, ciphertext, nonce);
  const payload = concatBytes(Uint8Array.from([2]), nonce, ciphertext, mac);
  return toStandardBase64(bytesToBase64url(payload));
}

export function nip44Decrypt(
  ciphertext: string,
  senderPubkeyHex: string,
  recipientSk: Uint8Array,
): string {
  const raw = String(ciphertext || "").trim();
  if (!raw) {
    throw new Error("Invalid NIP-44 payload");
  }
  const payload = raw.startsWith("v2:") ? raw.slice(3) : raw;
  try {
    return nip44DecryptV2Payload(payload, senderPubkeyHex, recipientSk);
  } catch (v2Error) {
    if (!raw.startsWith("v2:")) {
      throw v2Error;
    }
    return nip44DecryptLegacy(raw, senderPubkeyHex, recipientSk);
  }
}

export function createNip17GiftWrap(
  content: string,
  recipientPubkeyHex: string,
  senderSk: Uint8Array,
  senderEmail?: string,
): NostrEvent {
  const senderPubkeyHex = bytesToHex(schnorr.getPublicKey(senderSk));
  const rumorTags: string[][] = [];
  rumorTags.push(["p", recipientPubkeyHex]);
  if (senderEmail) {
    rumorTags.push(["email", senderEmail]);
  }
  const rumorUnsigned: NostrEvent = {
    kind: KIND_RUMOR,
    pubkey: senderPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: rumorTags,
    content,
  };
  const rumorWithId: NostrEvent = {
    ...rumorUnsigned,
    id: getEventHash(rumorUnsigned),
    sig: "",
  };
  const sealContent = nip44Encrypt(JSON.stringify(rumorWithId), recipientPubkeyHex, senderSk);
  const sealUnsigned: NostrEvent = {
    kind: KIND_SEAL,
    pubkey: senderPubkeyHex,
    created_at: randomizedTimestamp(),
    tags: [],
    content: sealContent,
  };
  const seal = signEvent(sealUnsigned, senderSk);

  const wrapKey = secp256k1.utils.randomSecretKey();
  const wrapPubkey = bytesToHex(schnorr.getPublicKey(wrapKey));
  const wrapContent = nip44Encrypt(JSON.stringify(seal), recipientPubkeyHex, wrapKey);
  const wrapUnsigned: NostrEvent = {
    kind: KIND_GIFT_WRAP,
    pubkey: wrapPubkey,
    created_at: randomizedTimestamp(),
    tags: [["p", recipientPubkeyHex]],
    content: wrapContent,
  };
  const giftWrap = signEvent(wrapUnsigned, wrapKey);

  zeroize(wrapKey);

  return giftWrap;
}

export function createNip04DirectMessage(
  content: string,
  recipientPubkeyHex: string,
  senderSk: Uint8Array,
  senderEmail?: string,
): NostrEvent {
  const senderPubkeyHex = bytesToHex(schnorr.getPublicKey(senderSk));
  const encrypted = nip04Encrypt(senderSk, recipientPubkeyHex, content);
  const tags: string[][] = [["p", recipientPubkeyHex]];
  if (senderEmail) {
    tags.push(["email", senderEmail]);
  }
  const dmUnsigned: NostrEvent = {
    kind: KIND_DM,
    pubkey: senderPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encrypted,
  };
  return signEvent(dmUnsigned, senderSk);
}

export function openNip04DirectMessage(
  event: NostrEvent,
  recipientSk: Uint8Array,
): { content: string; senderPubkey: string; createdAt: number; senderEmail?: string } {
  if (!event || event.kind !== KIND_DM) {
    throw new Error("Invalid DM kind");
  }
  if (!verifyEvent(event)) {
    throw new Error("DM signature invalid");
  }
  const senderEmail = Array.isArray(event.tags)
    ? event.tags.find((tag) => tag[0] === "email")?.[1]
    : undefined;
  return {
    content: nip04Decrypt(recipientSk, event.pubkey, event.content),
    senderPubkey: String(event.pubkey || "").toLowerCase(),
    createdAt: Number(event.created_at || 0),
    senderEmail: senderEmail ? String(senderEmail).trim() : undefined,
  };
}

export function openNip17GiftWrap(
  giftWrap: NostrEvent,
  recipientSk: Uint8Array,
): { content: string; senderPubkey: string; createdAt: number; senderEmail?: string } {
  const sealJson = nip44Decrypt(giftWrap.content, giftWrap.pubkey, recipientSk);
  const seal = JSON.parse(sealJson) as NostrEvent;
  if (seal.kind !== KIND_SEAL) {
    throw new Error("Invalid seal kind");
  }
  if (!verifyEvent(seal)) {
    throw new Error("Seal signature invalid");
  }
  const rumorJson = nip44Decrypt(seal.content, seal.pubkey, recipientSk);
  const rumor = JSON.parse(rumorJson) as NostrEvent;
  if (rumor.kind !== KIND_RUMOR) {
    throw new Error("Invalid rumor kind");
  }
  const rumorHasSig = typeof rumor.sig === "string" && rumor.sig.length > 0;
  if (rumorHasSig && !verifyEvent(rumor)) {
    throw new Error("Rumor signature invalid");
  }
  const senderPubkey = String(rumor.pubkey || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(senderPubkey)) {
    throw new Error("Rumor sender invalid");
  }
  if (
    senderPubkey !==
    String(seal.pubkey || "")
      .trim()
      .toLowerCase()
  ) {
    throw new Error("Seal and rumor sender mismatch");
  }
  const senderEmail = Array.isArray(rumor.tags)
    ? rumor.tags.find((tag) => tag[0] === "email")?.[1]
    : undefined;
  const createdAtRumor = Number(rumor.created_at || 0);
  const createdAtSeal = Number((seal as any)?.created_at || 0);
  const createdAt =
    Number.isFinite(createdAtRumor) && createdAtRumor > 0 ? createdAtRumor : createdAtSeal;
  return {
    content: rumor.content,
    senderPubkey,
    createdAt,
    senderEmail: senderEmail ? String(senderEmail).trim() : undefined,
  };
}

export const NOSTR_KINDS = {
  DM: KIND_DM,
  RUMOR: KIND_RUMOR,
  SEAL: KIND_SEAL,
  GIFT_WRAP: KIND_GIFT_WRAP,
};
