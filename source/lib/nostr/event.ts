// Nostr event primitives (NIP-01): type, id hash, sign, verify. Dependency-free
// apart from the crypto module so non-React-Native code (the address book core
// and its CLI/MCP) can import it; lib/nostr/nostr.ts re-exports all of it.
import { bytesToHex, hexToBytes, schnorr, sha256, utf8ToBytes } from "../crypto/index";

export type NostrEvent = {
  id?: string;
  sig?: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
};

function serializeEvent(event: NostrEvent): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

export function getEventHash(event: NostrEvent): string {
  const payload = utf8ToBytes(serializeEvent(event));
  return bytesToHex(sha256(payload));
}

export function signEvent(event: NostrEvent, sk: Uint8Array): NostrEvent {
  const id = getEventHash(event);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk));
  return { ...event, id, sig };
}

export function verifyEvent(event: NostrEvent): boolean {
  if (!event?.sig || !event?.pubkey) return false;
  const id = getEventHash(event);
  if (event.id && event.id !== id) return false;
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}
