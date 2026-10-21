// Address-book suggestions under a send screen's recipient field.
//
// While the user types, saved destinations that match (by contact name, note or
// a fragment of the address/IBAN) show as a list right below the field; a tap
// fills the field. An empty field lists every contact the screen can pay, for a
// quick pick. Nothing matching (or a field that already holds exactly a saved
// destination) renders nothing, no empty dropdown.
//
// Contacts are read from the local, already-decrypted cache on open; this never
// waits for relays.
import { useEffect, useMemo, useState } from "react";
import {
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
} from "@ds";
import {
  type Contact,
  type Destination,
  type DestinationSuggestion,
  payableContacts,
  suggestDestinations,
} from "../lib/addressBook/contact";
import { contactAvatar } from "../lib/addressBook/petAvatar";
import { EventBus } from "../services/events/AppEventBusService";
import { destinationHint } from "../screens/addressBook/addressBookModel";
import {
  getAddressBook,
  lastAddressBookContacts,
  rememberAddressBookContacts,
} from "../services/addressBook/AddressBookService";

/** Emitted after any local address-book change so open send screens re-read it. */
export const ADDRESS_BOOK_CHANGED_EVENT = "addressBook:changed";

/**
 * The saved contacts. Starts from the in-memory list (no wait at all once any
 * screen has read it), then the book's local copy, which never waits behind a
 * relay sync, then every change the book reports.
 */
export function useAddressBookContacts(active: boolean): Contact[] {
  const [contacts, setContacts] = useState<Contact[]>(lastAddressBookContacts);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    const show = (list: Contact[]) => {
      rememberAddressBookContacts(list);
      if (!cancelled) setContacts(list);
    };
    void getAddressBook()
      .then(async (book) => {
        if (cancelled) return;
        const ready = book.peek();
        if (ready) show(ready);
        unsubscribe = book.subscribe(show);
        if (!ready) show(await book.current());
      })
      .catch(() => {});
    // Screens that edit the book outside it (e.g. through the CLI import path)
    // still announce changes on the event bus.
    const off = EventBus.on(ADDRESS_BOOK_CHANGED_EVENT, () => {
      void getAddressBook()
        .then((book) => book.current())
        .then(show)
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      off();
    };
  }, [active]);
  return contacts;
}

type Props = {
  /** Mounted only while the recipient field is on screen. */
  active: boolean;
  query: string;
  /** Which saved destinations this screen can pay. */
  accepts: (destination: Destination) => boolean;
  /** Cost of a destination from this screen; set to show each contact once, at its cheapest. */
  cost?: (destination: Destination) => number;
  /**
   * This screen pays a Nuri username (looked up when the send continues): a
   * Nuri contact is offered as their username, never a saved address.
   */
  payUsername?: boolean;
  onPick: (suggestion: DestinationSuggestion) => void;
};

export default function AddressBookSuggestions({
  active,
  query,
  accepts,
  cost,
  payUsername = false,
  onPick,
}: Props) {
  const contacts = useAddressBookContacts(active);
  const suggestions = useMemo(() => {
    if (!active) return [];
    if (!query.trim()) return payableContacts(contacts, accepts, cost, payUsername);
    return suggestDestinations(contacts, query, accepts, 5, cost, payUsername);
  }, [active, contacts, query, accepts, cost, payUsername]);
  if (suggestions.length === 0) return null;
  return (
    <List>
      {suggestions.map((suggestion) => {
        const hint = suggestion.username
          ? `@${suggestion.username}`
          : destinationHint(suggestion.destination);
        return (
          <ListAction
            key={`${suggestion.contact.id}-${suggestion.index}`}
            accessibilityLabel={`${suggestion.contact.label}, ${hint}`}
            onPress={() => onPick(suggestion)}
          >
            <ListActionLeadingAvatar source={contactAvatar(suggestion.contact)} />
            <ListActionText>{suggestion.contact.label}</ListActionText>
            <ListActionTextMuted>{hint}</ListActionTextMuted>
          </ListAction>
        );
      })}
    </List>
  );
}
