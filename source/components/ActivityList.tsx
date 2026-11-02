import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImageSourcePropType } from "react-native";

import {
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailingText,
  ListActionTrailingTextMuted,
  ListSeparator,
  Text,
  View,
} from "@ds";
import type { IconName } from "@ds";

import ActivityDetailSheet from "./ActivityDetailSheet";
import { useAddressBookContacts } from "./AddressBookSuggestions";
import { type Contact, isRecipientSaved } from "../lib/addressBook/contact";
import {
  activityContactOf,
  contactHistory,
  contactsByArkScript,
} from "../lib/addressBook/activityPerson";
import { contactRowLabelKey } from "../lib/addressBook/activityContact";
import type { ActivityPerson } from "../lib/activityDetail";
import { arkAddressScript } from "../services/arkade/arkadeCounterparty";
import { useNuriNames } from "../services/arkade/nuriNames";
import { rememberNuriPayment } from "../services/addressBook/nuriContactSync";
import { nuriActivityPayments } from "../lib/addressBook/nuriContacts";
import { nameableAddresses, seenDestination } from "../lib/activityNames";
import { resolvePayRecipient } from "../lib/pay/resolvePayRecipient";
import { createRecipientLookupGate } from "../lib/pay/recipientLookupGate";
import { lookUpSendAgain } from "../lib/activitySendAgain";
import { contactAvatar } from "../lib/addressBook/petAvatar";
import { isValidEvmAddress } from "../lib/validation";
import { EventBus } from "../services/events/AppEventBusService";
import type { SaveOffer } from "../screens/addressBook/addressBookModel";
import type { SwapSides } from "../services/swapkit/swapActivity";
import { getAppLocale, t } from "../lib/i18n";

/**
 * ActivityList: the DS activity rows, grouped into month sections ("Pending"
 * first, then "This month", then month names), with each row's details. The
 * activity sheets (ActivitySheet) and a contact's page in the address book
 * both draw their rows with it. Consumers pass a flat, newest-first item list;
 * grouping is done here. Icon convention: arrow-up = outgoing, plus =
 * incoming, transfer-horizontal = conversion/migration, cross = failed/rejected.
 *
 * Tapping a row opens its details (ActivityDetailSheet): the other side,
 * the amount, date and state, and the row's actions (Send again, the explorer,
 * Add to address book). A row with a live screen of its own (`onOpen`, a swap
 * in progress) opens that instead.
 *
 * The other side reads as a person when it is a saved contact, or a Nuri user
 * the server names for that address (#1708): "From @emin".
 */

export type ActivityItem = {
  key: string;
  icon: IconName;
  label: string;
  sublabel?: string;
  /** Trailing primary amount, already signed/formatted (e.g. "- 12.00 €"). */
  amount?: string;
  /** Trailing secondary line (e.g. the sats or ≈-EUR value). */
  amountSecondary?: string;
  /** The row's own action (the explorer, Send again), listed in its details. */
  onPress?: () => void;
  /** What `onPress` does, as its details list it ("View on Basescan"). */
  onPressLabel?: string;
  /**
   * Pay the same recipient again: opens the send prefilled, never sends. A Nuri
   * user is paid at `recipient`, the address their username has now.
   */
  onSendAgain?: (recipient?: string) => void;
  /** A live screen of the row's own (a swap in progress), opened instead of the details. */
  onOpen?: () => void;
  /**
   * The recipient of an outgoing row. When it is not in the address book yet,
   * tapping the row lists "Add to address book" next to its own action.
   */
  saveOffer?: SaveOffer | null;
  /**
   * Money in (true) or out (false). Required for a saved contact to name the
   * row: in reads "From Emil", out reads "To Emil". Unset keeps the label.
   */
  incoming?: boolean;
  /** The counterpart's mark (a currency flag, Bitcoin, Visa), drawn like a contact's picture. */
  image?: ImageSourcePropType;
  /** Arkade: the other party's output scripts (hex), matched against saved contacts. */
  counterpartyScripts?: string[];
  /** The other party's address (a sender, for money in), matched against saved contacts. */
  counterpartyAddress?: string;
  /** Arkade: the other party's addresses, rebuilt from its scripts, for the names lookup. */
  counterpartyAddresses?: string[];
  /** A swap leg: its details show what was sold and bought, never an address. */
  swap?: SwapSides;
  /** Pending rows sort into a leading "Pending" section. */
  pending?: boolean;
  /** ISO timestamp used for the month grouping. */
  createdAt?: string;
};

type Section = { key: string; label: string; items: ActivityItem[] };

function sectionLabel(date: Date, now: Date): string {
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return t("common.thisMonth");
  }
  return date.toLocaleDateString(getAppLocale(), {
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function buildSections(items: ActivityItem[]): Section[] {
  const sections: Section[] = [];
  const pendingItems = items.filter((item) => item.pending);
  if (pendingItems.length > 0) {
    sections.push({ key: "pending", label: t("common.pending"), items: pendingItems });
  }
  const now = new Date();
  let currentKey = "";
  for (const item of items) {
    if (item.pending) continue;
    const date = item.createdAt ? new Date(item.createdAt) : null;
    const valid = date !== null && !Number.isNaN(date.getTime());
    const monthKey = valid ? `${date.getFullYear()}-${date.getMonth()}` : "unknown";
    if (monthKey !== currentKey || sections.length === 0) {
      currentKey = monthKey;
      sections.push({
        key: `${monthKey}-${sections.length}`,
        label: valid ? sectionLabel(date, now) : "",
        items: [],
      });
    }
    sections[sections.length - 1].items.push(item);
  }
  return sections.filter((section) => section.items.length > 0);
}

/** The other side's EVM address: a Send again looks its Nuri user up. */
function evmOf(item: ActivityItem): string | undefined {
  const address = item.saveOffer?.destination.raw ?? item.counterpartyAddress;
  return address && isValidEvmAddress(address) ? address : undefined;
}

type Props = {
  /** The list is on screen: contacts, names and details load only then. */
  active: boolean;
  /** Flat list, pending-first then newest-first (the consumers' existing order). */
  items: ActivityItem[];
  loading: boolean;
  /** A pull to refresh is running: rows already shown stay, no loading line. */
  refreshing?: boolean;
  error?: string | null;
  emptyText?: string;
  /** No empty line: the list cannot tell there are none (a history was not read). */
  hideEmpty?: boolean;
  /** Only the rows with this contact (#1793), matched the way rows are named. */
  onlyContact?: Pick<Contact, "id" | "nuriUsername"> | null;
};

const ActivityList: React.FC<Props> = ({
  active,
  items,
  loading,
  refreshing = false,
  error,
  emptyText,
  hideEmpty = false,
  onlyContact,
}) => {
  // The row whose details are open.
  const [detailFor, setDetailFor] = useState<ActivityItem | null>(null);
  const contacts = useAddressBookContacts(active);
  const canSave = useCallback(
    (item: ActivityItem) =>
      Boolean(item.saveOffer) &&
      !isRecipientSaved(contacts, (item.saveOffer as SaveOffer).destination),
    [contacts],
  );
  // Saved Arkade addresses by script, to recognise a contact in a payment.
  const contactByScript = useMemo(
    () => contactsByArkScript(contacts, arkAddressScript),
    [contacts],
  );
  // A payment with a saved contact reads as that person: their avatar and name.
  const contactOf = useCallback(
    (item: ActivityItem): Contact | null => activityContactOf(item, contacts, contactByScript),
    [contacts, contactByScript],
  );
  // Addresses of the other sides nobody saved (EVM, Arkade, Bitcoin): the
  // server may know them.
  const unsavedAddresses = useMemo(
    () =>
      items.flatMap((item) =>
        contactOf(item) ? [] : nameableAddresses(item).map((a) => a.toLowerCase()),
      ),
    [items, contactOf],
  );
  const lookupName = useNuriNames(unsavedAddresses, active);
  // The row's Nuri user and the address that named them, if the server knows one.
  const namedOf = useCallback(
    (item: ActivityItem): { address: string; username: string } | null => {
      for (const address of nameableAddresses(item)) {
        const username = lookupName(address.toLowerCase());
        if (username) return { address, username };
      }
      return null;
    },
    [lookupName],
  );
  // A Nuri user the server names joins the address book by themselves, with
  // the addresses of their payments, newest first (#1770). Once saved, the
  // rows read as the contact; a list whose newest payments are saved writes nothing.
  useEffect(() => {
    if (!active) return;
    const rows = items.flatMap((item) => {
      const addresses = nameableAddresses(item);
      if (addresses.length === 0) return [];
      const contact = contactOf(item);
      if (contact) {
        return [{ address: addresses[0], username: contact.nuriUsername ?? null, saved: true }];
      }
      const named = namedOf(item);
      return [
        named
          ? { address: named.address, username: named.username, saved: false }
          : { address: addresses[0], username: null, saved: false },
      ];
    });
    for (const [username, addresses] of nuriActivityPayments(rows)) {
      void rememberNuriPayment(username, addresses.map(seenDestination)).catch(() => {});
    }
  }, [active, items, contactOf, namedOf]);
  // Who the other side is: a saved contact first, else the Nuri user the
  // server names for the address.
  const personOf = useCallback(
    (item: ActivityItem): { person: ActivityPerson; avatar: ImageSourcePropType } | null => {
      const contact = contactOf(item);
      if (contact) {
        return {
          person: { name: contact.label, username: contact.nuriUsername },
          avatar: contactAvatar(contact),
        };
      }
      const username = namedOf(item)?.username;
      return username
        ? {
            person: { name: `@${username}`, username },
            avatar: contactAvatar({ label: username, nuriUsername: username }),
          }
        : null;
    },
    [contactOf, namedOf],
  );
  // Send again to a Nuri user: their username is looked up now, so the send
  // goes to the address it has today, never one saved from this payment.
  // A lookup answers only for the row whose details are still open.
  const [sendAgainBusy, setSendAgainBusy] = useState(false);
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const sendAgainGate = useRef(createRecipientLookupGate());
  const openRowKey = useRef("");
  openRowKey.current = active && detailFor ? detailFor.key : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new row (or none) drops the old lookup
  useEffect(() => {
    sendAgainGate.current.invalidate();
    setSendAgainBusy(false);
    setDetailMessage(null);
  }, [detailFor, active]);
  const sendAgain = useCallback(async (item: ActivityItem, username: string | undefined) => {
    if (!item.onSendAgain) return;
    if (!username || !evmOf(item)) {
      setDetailFor(null);
      item.onSendAgain();
      return;
    }
    setSendAgainBusy(true);
    setDetailMessage(null);
    const result = await lookUpSendAgain({
      username,
      rowKey: item.key,
      openRowKey: () => openRowKey.current,
      gate: sendAgainGate.current,
      resolve: resolvePayRecipient,
      isValidAddress: isValidEvmAddress,
    });
    if (result.kind === "stale") return;
    setSendAgainBusy(false);
    if (result.kind === "go") {
      setDetailFor(null);
      item.onSendAgain(result.address);
    } else {
      setDetailMessage(
        t(
          result.kind === "notFound"
            ? "screen.AddressBook.nuriLookup_notFound"
            : "screen.AddressBook.nuriLookup_failed",
        ),
      );
    }
  }, []);
  const pressRow = useCallback((item: ActivityItem) => {
    if (item.onOpen) item.onOpen();
    else setDetailFor(item);
  }, []);
  const detailPerson = detailFor ? personOf(detailFor) : null;
  // The details belong to this list: closing it closes them too.
  useEffect(() => {
    if (!active) setDetailFor(null);
  }, [active]);
  // One contact's page lists only the rows the activity names after them.
  const shown = useMemo(
    () =>
      onlyContact
        ? contactHistory(items, onlyContact, contactOf, (item) => namedOf(item)?.username ?? null)
        : items,
    [items, onlyContact, contactOf, namedOf],
  );
  const sections = useMemo(() => buildSections(shown), [shown]);

  return (
    <>
      <View direction="column" align="stretch" justify="start" gap="xl" paddingBottom="lg">
        {error ? (
          <View paddingX="lg">
            <Text size="md" emphasis align="center">
              {error}
            </Text>
          </View>
        ) : null}

        {/* Cached rows render immediately; the background fetch fills in
          silently. The loading state only exists for a truly empty feed. */}
        {loading && !refreshing && shown.length === 0 ? (
          <View paddingX="lg" paddingY="md">
            <Text size="md" muted align="center">
              {t("common.loading")}
            </Text>
          </View>
        ) : null}

        {!loading && !hideEmpty && shown.length === 0 && !error ? (
          <View paddingX="lg" paddingY="md">
            <Text size="md" muted align="center">
              {emptyText ?? t("screen.CardTransactionsModal.empty")}
            </Text>
          </View>
        ) : null}

        {sections.map((section) => (
          <View key={section.key} direction="column" align="stretch" justify="start" gap="md">
            {section.label ? (
              <View paddingX="lg">
                <Text size="lg" emphasis>
                  {section.label}
                </Text>
              </View>
            ) : null}
            <List>
              {section.items.map((item, index) => {
                const labelKey = contactRowLabelKey(item.incoming);
                const who = labelKey ? personOf(item) : null;
                const label = who && labelKey ? t(labelKey, { name: who.person.name }) : item.label;
                return (
                  <React.Fragment key={item.key}>
                    {index > 0 ? <ListSeparator /> : null}
                    <ListAction accessibilityLabel={label} onPress={() => pressRow(item)}>
                      {who && !item.pending ? (
                        <ListActionLeadingAvatar source={who.avatar} />
                      ) : item.image && !item.pending ? (
                        <ListActionLeadingAvatar source={item.image} />
                      ) : (
                        <ListActionLeadingAvatar
                          name={item.pending ? "spinner" : item.icon}
                          variant="outline"
                        />
                      )}
                      <ListActionText>{label}</ListActionText>
                      {item.sublabel ? (
                        <ListActionTextMuted>{item.sublabel}</ListActionTextMuted>
                      ) : null}
                      {item.amount ? (
                        <ListActionTrailingText>{item.amount}</ListActionTrailingText>
                      ) : null}
                      {item.amountSecondary ? (
                        <ListActionTrailingTextMuted>
                          {item.amountSecondary}
                        </ListActionTrailingTextMuted>
                      ) : null}
                    </ListAction>
                  </React.Fragment>
                );
              })}
            </List>
          </View>
        ))}
      </View>

      <ActivityDetailSheet
        item={active ? detailFor : null}
        person={detailPerson?.person ?? null}
        avatar={
          detailPerson?.avatar ?? (detailFor?.image && !detailFor.pending ? detailFor.image : null)
        }
        canSave={detailFor ? canSave(detailFor) : false}
        onSave={() => {
          const item = detailFor;
          setDetailFor(null);
          if (!item?.saveOffer) return;
          // A Nuri user found by address is saved under their username.
          const username = detailPerson?.person.username;
          EventBus.emit(
            "addressBook:saveDestination",
            username && !item.saveOffer.name
              ? { ...item.saveOffer, name: username, nuriUsername: username }
              : item.saveOffer,
          );
        }}
        sendAgainBusy={sendAgainBusy}
        message={detailMessage}
        onSendAgain={() => {
          if (detailFor) void sendAgain(detailFor, detailPerson?.person.username);
        }}
        onClose={() => setDetailFor(null)}
      />
    </>
  );
};

export default ActivityList;
