import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ImageSourcePropType, StyleSheet } from "react-native";

import {
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailingText,
  ListActionTrailingTextMuted,
  ListSeparator,
  Text,
  Topbar,
  TopbarLeading,
  TopbarTrailing,
  View,
} from "@ds";
import type { IconName } from "@ds";

import DsSheetHost from "./DsSheetHost";
import ActivityDetailSheet from "./ActivityDetailSheet";
import { useAddressBookContacts } from "./AddressBookSuggestions";
import { type Contact, isRecipientSaved, savedContactFor } from "../lib/addressBook/contact";
import { contactRowLabelKey } from "../lib/addressBook/activityContact";
import type { ActivityPerson } from "../lib/activityDetail";
import { arkAddressScript } from "../services/arkade/arkadeCounterparty";
import { useNuriNames } from "../services/arkade/nuriNames";
import { rememberNuriPayment } from "../services/addressBook/nuriContactSync";
import { evmDestination, nuriActivityPayments } from "../lib/addressBook/nuriContacts";
import { resolvePayRecipient } from "../lib/pay/resolvePayRecipient";
import { createRecipientLookupGate } from "../lib/pay/recipientLookupGate";
import { lookUpSendAgain } from "../lib/activitySendAgain";
import { contactAvatar } from "../lib/addressBook/petAvatar";
import { isValidEvmAddress } from "../lib/validation";
import { EventBus } from "../services/events/AppEventBusService";
import type { SaveOffer } from "../screens/addressBook/addressBookModel";
import type { SwapSides } from "../services/swapkit/swapActivity";
import { getAppLocale, t } from "../lib/i18n";
import PullToRefresh from "./PullToRefresh";

/**
 * ActivitySheet — the DS activity layout: a full-mode modal of transaction
 * rows grouped into month sections ("Pending" first, then "This month", then
 * month names). Consumers pass a flat, newest-first item list; grouping is
 * done here. Icon convention: arrow-up = outgoing, plus = incoming,
 * transfer-horizontal = conversion/migration, cross = failed/rejected.
 *
 * Tapping a row opens its details (ActivityDetailSheet): the other side,
 * the amount, date and state, and the row's actions (Send again, the explorer,
 * Add to address book). A row with a live screen of its own (`onOpen`, a swap
 * in progress) opens that instead.
 *
 * The other side reads as a person when it is a saved contact, or a Nuri user
 * the server names for that address (#1708): "@emin received".
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
   * row: in reads "Emil sent", out "Emil received". Unset keeps the label.
   */
  incoming?: boolean;
  /** The counterpart's mark (a currency flag, Bitcoin, Visa), drawn like a contact's picture. */
  image?: ImageSourcePropType;
  /** Arkade: the other party's output scripts (hex), matched against saved contacts. */
  counterpartyScripts?: string[];
  /** The other party's address (a sender, for money in), matched against saved contacts. */
  counterpartyAddress?: string;
  /** A swap leg: its details show what was sold and bought, never an address. */
  swap?: SwapSides;
  /** Pending rows sort into a leading "Pending" section. */
  pending?: boolean;
  /** ISO timestamp used for the month grouping. */
  createdAt?: string;
};

type Section = { key: string; label: string; items: ActivityItem[] };

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Optional title shown in the topbar. Defaults to no title (close button only). */
  title?: string;
  /** Flat list, pending-first then newest-first (the consumers' existing order). */
  items: ActivityItem[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  /** Renders the download button in the topbar. */
  onExport?: () => void;
  exportDisabled?: boolean;
  error?: string | null;
  emptyText?: string;
};

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

/** The other side's EVM address, the one the Nuri directory can name. */
function evmOf(item: ActivityItem): string | undefined {
  const address = item.saveOffer?.destination.raw ?? item.counterpartyAddress;
  return address && isValidEvmAddress(address) ? address : undefined;
}

const ActivitySheet: React.FC<Props> = ({
  visible,
  onClose,
  title,
  items,
  loading,
  refreshing,
  onRefresh,
  onExport,
  exportDisabled,
  error,
  emptyText,
}) => {
  const sections = useMemo(() => buildSections(items), [items]);
  // The row whose details are open.
  const [detailFor, setDetailFor] = useState<ActivityItem | null>(null);
  const contacts = useAddressBookContacts(visible);
  const canSave = useCallback(
    (item: ActivityItem) =>
      Boolean(item.saveOffer) &&
      !isRecipientSaved(contacts, (item.saveOffer as SaveOffer).destination),
    [contacts],
  );
  // Saved Arkade addresses by script, to recognise a contact in a payment.
  const contactByScript = useMemo(() => {
    const map = new Map<string, Contact>();
    for (const contact of contacts) {
      if (contact.deleted) continue;
      for (const d of contact.destinations) {
        if (d.type !== "crypto" || d.network !== "ark") continue;
        const script = arkAddressScript(d.raw);
        if (script && !map.has(script)) map.set(script, contact);
      }
    }
    return map;
  }, [contacts]);
  // A payment with a saved contact reads as that person: their avatar and name.
  const contactOf = useCallback(
    (item: ActivityItem): Contact | null => {
      for (const script of item.counterpartyScripts ?? []) {
        const contact = contactByScript.get(script.toLowerCase());
        if (contact) return contact;
      }
      const address = item.saveOffer?.destination.raw ?? item.counterpartyAddress;
      return address ? savedContactFor(contacts, address, () => true) : null;
    },
    [contacts, contactByScript],
  );
  // EVM addresses of the other sides nobody saved: the server may know them.
  const unsavedAddresses = useMemo(
    () =>
      items.flatMap((item) => {
        const address = evmOf(item);
        return address && !contactOf(item) ? [address.toLowerCase()] : [];
      }),
    [items, contactOf],
  );
  const nameOf = useNuriNames(unsavedAddresses, visible);
  // A Nuri user the server names joins the address book by themselves, with
  // the addresses of their payments, newest first (#1770). Once saved, the
  // rows read as the contact; a list whose newest payments are saved writes nothing.
  useEffect(() => {
    if (!visible) return;
    const rows = items.flatMap((item) => {
      const address = evmOf(item);
      if (!address) return [];
      const contact = contactOf(item);
      const username = contact ? (contact.nuriUsername ?? null) : nameOf(address);
      return [{ address, username, saved: contact !== null }];
    });
    for (const [username, addresses] of nuriActivityPayments(rows)) {
      void rememberNuriPayment(username, addresses.map(evmDestination)).catch(() => {});
    }
  }, [visible, items, contactOf, nameOf]);
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
      const username = nameOf(evmOf(item));
      return username
        ? {
            person: { name: `@${username}`, username },
            avatar: contactAvatar({ label: username, nuriUsername: username }),
          }
        : null;
    },
    [contactOf, nameOf],
  );
  // Send again to a Nuri user: their username is looked up now, so the send
  // goes to the address it has today, never one saved from this payment.
  // A lookup answers only for the row whose details are still open.
  const [sendAgainBusy, setSendAgainBusy] = useState(false);
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const sendAgainGate = useRef(createRecipientLookupGate());
  const openRowKey = useRef("");
  openRowKey.current = visible && detailFor ? detailFor.key : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new row (or none) drops the old lookup
  useEffect(() => {
    sendAgainGate.current.invalidate();
    setSendAgainBusy(false);
    setDetailMessage(null);
  }, [detailFor, visible]);
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
    if (!visible) setDetailFor(null);
  }, [visible]);

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          {title ? (
            <TopbarLeading>
              <Text size="lg" emphasis>
                {title}
              </Text>
            </TopbarLeading>
          ) : null}
          <TopbarTrailing>
            {onExport ? (
              <IconButton
                icon="download"
                variant="soft"
                disabled={exportDisabled}
                accessibilityLabel={t("common.exportCsv")}
                onPress={onExport}
              />
            ) : null}
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>

      {/* One cross-platform pull-to-refresh (native + web, DS spinner). It takes
          the box the header leaves over, so it scrolls inside it. */}
      <PullToRefresh
        refreshing={refreshing}
        onRefresh={onRefresh}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
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
          {loading && !refreshing && items.length === 0 ? (
            <View paddingX="lg" paddingY="md">
              <Text size="md" muted align="center">
                {t("common.loading")}
              </Text>
            </View>
          ) : null}

          {!loading && items.length === 0 && !error ? (
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
                  const label =
                    who && labelKey ? t(labelKey, { name: who.person.name }) : item.label;
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
      </PullToRefresh>

      <ActivityDetailSheet
        item={visible ? detailFor : null}
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
    </DsSheetHost>
  );
};

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingBottom: 32,
  },
});

export default ActivitySheet;
