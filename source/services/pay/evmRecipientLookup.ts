// The lookups behind lib/send/evmRecipientCheck (#1783): which Nuri user a
// plain `0x...` belongs to, asked now, and that user's addresses now.
import type { Contact } from "../../lib/addressBook/contact";
import type { EvmRecipientLookup } from "../../lib/send/evmRecipientCheck";
import { recipientFromContact } from "../../lib/send/sendRouting";
import { resolvePayRecipient } from "../../lib/pay/resolvePayRecipient";
import { destinationsFromNuriUser } from "../../screens/addressBook/addressBookModel";
import { arkadeLnurlNames } from "../arkade/ArkadeApiService";
import { getArkadeLnurlAssertion } from "../arkade/internal/identity";

export function evmRecipientLookup(contacts: Contact[]): EvmRecipientLookup {
  return {
    // A send decides on the answer, so it is never the cached label answer,
    // and the login may be asked for when none is cached.
    usernames: async (addresses) => {
      // A saved Nuri contact's address is theirs without asking.
      const known: Record<string, string | null> = {};
      for (const address of addresses) {
        const contact = contacts.find(
          (c) =>
            !c.deleted &&
            c.nuriUsername &&
            c.destinations.some((d) => d.raw.trim().toLowerCase() === address),
        );
        if (contact?.nuriUsername) known[address] = contact.nuriUsername.toLowerCase();
      }
      const unknown = addresses.filter((address) => !(address in known));
      if (unknown.length === 0) return known;
      const assertion = await getArkadeLnurlAssertion("lnurl_names_send", true);
      if (!assertion) throw new Error("names lookup: no login");
      const { names } = await arkadeLnurlNames(assertion, unknown);
      if (!names) throw new Error("names lookup: no answer");
      return { ...names, ...known };
    },
    nuriUser: async (username) => {
      const rails = await resolvePayRecipient(username);
      const destinations = rails ? destinationsFromNuriUser(rails) : [];
      if (destinations.length === 0) return null;
      const saved = contacts.find(
        (contact) => !contact.deleted && contact.nuriUsername?.toLowerCase() === username,
      );
      return saved
        ? { ...recipientFromContact(saved), destinations }
        : { destinations, person: { name: username, nuriUsername: username } };
    },
  };
}
