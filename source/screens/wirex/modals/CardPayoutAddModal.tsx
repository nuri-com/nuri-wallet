// @screen wirex.card-payout-add
// Add a Visa or Mastercard to send money to. The name comes first and offers
// saved cards from the address book; a picked one fills the number. The number
// goes to the server once, which has Wirex tokenize it; only the last four come
// back. A newly typed card is saved to the address book. A card that matches
// one already saved with Wirex (same name and last four) is offered instead,
// so the same card is not saved and listed twice (#1753).
import React, { useEffect, useState, useRef } from "react";
import {
  Alert,
  AlertButton,
  AlertIcon,
  Button,
  ButtonText,
  Header,
  IconButton,
  Scroll,
  Text,
  TextField,
  TextFieldLabel,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import AddressBookSuggestions, {
  ADDRESS_BOOK_CHANGED_EVENT,
} from "../../../components/AddressBookSuggestions";
import DsSheetHost from "../../../components/DsSheetHost";
import { saveCardToOriginBook } from "../../../lib/addressBook/cardContact";
import type { DestinationSuggestion } from "../../../lib/addressBook/contact";
import { t } from "../../../lib/i18n";
import {
  formatCardNumberInput,
  isPlausibleCardNumber,
  savedPayoutCardMatches,
} from "../../../lib/wirex/cardPayout";
import { getAddressBook } from "../../../services/addressBook/AddressBookService";
import { EventBus } from "../../../services/events/AppEventBusService";
import { wirexService, type WirexPayoutCard } from "../../../services/wirex/WirexService";
import { acceptsCardSend } from "../../addressBook/addressBookModel";
import AppFooter from "../../../components/AppFooter";

export type CardPayoutPrefill = { name: string; number: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  onAdded: (card: WirexPayoutCard) => void;
  /** A card picked in the address book: name and number already filled. */
  prefill?: CardPayoutPrefill | null;
  /** Cards already saved with Wirex: one matching the typed card is offered instead (#1753). */
  savedCards?: readonly WirexPayoutCard[];
};

const NO_SAVED_CARDS: readonly WirexPayoutCard[] = [];

const CardPayoutAddModal: React.FC<Props> = ({
  visible,
  onClose,
  onAdded,
  prefill,
  savedCards = NO_SAVED_CARDS,
}) => {
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The name a saved card filled in; the suggestions hide until it changes.
  const [pickedName, setPickedName] = useState<string | null>(null);

  // Bumped on every open and close: a save that answers after the sheet closed
  // or reopened never opens the next step for the screen now showing.
  const opening = useRef(0);

  // A new start never shows the last card number typed.
  useEffect(() => {
    opening.current += 1;
    if (!visible) return;
    setSaving(false);
    setName(prefill?.name ?? "");
    setNumber(prefill ? formatCardNumberInput(prefill.number) : "");
    setPickedName(prefill ? prefill.name.trim() : null);
    setError(null);
  }, [visible, prefill]);

  const nameParts = name.trim().split(/\s+/).filter(Boolean);
  const canSave = !saving && isPlausibleCardNumber(number) && nameParts.length >= 2;
  // The same card saved already (same name and last four): saving it again
  // makes Wirex list it twice. Offered, never forced: two cards of one person
  // can end alike, so "Save card" stays.
  const savedMatch = isPlausibleCardNumber(number)
    ? (savedPayoutCardMatches(savedCards, name, number)[0] ?? null)
    : null;

  const pickSavedCard = () => {
    if (!savedMatch || saving) return;
    onAdded(savedMatch);
  };

  const pickSaved = ({ contact, destination }: DestinationSuggestion) => {
    if (destination.type !== "card") return;
    const holder = (destination.holder || contact.label).trim();
    setName(holder);
    setPickedName(holder);
    setNumber(formatCardNumberInput(destination.number));
    setError(null);
  };

  const save = async () => {
    if (!canSave) return;
    const mine = opening.current;
    setSaving(true);
    setError(null);
    // The submitting account's book, fixed now: a wallet switch while Wirex
    // answers must never put this card into the next account's book.
    const originBook = getAddressBook().catch((): null => null);
    try {
      const card = await wirexService.addPayoutCard({ cardNumber: number, cardholderName: name });
      // Best effort: the address book never holds up a card Wirex accepted.
      void saveCardToOriginBook(originBook, getAddressBook, name, number)
        .then((written) => {
          if (written) EventBus.emit(ADDRESS_BOOK_CHANGED_EVENT);
        })
        .catch(() => {
          // Never log the card number.
        });
      if (opening.current === mine) onAdded(card);
    } catch (err) {
      if (opening.current !== mine) return;
      // Never log the card number.
      const notActive = err instanceof Error && err.message.includes("card_transfer_not_active");
      setError(t(notActive ? "screen.CardPayout.notActive" : "screen.CardPayout.addFailed"));
    } finally {
      if (opening.current === mine) setSaving(false);
    }
  };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t("screen.CardPayout.addTitle")}</TopbarTitle>
          <TopbarTrailing>
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>

      <Scroll safeAreaBottom={false}>
        <View direction="column" align="stretch" justify="start" gap="lg" paddingX="lg">
          <TextField
            value={name}
            onChangeText={(text) => {
              setError(null);
              setName(text);
            }}
            placeholder={t("screen.CardPayout.namePlaceholder")}
            autoCapitalize="words"
          >
            <TextFieldLabel>{t("screen.CardPayout.nameLabel")}</TextFieldLabel>
          </TextField>
          {/* Saved cards matching the typed name; gone once one is picked. */}
          <AddressBookSuggestions
            active={visible && name.trim() !== pickedName}
            query={name}
            accepts={acceptsCardSend}
            onPick={pickSaved}
          />
          <TextField
            value={number}
            onChangeText={(text) => {
              setError(null);
              setNumber(formatCardNumberInput(text));
            }}
            placeholder="1234 5678 9012 3456"
            inputMode="numeric"
            maxLength={23}
          >
            <TextFieldLabel>{t("screen.CardPayout.numberLabel")}</TextFieldLabel>
          </TextField>
          {savedMatch ? (
            <Alert variant="soft" accent="neutral">
              <AlertIcon name="card" />
              {t("screen.CardPayout.savedMatch", { last4: savedMatch.last4 })}
              <AlertButton
                accessibilityLabel={t("screen.CardPayout.useSaved")}
                disabled={saving}
                onPress={pickSavedCard}
              >
                {t("screen.CardPayout.useSaved")}
              </AlertButton>
            </Alert>
          ) : null}
          {error ? (
            <Text size="sm" muted>
              {error}
            </Text>
          ) : null}
        </View>
      </Scroll>

      <AppFooter canvas>
        <Button size="lg" variant="solid" accent="lilac" disabled={!canSave} onPress={save}>
          <ButtonText>{t("screen.CardPayout.saveLabel")}</ButtonText>
        </Button>
      </AppFooter>
    </DsSheetHost>
  );
};

export default CardPayoutAddModal;
