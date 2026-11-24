// @screen wirex.bank-recipient
// The first step of a bank transfer: who it goes to. The same shape as the
// Euro and Bitcoin send's recipient step, narrowed to what a bank transfer can
// pay: the saved contacts that have bank details, and a row that opens the
// recipient form for someone new.
//
// Opening it syncs the address book (#1997), so bank recipients saved on
// another device show without visiting Settings → Address book first. While
// that read runs, or when it failed, a line says so: an empty list here only
// means "none saved" once a relay answered.
import { Keyboard } from "react-native";

import {
  Button,
  ButtonText,
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import AddressBookSuggestions from "./AddressBookSuggestions";
import DsSheetHost from "./DsSheetHost";
import { useAddressBookRestore } from "./useAddressBookRestore";
import type { DestinationSuggestion } from "../lib/addressBook/contact";
import { t } from "../lib/i18n";
import { acceptsBankSend } from "../screens/addressBook/addressBookModel";

type Props = {
  visible: boolean;
  onClose: () => void;
  /** A saved contact with bank details was picked. */
  onPick: (suggestion: DestinationSuggestion) => void;
  /** Someone new: the recipient form. */
  onNew: () => void;
};

const K = "screen.SepaRecipientModal";

export default function BankRecipientSheet({ visible, onClose, onPick, onNew }: Props) {
  const restore = useAddressBookRestore(visible);
  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t(`${K}.headerTitle`)}</TopbarTitle>
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

      <Scroll safeAreaBottom>
        {/* No paddingX: a List insets its own rows, as on the send recipient step. */}
        <View direction="column" align="stretch" gap="sm" paddingBottom="lg">
          <List>
            <ListAction
              accessibilityLabel={t(`${K}.newRecipient`)}
              onPress={() => {
                Keyboard.dismiss();
                onNew();
              }}
            >
              <ListActionLeadingAvatar name="plus" variant="soft" accent="lilac" />
              <ListActionText>{t(`${K}.newRecipient`)}</ListActionText>
            </ListAction>
          </List>
          {/* Every saved contact with bank details, one row per account. */}
          <AddressBookSuggestions
            active={visible}
            query=""
            accepts={acceptsBankSend}
            onPick={onPick}
          />
          {restore.status === "loading" || restore.status === "syncing" ? (
            <View paddingX="lg">
              <Text size="sm" muted align="center">
                {t(`${K}.savedSyncing`)}
              </Text>
            </View>
          ) : restore.status === "offline" ? (
            <View direction="column" align="center" gap="sm" paddingX="lg">
              <Text size="sm" muted align="center">
                {t(`${K}.savedOffline`)}
              </Text>
              <Button
                variant="soft"
                size="sm"
                accessibilityLabel={t("common.tryAgain")}
                onPress={restore.retry}
              >
                <ButtonText>{t("common.tryAgain")}</ButtonText>
              </Button>
            </View>
          ) : null}
        </View>
      </Scroll>
    </DsSheetHost>
  );
}
