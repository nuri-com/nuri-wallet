// Relay transport for the address book: the app's own relay helpers over the
// default relay set (Nuri's relay first, public relays as redundancy).
import { DEFAULT_NOSTR_RELAYS } from "../../config/endpoints";
import { fetchNostrEventsFromRelay, sendNostrEventToRelay } from "../nostr/relayPublish";
import type { AddressBookTransport } from "./AddressBook";

const TIMEOUT_MS = 10_000;

export function relayTransport(relays: string[] = DEFAULT_NOSTR_RELAYS): AddressBookTransport {
  return {
    relays: Array.from(new Set(relays.map((r) => r.trim()).filter(Boolean))),
    async publish(relay, event) {
      return (await sendNostrEventToRelay(relay, event, TIMEOUT_MS)).ackedOk;
    },
    fetch(relay, filter) {
      return fetchNostrEventsFromRelay(relay, filter, TIMEOUT_MS);
    },
  };
}
