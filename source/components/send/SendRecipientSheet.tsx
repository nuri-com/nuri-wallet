// @screen send.recipient
// The first step of every send: who it goes to. Saved contacts, a typed or
// pasted address, name or invoice, a scanned code, or an account abroad. The
// recipient comes back as every address they can be paid at; which balance
// pays, and whether that needs a swap, is the amount step's business.
import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard } from "react-native";
import * as Clipboard from "expo-clipboard";

import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  Scroll,
  Text,
  TextField,
  TextFieldButton,
  TextFieldLabel,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import AddressBookSuggestions, { useAddressBookContacts } from "../AddressBookSuggestions";
import DsSheetHost from "../DsSheetHost";
import PayoutAbroadSheet from "../PayoutAbroadSheet";
import { petAvatar } from "../../lib/addressBook/petAvatar";
import { t } from "../../lib/i18n";
import { createRecipientStepGate } from "../../lib/send/recipientStepGate";
import type { Contact } from "../../lib/addressBook/contact";
import { resolveEnsName } from "../../lib/qr/resolveEns";
import { checkEvmRecipient } from "../../lib/send/evmRecipientCheck";
import { namesEvmNetwork } from "../../lib/send/evmNetworks";
import {
  evm,
  namedEvm,
  parseRecipientInput,
  type RecipientInput,
} from "../../lib/send/recipientInput";
import { unsavedNuriUsers } from "../../lib/send/nuriUserSearch";
import {
  isSendableDestination,
  recipientFromContact,
  recipientFromDestinations,
  type SendRecipient,
} from "../../lib/send/sendRouting";
import { isValidEvmAddress } from "../../lib/validation";
import { evmRecipientLookup } from "../../services/pay/evmRecipientLookup";
import { useNuriUserSearch } from "../../services/arkade/nuriUserSearch";

type Props = {
  visible: boolean;
  onClose: () => void;
  /** False when no balance can pay this recipient (the step stays open). */
  onRecipient: (recipient: SendRecipient) => boolean;
  /** The scanner; its result comes back into the same flow. */
  onScan: () => void;
  /** A move between the user's own balances instead. */
  onMoveToBalances: () => void;
};

export default function SendRecipientSheet({
  visible,
  onClose,
  onRecipient,
  onScan,
  onMoveToBalances,
}: Props) {
  const [entry, setEntry] = useState("");
  const [resolving, setResolving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  // The lookup could not be reached: retryable, and not "no such name".
  const [lookupFailed, setLookupFailed] = useState(false);
  // A plain 0x... or ENS name of someone outside Nuri: the network must be named.
  const [needsNetwork, setNeedsNetwork] = useState(false);
  const [abroadOpen, setAbroadOpen] = useState(false);
  const stepGate = useRef(createRecipientStepGate());
  // The step's one completion: a pick, a typed recipient or a payout abroad.
  // Whichever comes first wins and retires any lookup still running.
  const finish = (recipient: SendRecipient) => {
    if (!stepGate.current.complete()) return;
    // Nothing can pay it: the step stays open for another recipient.
    if (!onRecipient(recipient)) stepGate.current.reset();
  };
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const contacts = useAddressBookContacts(visible);

  // Every open starts empty.
  useEffect(() => {
    if (!visible) {
      // Closed: nothing may complete it any more.
      stepGate.current.complete();
      return;
    }
    stepGate.current.reset();
    setEntry("");
    setResolving(false);
    setNotFound(false);
    setLookupFailed(false);
    setNeedsNetwork(false);
    setAbroadOpen(false);
  }, [visible]);

  const typed = entry.trim();
  const parsed = useMemo(() => parseRecipientInput(typed), [typed]);
  // Nuri users matching what is typed, saved or not (saved ones show as contacts).
  const search = useNuriUserSearch(entry, visible && !resolving);
  const nuriUsers = useMemo(
    () => unsavedNuriUsers(search.usernames, search.prefix, contacts),
    [search.usernames, search.prefix, contacts],
  );

  const edit = (next: string) => {
    stepGate.current.edit();
    setEntry(next);
    setResolving(false);
    setNotFound(false);
    setLookupFailed(false);
    setNeedsNetwork(false);
  };

  const paste = async () => {
    try {
      const clip = (await Clipboard.getStringAsync()).trim();
      if (clip) edit(clip);
    } catch {
      // Clipboard refused (permission, empty): the field stays typable.
    }
  };

  // A typed or pasted address that belongs to a saved contact is that person.
  const recipientFor = (
    destinations: SendRecipient["destinations"],
    amountSats?: string,
  ): SendRecipient => ({
    // A request naming its amount keeps its own address; the contact names the person.
    // So does an address whose network was named (`base:0x...`).
    ...recipientFromDestinations(
      contacts,
      destinations,
      Boolean(amountSats) || destinations.some(namesEvmNetwork),
    ),
    ...(amountSats ? { amountSats } : {}),
  });

  // A Nuri user picked from a list: their username, looked up now.
  const pickUsername = (username: string) => {
    Keyboard.dismiss();
    const handle = `@${username}`;
    edit(handle);
    entryRef.current = handle;
    void lookUp({ kind: "nuri-user", username }, handle);
  };

  const next = () => {
    if (!parsed) return;
    Keyboard.dismiss();
    void lookUp(parsed, typed);
  };

  // Every recipient is checked when the step continues: a name is looked up (a
  // Nuri user is paid at the addresses their username has now, never at ones
  // saved for them, #1770), and a plain 0x... is paid only as the Nuri user it
  // belongs to (#1783).
  const lookUp = async (
    input: RecipientInput | { kind: "contact"; contact: Contact },
    typed: string,
  ) => {
    const ticket = stepGate.current.beginLookup(typed);
    const stillCurrent = () => stepGate.current.lookupIsCurrent(ticket, entryRef.current);
    setResolving(true);
    setNotFound(false);
    setLookupFailed(false);
    setNeedsNetwork(false);
    try {
      const lookup = evmRecipientLookup(contacts);
      let recipient: SendRecipient | null;
      if (input.kind === "nuri-user") {
        recipient = await lookup.nuriUser(input.username);
      } else if (input.kind === "ens") {
        const address = await resolveEnsName(input.name);
        recipient =
          address && isValidEvmAddress(address)
            ? recipientFor([input.network ? namedEvm(address, input.network) : evm(address)])
            : null;
      } else if (input.kind === "contact") {
        recipient = recipientFromContact(input.contact);
      } else {
        recipient = recipientFor(input.destinations, input.amountSats);
      }
      if (!stillCurrent()) return;
      if (!recipient) {
        setNotFound(true);
        return;
      }
      // A username was just looked up: its addresses are current already.
      const checked =
        input.kind === "nuri-user" ? recipient : await checkEvmRecipient(recipient, lookup);
      if (!stillCurrent()) return;
      if (!checked) {
        setNeedsNetwork(true);
        return;
      }
      finish(checked);
    } catch {
      if (stillCurrent()) setLookupFailed(true);
    } finally {
      if (stillCurrent()) setResolving(false);
    }
  };

  const hint = lookupFailed
    ? t("screen.WalletSendStablecoinModal.lookupFailed")
    : needsNetwork
      ? t("screen.SendRecipientSheet.needsNetwork")
      : notFound
        ? t("screen.WalletSendStablecoinModal.ensNotFound")
        : typed.length > 0 && !parsed
          ? t("screen.WalletSendStablecoinModal.invalidAddressError")
          : null;

  return (
    <>
      <DsSheetHost visible={visible} onClose={onClose} mode="full">
        <Header safeAreaTop chrome="canvas">
          <Topbar surface="transparent" layout="fluid">
            <TopbarTitle>{t("actions.send")}</TopbarTitle>
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

        <Scroll>
          {/* No paddingX here: a List already insets its rows by 18dp (6 on the
              List, 12 on the ListAction), so padding the column put the
              suggestion rows on 36dp while the field and the CTA sat on 18dp.
              Only the field and its hint need the gutter, same split as
              PayoutAbroadSheet.tsx. */}
          <View direction="column" align="stretch" gap="sm" paddingBottom="lg" fill="grow">
            <View direction="column" align="stretch" gap="sm" paddingX="lg">
              <TextField
                value={entry}
                onChangeText={edit}
                autoCapitalize="none"
                accessibilityLabel={t("screen.SendRecipientSheet.recipientLabel")}
              >
                <TextFieldLabel>{t("screen.SendRecipientSheet.recipientLabel")}</TextFieldLabel>
                <TextFieldButton
                  accessibilityLabel={t("common.paste")}
                  onPress={() => void paste()}
                >
                  {t("common.paste")}
                </TextFieldButton>
              </TextField>
              {hint ? (
                <Text size="md" muted align="center">
                  {hint}
                </Text>
              ) : null}
            </View>
            {/* Every other way to send, as rows above the contacts. The abroad
                row is a bank or mobile money account, paid over Bitcoin or, in
                Tanzania, from Euro or Dollar. */}
            {typed.length === 0 ? (
              <List>
                <ListAction
                  accessibilityLabel={t("screen.HomeScreen.scanA11yLabel")}
                  onPress={() => {
                    Keyboard.dismiss();
                    onScan();
                  }}
                >
                  <ListActionLeadingAvatar name="qr-scan" variant="soft" accent="lilac" />
                  <ListActionText>{t("screen.QrScannerModal.title")}</ListActionText>
                </ListAction>
                <ListAction
                  accessibilityLabel={t("screen.HomeScreen.sendToBalances")}
                  onPress={() => {
                    Keyboard.dismiss();
                    onMoveToBalances();
                  }}
                >
                  <ListActionLeadingAvatar name="transfer-vertical" variant="soft" accent="lilac" />
                  <ListActionText>{t("screen.HomeScreen.sendToBalances")}</ListActionText>
                </ListAction>
                <ListAction
                  accessibilityLabel={t("screen.BitcoinSendScreen.ctaPayAbroad")}
                  onPress={() => {
                    Keyboard.dismiss();
                    setAbroadOpen(true);
                  }}
                >
                  <ListActionLeadingAvatar name="bank" variant="soft" accent="lilac" />
                  <ListActionText>{t("screen.BitcoinSendScreen.ctaPayAbroad")}</ListActionText>
                </ListAction>
              </List>
            ) : null}
            {/* Every contact some balance can pay, then the ones matching what
                is typed. A pick is the whole person: all their addresses. */}
            <AddressBookSuggestions
              active={visible}
              query={entry}
              accepts={isSendableDestination}
              cost={() => 0}
              payUsername
              onPick={({ contact, username }) => {
                if (!username) {
                  Keyboard.dismiss();
                  void lookUp({ kind: "contact", contact }, entryRef.current);
                  return;
                }
                pickUsername(username);
              }}
            />
            {/* Nuri users the address book does not have, as the server finds them. */}
            {nuriUsers.length > 0 ? (
              <List>
                {nuriUsers.map((username) => (
                  <ListAction
                    key={username}
                    accessibilityLabel={`@${username}`}
                    onPress={() => pickUsername(username)}
                  >
                    <ListActionLeadingAvatar source={petAvatar(username)} />
                    <ListActionText>{username}</ListActionText>
                    <ListActionTextMuted>{`@${username}`}</ListActionTextMuted>
                  </ListAction>
                ))}
              </List>
            ) : null}
          </View>
        </Scroll>

        <Footer
          safeAreaBottom
          direction="column"
          align="stretch"
          paddingBottom="sm"
          paddingX="lg"
          gap="sm"
        >
          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            disabled={!parsed || resolving}
            onPress={next}
            accessibilityLabel={t("screen.WalletSendStablecoinModal.ctaNext")}
          >
            <ButtonText>
              {resolving
                ? t("screen.WalletSendStablecoinModal.loadingLabel")
                : t("screen.WalletSendStablecoinModal.ctaNext")}
            </ButtonText>
          </Button>
        </Footer>
      </DsSheetHost>
      <PayoutAbroadSheet
        visible={visible && abroadOpen}
        payWith="bitcoin"
        onClose={() => setAbroadOpen(false)}
        onDone={(payout) => {
          setAbroadOpen(false);
          finish({ destinations: [], person: null, payout });
        }}
      />
    </>
  );
}
