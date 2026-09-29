import { DEFAULT_NOSTR_RELAYS } from "../../config/endpoints";
import { bytesToHex, schnorr } from "../../lib/crypto";
import { signEvent, type NostrEvent } from "../../lib/nostr/nostr";
import { publishNostrEventToRelays } from "../../lib/nostr/relayPublish";

// NIP-17 requires every DM recipient to publish a kind 10050 DM-relay-list
// event; spec-compliant senders (Amethyst, rust-nostr clients like Coop)
// REFUSE to send to an npub without one. Kind 10050 is replaceable, so
// republishing simply refreshes the same record. We declare the relays our
// unread sync and chat actually read from, and publish the event to that same
// set so senders can discover it wherever they look us up.
const DM_RELAY_LIST_KIND = 10050;
const RELAY_URLS = [
  String(process.env.EXPO_PUBLIC_NOSTR_BACKUP_RELAY || "").trim(),
  ...DEFAULT_NOSTR_RELAYS,
].filter(Boolean);
const RELAY_TIMEOUT_MS = 8_000;

// ponytail: once per app session is enough for a replaceable event; the next
// launch republishes, so a lost event self-heals within a day of normal use.
let publishedForPubkey: string | null = null;

/**
 * Publish our kind 10050 DM relay list so third-party NIP-17 clients can (and
 * will) send DMs to this identity. Idempotent per session, fire-and-forget
 * safe, never throws.
 */
export async function ensureDmRelayListPublished(sk: Uint8Array): Promise<void> {
  try {
    const pubkey = bytesToHex(schnorr.getPublicKey(sk));
    if (publishedForPubkey === pubkey) return;
    const unsigned: NostrEvent = {
      kind: DM_RELAY_LIST_KIND,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: RELAY_URLS.map((url) => ["relay", url]),
      content: "",
    };
    const result = await publishNostrEventToRelays(
      RELAY_URLS,
      signEvent(unsigned, sk),
      RELAY_TIMEOUT_MS,
    );
    if (result.ackedOk > 0) {
      publishedForPubkey = pubkey;
    }
    console.log(
      `[NostrDmRelayListService] published kind ${DM_RELAY_LIST_KIND} relays=${RELAY_URLS.length} acked=${result.ackedOk}/${result.tried}`,
    );
  } catch (error) {
    console.log(
      `[NostrDmRelayListService] publish failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
