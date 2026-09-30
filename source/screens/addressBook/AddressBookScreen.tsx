// @screen app.address-book
// Address book — saved payment recipients, end-to-end encrypted and synced
// across the user's devices through Nostr relays (lib/addressBook).
//
// Opened from Settings. A contact's destination hands off to the SAME send
// flows a scanned code reaches (onPay → the home's handlers); nothing here
// sends money or builds a second send path. Phone and email are stored but
// have no payment rail yet, which the detail view says.
//
// Rendered as its own Layer like Settings; the add/edit form and the contact
// detail are full-page DsSheetHosts above it.
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Button,
  ButtonIcon,
  ButtonText,
  Footer,
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  Separator,
  SelectField,
  SelectFieldAvatar,
  SelectFieldChevron,
  SelectFieldLabel,
  SelectFieldValue,
  ListActionTrailIcon,
  NuriSafeAreaProvider,
  Screen,
  Scroll,
  Text,
  TextField,
  TextFieldButton,
  TextFieldLabel,
  Topbar,
  TopbarLeading,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import ChoiceSheet from "../../components/ChoiceSheet";
import DsSheetHost from "../../components/DsSheetHost";
import { Layer } from "../../components/LayerHost";
import type { AddressBook, ContactConflict, SyncReport } from "../../lib/addressBook/AddressBook";
import {
  type Contact,
  type Destination,
  contactMatches,
  destinationKey,
  MAX_DESTINATIONS,
} from "../../lib/addressBook/contact";
import { ADDRESS_BOOK_CHANGED_EVENT } from "../../components/AddressBookSuggestions";
import { EventBus } from "../../services/events/AppEventBusService";
import { KIND_IMAGE } from "../../lib/addressBook/kindImages";
import { avatarSeed, contactAvatar } from "../../lib/addressBook/petAvatar";
import { initialOf } from "../../lib/addressBook/initial";
import { copyToClipboard } from "../../lib/copyToClipboard";
import { t } from "../../lib/i18n";
import { toNuriUsername } from "../../lib/pay/nuriUsername";
import { resolvePayRecipient } from "../../lib/pay/resolvePayRecipient";
import type { IconName } from "@ds";
import {
  DESTINATION_KINDS,
  type DestinationKind,
  applyNuriLookup,
  kindOf,
  withKind,
  destinationLabel,
  destinationValue,
  groupByInitial,
  type DraftDestination,
  destinationSummary,
  destinationsFromDraft,
  draftFieldsFor,
  emptyDraftDestination,
  routeDestination,
  type SaveOffer,
  type SendRoute,
} from "./addressBookModel";

const K = "screen.AddressBook";

// Picker glyphs, same accent convention as the app's rail pickers:
// orange = bitcoin, lilac = EVM wallet / bank, neutral = other.
const KIND_ICON: Record<DestinationKind, IconName> = {
  lightning: "lightning",
  evm: "wallet",
  "base-usdc": "wallet",
  "base-eurc": "euro-wallet",
  bank: "bank",
  ark: "bitcoin-wallet",
  bitcoin: "bitcoin",
  phone: "headphones",
  email: "share",
  other: "wallet",
};
/** A kind's mark in lists: the home rail logo, or a DS glyph where there is none. */
function kindMark(kind: DestinationKind) {
  const image = KIND_IMAGE[kind];
  return image ? { image } : { icon: KIND_ICON[kind], accent: KIND_ACCENT[kind] };
}

const KIND_ACCENT: Record<DestinationKind, "orange" | "lilac" | "neutral"> = {
  lightning: "orange",
  evm: "lilac",
  "base-usdc": "lilac",
  "base-eurc": "lilac",
  bank: "lilac",
  ark: "orange",
  bitcoin: "orange",
  phone: "neutral",
  email: "neutral",
  other: "neutral",
};

/** Contacts drawn per page of the list. */
const LIST_PAGE = 100;

/**
 * One list row. Its pet is drawn once per row (kept with the row while it is
 * on screen), so the shared avatar cache can stay small.
 */
function ContactRow({ contact, onPress }: { contact: Contact; onPress: () => void }) {
  const seed = avatarSeed(contact);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pet depends on the seed only
  const avatar = useMemo(() => contactAvatar(contact), [seed]);
  const first = contact.destinations[0];
  return (
    <ListAction accessibilityLabel={contact.label} onPress={onPress}>
      <ListActionLeadingAvatar source={avatar} />
      <ListActionText>{contact.label}</ListActionText>
      {first ? (
        <ListActionTextMuted>
          {contact.destinations.length > 1
            ? t(`${K}.destinationCount`, {
                first: destinationLabel(first),
                count: contact.destinations.length - 1,
              })
            : destinationLabel(first)}
        </ListActionTextMuted>
      ) : null}
      <ListActionTrailIcon name="chevron-right" />
    </ListAction>
  );
}

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Resolves the signed-in wallet's book (services/addressBook). */
  loadBook: () => Promise<AddressBook>;
  /**
   * Hand a routable destination to the existing send flow. Returns a message
   * when that flow can't take it right now (e.g. bank details not ready): the
   * contact stays open and says why.
   */
  onPay: (route: Exclude<SendRoute, { kind: "unsupported" }>) => string | undefined;
  /** A just-paid recipient to save: opens the add form (or the existing contact) prefilled. */
  saveRequest?: SaveOffer | null;
  onSaveRequestHandled?: () => void;
};

type Draft = {
  id: string | null;
  name: string;
  note: string;
  /** Their Nuri username, when they are a Nuri user. */
  nuriUsername: string;
  /** Every destination of the contact: an address, an IBAN, … all at once. */
  destinations: DraftDestination[];
};

const emptyDraft = (): Draft => ({
  id: null,
  name: "",
  note: "",
  nuriUsername: "",
  destinations: [emptyDraftDestination()],
});

const AddressBookScreen: React.FC<Props> = ({
  visible,
  onClose,
  loadBook,
  onPay,
  saveRequest,
  onSaveRequestHandled,
}) => {
  const insets = useSafeAreaInsets();
  const [book, setBook] = useState<AddressBook | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"loading" | "syncing" | "idle" | "offline">("loading");
  const [conflictCount, setConflictCount] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<Contact | null>(null);
  // Which form row's type/network list is open.
  const [picker, setPicker] = useState<{ index: number } | null>(null);
  // Nuri username lookup in the form: fills in everything the directory lists.
  const [lookup, setLookup] = useState<"idle" | "busy" | "found" | "notFound" | "failed">("idle");
  // Rows drawn so far; a new search starts at the first page again.
  const [shownCount, setShownCount] = useState(LIST_PAGE);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on a new query only
  useEffect(() => {
    setShownCount(LIST_PAGE);
  }, [query]);
  // Latest Nuri lookup; a lookup applies only if nothing newer happened.
  const lookupTicket = useRef(0);
  // A form opened, closed or switched: no earlier lookup belongs to it.
  const formOpen = draft !== null;
  const formId = draft?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on form identity only
  useEffect(() => {
    lookupTicket.current++;
  }, [formOpen, formId]);
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ContactConflict[]>([]);
  const [conflictPrompt, setConflictPrompt] = useState<ContactConflict | null>(null);

  // Local reads only: never wait behind a relay sync that an edit started.
  const refresh = useCallback(async (target: AddressBook, q: string) => {
    const all = await target.current();
    setContacts(q ? all.filter((c) => contactMatches(c, q)) : all);
    const open = await target.currentConflicts();
    setConflicts(open);
    setConflictCount(open.length);
  }, []);

  const runSync = useCallback(
    async (target: AddressBook) => {
      setStatus("syncing");
      let report: SyncReport | null = null;
      try {
        report = await target.sync();
      } catch {}
      await refresh(target, query);
      setStatus(report && report.relays.some((r) => r.complete) ? "idle" : "offline");
    },
    [query, refresh],
  );

  // Open: load the book, show the local copy at once, then sync. Runs on open
  // only; refresh/runSync change with the search query and must not re-sync.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open-time only
  useEffect(() => {
    if (!visible) {
      setDraft(null);
      setOpen(null);
      setPicker(null);
      setQuery("");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    void loadBook()
      .then(async (loaded) => {
        if (cancelled) return;
        setBook(loaded);
        await refresh(loaded, "");
        if (!cancelled) await runSync(loaded);
      })
      .catch(() => {
        if (!cancelled) setStatus("offline");
      });
    return () => {
      cancelled = true;
    };
  }, [visible, loadBook]);

  useEffect(() => {
    if (!book) return;
    void refresh(book, query);
    // An edit's relay sync finishes after the form has closed; show what it
    // brings in (another device's changes, a conflict).
    return book.subscribe(() => {
      void refresh(book, query).catch(() => {});
    });
  }, [book, query, refresh]);

  const saveDraft = useCallback(async () => {
    if (!book || !draft || saving) return;
    setSaving(true);
    setFormError(null);
    try {
      // The form holds all of the contact's destinations: what it shows is saved.
      const input = {
        label: draft.name,
        note: draft.note,
        nuriUsername: draft.nuriUsername,
        destinations: destinationsFromDraft(draft.destinations),
      };
      if (draft.id) await book.update(draft.id, input);
      else await book.add(input);
      setDraft(null);
      await refresh(book, query);
      EventBus.emit(ADDRESS_BOOK_CHANGED_EVENT);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [book, draft, query, refresh, saving]);

  const editContact = useCallback((contact: Contact) => {
    setOpen(null);
    setFormError(null);
    setLookup("idle");
    setDraft({
      id: contact.id,
      name: contact.label,
      note: contact.note ?? "",
      nuriUsername: contact.nuriUsername ?? "",
      destinations: contact.destinations.length
        ? contact.destinations.map(draftFieldsFor)
        : [emptyDraftDestination()],
    });
  }, []);

  // "emino", "@emino", "emino@nuri.com", "emino.nuri.eth" → the user's rails,
  // merged into the form. Nothing is saved until Save.
  const lookUpNuriUser = useCallback(async () => {
    const typed = draft?.nuriUsername ?? "";
    const username = toNuriUsername(typed);
    const draftId = draft?.id ?? null;
    // Every lookup, edit of the field and form open/close takes a new ticket;
    // only the latest ticket's answer is applied, and only to the same draft
    // still showing the username it asked for.
    const ticket = ++lookupTicket.current;
    const stillCurrent = () => lookupTicket.current === ticket;
    if (!username) {
      setLookup("notFound");
      return;
    }
    setLookup("busy");
    try {
      const rails = await resolvePayRecipient(username);
      if (!stillCurrent()) return;
      if (!rails) {
        setLookup("notFound");
        return;
      }
      setDraft((d) => applyNuriLookup(d, { draftId, typed, username, rails }));

      setLookup("found");
    } catch {
      if (stillCurrent()) setLookup("failed");
    }
  }, [draft?.nuriUsername, draft?.id]);

  const updateEntry = useCallback((index: number, change: Partial<DraftDestination>) => {
    setDraft((d) =>
      d
        ? {
            ...d,
            destinations: d.destinations.map((e, i) => (i === index ? { ...e, ...change } : e)),
          }
        : d,
    );
  }, []);

  // A recipient handed over from a finished send: an already-saved destination
  // opens its contact; a new one opens the add form with it filled in.
  useEffect(() => {
    if (!visible || !book || !saveRequest) return;
    let cancelled = false;
    void (async () => {
      const key = destinationKey(saveRequest.destination);
      const existing = (await book.list()).find((c) =>
        c.destinations.some((d) => destinationKey(d) === key),
      );
      if (cancelled) return;
      onSaveRequestHandled?.();
      setFormError(null);
      if (existing) {
        setDetailMessage(t(`${K}.alreadySaved`));
        setOpen(existing);
        return;
      }
      setDraft({
        ...emptyDraft(),
        name: saveRequest.name ?? "",
        destinations: [draftFieldsFor(saveRequest.destination)],
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, book, saveRequest, onSaveRequestHandled]);

  const resolveConflict = useCallback(
    async (conflict: ContactConflict, keep: "local" | "remote") => {
      if (!book) return;
      await book.resolveConflict(conflict.id, keep);
      setConflictPrompt(null);
      await refresh(book, query);
      EventBus.emit(ADDRESS_BOOK_CHANGED_EVENT);
    },
    [book, query, refresh],
  );

  const deleteContact = useCallback(
    async (contact: Contact) => {
      if (!book) return;
      await book.remove(contact.id);
      setOpen(null);
      await refresh(book, query);
      EventBus.emit(ADDRESS_BOOK_CHANGED_EVENT);
    },
    [book, query, refresh],
  );

  // The app's shared copy: clipboard plus the DS "Copied" toast.
  const copyValue = useCallback((value: string) => {
    void copyToClipboard(value);
  }, []);
  // "Pay <name>" with more than one payable destination: which one.
  const [payChoice, setPayChoice] = useState<Contact | null>(null);

  const payDestination = useCallback(
    (destination: Destination, contact: Contact) => {
      const route = routeDestination(destination, contact.label);
      if (route.kind === "unsupported") {
        setDetailMessage(
          t(
            route.reason === "rail"
              ? `${K}.noRail`
              : route.reason === "address"
                ? `${K}.invalidAddress`
                : `${K}.noNetwork`,
          ),
        );
        return;
      }
      const refused = onPay(route);
      if (refused) {
        setDetailMessage(refused);
        return;
      }
      setOpen(null);
    },
    [onPay],
  );

  const statusLabel =
    status === "loading"
      ? t("common.loading")
      : status === "syncing"
        ? t(`${K}.syncing`)
        : status === "offline"
          ? t(`${K}.offline`)
          : null;

  const kindItems = useMemo(
    () =>
      DESTINATION_KINDS.map((kind) => ({
        key: kind,
        label: t(`${K}.kind_${kind.replace("-", "_")}`),
        ...kindMark(kind),
      })),
    [],
  );

  return (
    <>
      <Layer visible={visible} onRequestClose={onClose}>
        <NuriSafeAreaProvider top={insets.top} bottom={insets.bottom}>
          <Screen>
            <View chrome="canvas" direction="column" align="stretch" fill="grow-shrink">
              <Header safeAreaTop chrome="canvas">
                <Topbar layout="fluid" surface="transparent">
                  <TopbarTitle>{t(`${K}.title`)}</TopbarTitle>
                  <TopbarTrailing>
                    <View direction="row" gap="sm" align="center">
                      <IconButton
                        icon="plus"
                        variant="soft"
                        accessibilityLabel={t(`${K}.add`)}
                        onPress={() => {
                          if (!book) return;
                          setFormError(null);
                          setLookup("idle");
                          setDraft(emptyDraft());
                        }}
                      />
                      <IconButton
                        icon="cross"
                        variant="soft"
                        accessibilityLabel={t("common.close")}
                        onPress={onClose}
                      />
                    </View>
                  </TopbarTrailing>
                </Topbar>
              </Header>

              <Scroll safeAreaBottom>
                <View direction="column" align="stretch" gap="lg" paddingY="md">
                  <View paddingX="lg">
                    <TextField
                      value={query}
                      onChangeText={setQuery}
                      placeholder={t(`${K}.searchPlaceholder`)}
                      inputMode="search"
                      autoCapitalize="none"
                      accessibilityLabel={t(`${K}.search`)}
                    >
                      <TextFieldLabel>{t(`${K}.search`)}</TextFieldLabel>
                    </TextField>
                  </View>

                  {statusLabel || conflictCount > 0 ? (
                    <View paddingX="lg">
                      <Text size="sm" muted>
                        {[
                          statusLabel,
                          conflictCount > 0 ? t(`${K}.conflicts`, { count: conflictCount }) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                  ) : null}

                  {/* A–Z, like a phone's contacts: pet, name, first destination.
                      Drawn a page at a time so a large book never builds every
                      row (and every pet) at once. */}
                  {groupByInitial(contacts.slice(0, shownCount), initialOf).map((group) => (
                    <View key={group.letter} direction="column" align="stretch" gap="xs">
                      <View paddingX="lg">
                        <Text size="sm" emphasis muted>
                          {group.letter}
                        </Text>
                      </View>
                      <List>
                        {group.contacts.map((contact) => (
                          <ContactRow
                            key={contact.id}
                            contact={contact}
                            onPress={() => {
                              setDetailMessage(null);
                              const conflict = conflicts.find((c) => c.id === contact.id);
                              if (conflict) setConflictPrompt(conflict);
                              else setOpen(contact);
                            }}
                          />
                        ))}
                      </List>
                    </View>
                  ))}

                  {contacts.length > shownCount ? (
                    <View paddingX="lg">
                      <Button
                        variant="soft"
                        size="sm"
                        accessibilityLabel={t(`${K}.showMore`)}
                        onPress={() => setShownCount((n) => n + LIST_PAGE)}
                      >
                        <ButtonText>{t(`${K}.showMore`)}</ButtonText>
                      </Button>
                    </View>
                  ) : null}

                  {contacts.length === 0 && status !== "loading" ? (
                    <View paddingX="lg">
                      <Text size="sm" muted align="center">
                        {query ? t(`${K}.noMatches`) : t(`${K}.empty`)}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </Scroll>
            </View>
          </Screen>
        </NuriSafeAreaProvider>
      </Layer>

      {/* Contact page, like a phone's contact card: avatar and name, the main
          action, then one card per destination with its own Pay and Copy. */}
      <DsSheetHost visible={visible && open !== null} onClose={() => setOpen(null)} mode="full">
        <Header safeAreaTop chrome="canvas">
          <Topbar surface="transparent" layout="fluid">
            <TopbarLeading>
              <IconButton
                icon="chevron-left"
                variant="soft"
                accessibilityLabel={t("common.back")}
                onPress={() => setOpen(null)}
              />
            </TopbarLeading>
            {/* Empty title: fills the bar so Edit sits at the trailing edge. */}
            <TopbarTitle>{""}</TopbarTitle>
            <TopbarTrailing>
              <IconButton
                icon="edit"
                variant="soft"
                accessibilityLabel={t(`${K}.edit`)}
                onPress={() => open && editContact(open)}
              />
            </TopbarTrailing>
          </Topbar>
        </Header>
        <Scroll safeAreaBottom>
          <View direction="column" align="stretch" gap="lg" paddingX="lg" paddingBottom="lg">
            <View direction="column" align="center" gap="sm">
              <Image
                source={contactAvatar(open ?? { label: "" }, "hero")}
                style={styles.heroAvatar}
                accessibilityIgnoresInvertColors
              />
              <Text size="xl" emphasis align="center">
                {open?.label ?? ""}
              </Text>
              {open?.nuriUsername ? (
                <Text size="sm" muted align="center">
                  {`@${open.nuriUsername}`}
                </Text>
              ) : null}
            </View>

            {(() => {
              // The one pay action. One payable destination pays it directly;
              // several ask which (euro address, IBAN, Lightning, ...).
              const payable = (open?.destinations ?? []).filter(
                (d) => routeDestination(d, open?.label).kind !== "unsupported",
              );
              return payable.length > 0 && open ? (
                <Button
                  size="lg"
                  variant="solid"
                  accent="lilac"
                  onPress={() => {
                    if (payable.length === 1) payDestination(payable[0], open);
                    else setPayChoice(open);
                  }}
                >
                  <ButtonIcon name="arrow-up" />
                  <ButtonText>{t(`${K}.payName`, { name: open.label })}</ButtonText>
                </Button>
              ) : null;
            })()}

            {detailMessage ? (
              <Text size="sm" muted align="center">
                {detailMessage}
              </Text>
            ) : null}

            {/* Details, like a phone's contact card: label, the full value, copy. */}
            {(open?.destinations ?? []).map((destination, index) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: destinations have no id; order is stable
                key={index}
                variant="soft"
                radius="lg"
                paddingX="lg"
                paddingY="md"
                direction="row"
                align="center"
                gap="sm"
              >
                <View fill="grow-shrink" direction="column" align="stretch" gap="xs">
                  <Text size="sm" muted>
                    {destinationLabel(destination)}
                  </Text>
                  <Text size="md" mono flow="wrap">
                    {destinationValue(destination)}
                  </Text>
                  {destination.type === "bank" && (destination.holder || destination.bic) ? (
                    <Text size="sm" muted>
                      {[destination.holder, destination.bic].filter(Boolean).join(" · ")}
                    </Text>
                  ) : null}
                </View>
                <IconButton
                  icon="copy"
                  variant="ghost"
                  accessibilityLabel={`${t("common.copy")} ${destinationLabel(destination)}`}
                  onPress={() => copyValue(destinationValue(destination))}
                />
              </View>
            ))}

            {open?.note ? (
              <View
                variant="soft"
                radius="lg"
                padding="lg"
                direction="column"
                align="stretch"
                gap="sm"
              >
                <Text size="sm" muted>
                  {t(`${K}.note`)}
                </Text>
                <Text size="md" flow="wrap">
                  {open.note}
                </Text>
              </View>
            ) : null}
          </View>
        </Scroll>
      </DsSheetHost>

      <ChoiceSheet<string>
        visible={visible && payChoice !== null}
        onClose={() => setPayChoice(null)}
        title={t(`${K}.payName`, { name: payChoice?.label ?? "" })}
        items={(payChoice?.destinations ?? []).flatMap((destination, index) =>
          routeDestination(destination, payChoice?.label).kind === "unsupported"
            ? []
            : [
                {
                  key: String(index),
                  label: destinationLabel(destination),
                  sublabel: destinationSummary(destination).split(" · ").pop(),
                  ...kindMark(kindOf(draftFieldsFor(destination))),
                },
              ],
        )}
        onSelect={(key) => {
          const contact = payChoice;
          setPayChoice(null);
          const destination = contact?.destinations[Number(key)];
          if (contact && destination) payDestination(destination, contact);
        }}
      />

      {/* Add / edit form, like a phone's contact editor: avatar on top, then
          one card per detail, each with its kind as a picker row. */}
      <DsSheetHost visible={visible && draft !== null} onClose={() => setDraft(null)} mode="full">
        <Header safeAreaTop chrome="canvas">
          <Topbar surface="transparent" layout="fluid">
            <TopbarTitle>{draft?.id ? t(`${K}.editTitle`) : t(`${K}.addTitle`)}</TopbarTitle>
            <TopbarTrailing>
              <IconButton
                icon="cross"
                variant="soft"
                accessibilityLabel={t("common.close")}
                onPress={() => setDraft(null)}
              />
            </TopbarTrailing>
          </Topbar>
        </Header>
        <Scroll safeAreaBottom={false}>
          <View direction="column" align="stretch" gap="lg" paddingX="lg" paddingY="md">
            <View direction="column" align="center">
              <Image
                source={contactAvatar(
                  { label: draft?.name.trim() || "?", nuriUsername: draft?.nuriUsername },
                  "hero",
                )}
                style={styles.heroAvatar}
                accessibilityIgnoresInvertColors
              />
            </View>

            <TextField
              value={draft?.name ?? ""}
              onChangeText={(name) => setDraft((d) => (d ? { ...d, name } : d))}
              placeholder={t(`${K}.namePlaceholder`)}
              autoCapitalize="words"
              maxLength={120}
            >
              <TextFieldLabel>{t(`${K}.name`)}</TextFieldLabel>
            </TextField>

            {/* A Nuri user fills in their Lightning, Base, Arkade and Bitcoin addresses. */}
            <View direction="column" align="stretch" gap="sm">
              <TextField
                value={draft?.nuriUsername ?? ""}
                onChangeText={(nuriUsername) => {
                  setLookup("idle");
                  lookupTicket.current++;
                  setDraft((d) => (d ? { ...d, nuriUsername } : d));
                }}
                placeholder={t(`${K}.nuriUsernamePlaceholder`)}
                autoCapitalize="none"
                accessibilityLabel={t(`${K}.nuriUsername`)}
              >
                <TextFieldLabel>{t(`${K}.nuriUsername`)}</TextFieldLabel>
                <TextFieldButton
                  accessibilityLabel={t(`${K}.nuriLookup`)}
                  onPress={() => void lookUpNuriUser()}
                >
                  {lookup === "busy" ? t(`${K}.nuriLookupBusy`) : t(`${K}.nuriLookup`)}
                </TextFieldButton>
              </TextField>
              {lookup === "found" || lookup === "notFound" || lookup === "failed" ? (
                <Text size="sm" muted>
                  {t(`${K}.nuriLookup_${lookup}`)}
                </Text>
              ) : null}
            </View>

            {(draft?.destinations ?? []).map((entry, index) => {
              const kind = kindOf(entry);
              return (
                <View
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity; order is the identity
                  key={index}
                  direction="column"
                  align="stretch"
                  gap="sm"
                >
                  {index > 0 ? <Separator /> : null}
                  <View direction="row" align="end" gap="sm">
                    <View fill="grow-shrink" direction="column" align="stretch">
                      <SelectField
                        size="md"
                        onPress={() => setPicker({ index })}
                        accessibilityLabel={t(`${K}.type`)}
                        accessibilityValue={t(`${K}.kind_${kind.replace("-", "_")}`)}
                      >
                        <SelectFieldLabel>{t(`${K}.type`)}</SelectFieldLabel>
                        {KIND_IMAGE[kind] ? (
                          <SelectFieldAvatar source={KIND_IMAGE[kind]} />
                        ) : (
                          <SelectFieldAvatar
                            name={KIND_ICON[kind]}
                            variant="solid"
                            accent={KIND_ACCENT[kind]}
                          />
                        )}
                        <SelectFieldValue>
                          {entry.other
                            ? `${entry.other.asset} · ${entry.other.network}`
                            : t(`${K}.kind_${kind.replace("-", "_")}`)}
                        </SelectFieldValue>
                        <SelectFieldChevron name="caret-down" />
                      </SelectField>
                    </View>
                    {(draft?.destinations.length ?? 0) > 1 ? (
                      <IconButton
                        icon="minus"
                        variant="soft"
                        accessibilityLabel={t(`${K}.removeDestination`)}
                        onPress={() =>
                          setDraft((d) =>
                            d
                              ? { ...d, destinations: d.destinations.filter((_, i) => i !== index) }
                              : d,
                          )
                        }
                      />
                    ) : null}
                  </View>

                  <TextField
                    value={entry.raw}
                    onChangeText={(raw) => updateEntry(index, { raw })}
                    placeholder={t(`${K}.placeholder_${kind.replace("-", "_")}`)}
                    autoCapitalize={entry.type === "bank" ? "characters" : "none"}
                    inputMode={
                      entry.type === "phone" ? "tel" : entry.type === "email" ? "email" : "text"
                    }
                    accessibilityLabel={t(`${K}.kind_${kind.replace("-", "_")}`)}
                  />

                  {entry.type === "bank" ? (
                    <>
                      <TextField
                        value={entry.holder}
                        onChangeText={(holder) => updateEntry(index, { holder })}
                        placeholder={t(`${K}.holderPlaceholder`)}
                        autoCapitalize="words"
                        accessibilityLabel={t(`${K}.holder`)}
                      />
                      <TextField
                        value={entry.bic}
                        onChangeText={(bic) =>
                          updateEntry(index, { bic: bic.replace(/\s+/g, "").toUpperCase() })
                        }
                        placeholder={t(`${K}.bicPlaceholder`)}
                        autoCapitalize="characters"
                        accessibilityLabel={t(`${K}.bic`)}
                      />
                    </>
                  ) : null}
                </View>
              );
            })}

            {(draft?.destinations.length ?? 0) < MAX_DESTINATIONS ? (
              <List>
                <ListAction
                  accessibilityLabel={t(`${K}.addDestination`)}
                  onPress={() => setPicker({ index: draft?.destinations.length ?? 0 })}
                >
                  <ListActionLeadingAvatar name="plus" variant="solid" accent="lilac" />
                  <ListActionText>{t(`${K}.addDestination`)}</ListActionText>
                </ListAction>
              </List>
            ) : null}

            <TextField
              value={draft?.note ?? ""}
              onChangeText={(note) => setDraft((d) => (d ? { ...d, note } : d))}
              placeholder={t(`${K}.notePlaceholder`)}
              autoCapitalize="sentences"
              maxLength={1000}
            >
              <TextFieldLabel>{t(`${K}.note`)}</TextFieldLabel>
            </TextField>

            {formError ? (
              <Text size="sm" muted>
                {formError}
              </Text>
            ) : null}
          </View>
        </Scroll>
        <Footer
          safeAreaBottom
          chrome="canvas"
          direction="column"
          align="stretch"
          paddingX="lg"
          paddingBottom="sm"
        >
          {/* Editing: Delete and Save side by side, equal width. */}
          <View direction="row" gap="sm" distribute="even">
            {draft?.id ? (
              <Button
                size="lg"
                variant="soft"
                disabled={saving}
                onPress={() => {
                  const id = draft.id;
                  if (!id) return;
                  const contact = contacts.find((c) => c.id === id);
                  setDraft(null);
                  if (contact) void deleteContact(contact);
                }}
              >
                <ButtonText>{t(`${K}.delete`)}</ButtonText>
              </Button>
            ) : null}
            <Button
              size="lg"
              variant="solid"
              accent="lilac"
              disabled={
                saving ||
                !draft?.name.trim() ||
                !draft?.destinations.some((entry) => entry.raw.trim())
              }
              onPress={() => void saveDraft()}
            >
              <ButtonText>{saving ? t(`${K}.saving`) : t(`${K}.save`)}</ButtonText>
            </Button>
          </View>
        </Footer>
      </DsSheetHost>

      {/* Nine kinds do not fit a bottom sheet (it caps its height and clips),
          so this list is a full page, per ChoiceSheet's own guidance. */}
      <ChoiceSheet<DestinationKind>
        mode="full"
        visible={visible && draft !== null && picker !== null}
        onClose={() => setPicker(null)}
        title={t(`${K}.type`)}
        items={kindItems}
        onSelect={(kind) => {
          const index = picker?.index ?? 0;
          setPicker(null);
          setDraft((d) => {
            if (!d) return d;
            // "Add": a new empty row of that kind.
            if (index >= d.destinations.length) {
              return {
                ...d,
                destinations: [
                  ...d.destinations,
                  withKind(emptyDraftDestination("lightning"), kind),
                ],
              };
            }
            return {
              ...d,
              destinations: d.destinations.map((e, i) => (i === index ? withKind(e, kind) : e)),
            };
          });
        }}
      />

      {/* Changed on two devices at once: the user keeps one version. Editing or
          deleting the contact from its detail also settles it. */}
      <ChoiceSheet<"local" | "remote">
        visible={visible && conflictPrompt !== null}
        onClose={() => setConflictPrompt(null)}
        title={t(`${K}.conflictTitle`, { name: conflictPrompt?.local.label ?? "" })}
        subtitle={t(`${K}.conflictSubtitle`)}
        items={
          conflictPrompt
            ? [
                {
                  key: "local",
                  label: t(`${K}.conflictKeepThisDevice`),
                  sublabel: `${conflictPrompt.local.label} · ${conflictPrompt.local.destinations[0] ? destinationSummary(conflictPrompt.local.destinations[0]) : ""}`,
                },
                {
                  key: "remote",
                  label: t(`${K}.conflictKeepOther`),
                  sublabel: `${conflictPrompt.remote.label} · ${conflictPrompt.remote.destinations[0] ? destinationSummary(conflictPrompt.remote.destinations[0]) : ""}`,
                },
              ]
            : []
        }
        onSelect={(keep) => {
          if (conflictPrompt) void resolveConflict(conflictPrompt, keep);
        }}
      />
    </>
  );
};

export default AddressBookScreen;

// The contact page's large pet avatar (the DS avatar is 48pt at most).
const styles = StyleSheet.create({
  heroAvatar: { width: 96, height: 96, borderRadius: 48 },
});
