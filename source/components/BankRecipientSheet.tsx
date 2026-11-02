// @screen wirex.bank-recipient
// The first step of a bank transfer: who it goes to. The same shape as the
// Euro and Bitcoin send's recipient step, narrowed to what a bank transfer can
// pay: the saved contacts that have bank details, and a row that opens the
// recipient form for someone new.
import { Keyboard } from "react-native";

import {
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  Scroll,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import AddressBookSuggestions from "./AddressBookSuggestions";
import DsSheetHost from "./DsSheetHost";
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

export default function BankRecipientSheet({ visible, onClose, onPick, onNew }: Props) {
  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t("screen.SepaRecipientModal.headerTitle")}</TopbarTitle>
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
              accessibilityLabel={t("screen.SepaRecipientModal.newRecipient")}
              onPress={() => {
                Keyboard.dismiss();
                onNew();
              }}
            >
              <ListActionLeadingAvatar name="plus" variant="soft" accent="lilac" />
              <ListActionText>{t("screen.SepaRecipientModal.newRecipient")}</ListActionText>
            </ListAction>
          </List>
          {/* Every saved contact with bank details, one row per account. */}
          <AddressBookSuggestions
            active={visible}
            query=""
            accepts={acceptsBankSend}
            onPick={onPick}
          />
        </View>
      </Scroll>
    </DsSheetHost>
  );
}
