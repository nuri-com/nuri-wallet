// @screen wirex.uk-payee-add
// Add a UK bank account to send money to: the account holder's name, the sort
// code and the account number. Saved with Wirex; the same account again comes
// back as the one already saved.
import React, { useEffect, useRef, useState } from "react";
import {
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
import DsSheetHost from "../../../components/DsSheetHost";
import AppFooter from "../../../components/AppFooter";
import { t } from "../../../lib/i18n";
import {
  accountNumberDigits,
  formatSortCodeInput,
  isValidAccountNumber,
  isValidSortCode,
} from "../../../lib/wirex/ukPayments";
import { wirexService, type WirexUkPayee } from "../../../services/wirex/WirexService";

type Props = {
  visible: boolean;
  onClose: () => void;
  onAdded: (payee: WirexUkPayee) => void;
};

const UkPayeeAddModal: React.FC<Props> = ({ visible, onClose, onAdded }) => {
  const [name, setName] = useState("");
  const [sortCode, setSortCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bumped on every open and close: a save that answers after the sheet closed
  // or reopened never opens the next step for the screen now showing.
  const opening = useRef(0);

  // A new start never shows the last account typed.
  useEffect(() => {
    opening.current += 1;
    if (!visible) return;
    setSaving(false);
    setName("");
    setSortCode("");
    setAccountNumber("");
    setError(null);
  }, [visible]);

  const canSave =
    !saving &&
    name.trim().length > 0 &&
    isValidSortCode(sortCode) &&
    isValidAccountNumber(accountNumber);

  const save = async () => {
    if (!canSave) return;
    const mine = opening.current;
    setSaving(true);
    setError(null);
    try {
      const payee = await wirexService.addUkPayee({ name, sortCode, accountNumber });
      if (opening.current === mine) onAdded(payee);
    } catch {
      if (opening.current !== mine) return;
      // Never log the account number.
      setError(t("screen.UkPayment.addFailed"));
    } finally {
      if (opening.current === mine) setSaving(false);
    }
  };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t("screen.UkPayment.addTitle")}</TopbarTitle>
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
            placeholder={t("screen.UkPayment.namePlaceholder")}
            autoCapitalize="words"
          >
            <TextFieldLabel>{t("screen.UkPayment.nameLabel")}</TextFieldLabel>
          </TextField>
          <TextField
            value={sortCode}
            onChangeText={(text) => {
              setError(null);
              setSortCode(formatSortCodeInput(text));
            }}
            placeholder="12-34-56"
            inputMode="numeric"
            maxLength={8}
          >
            <TextFieldLabel>{t("screen.UkPayment.sortCodeLabel")}</TextFieldLabel>
          </TextField>
          <TextField
            value={accountNumber}
            onChangeText={(text) => {
              setError(null);
              setAccountNumber(accountNumberDigits(text));
            }}
            placeholder="12345678"
            inputMode="numeric"
            maxLength={8}
          >
            <TextFieldLabel>{t("screen.UkPayment.accountNumberLabel")}</TextFieldLabel>
          </TextField>
          {error ? (
            <Text size="sm" muted>
              {error}
            </Text>
          ) : null}
        </View>
      </Scroll>

      <AppFooter canvas>
        <Button size="lg" variant="solid" accent="lilac" disabled={!canSave} onPress={save}>
          <ButtonText>{t("screen.UkPayment.saveLabel")}</ButtonText>
        </Button>
      </AppFooter>
    </DsSheetHost>
  );
};

export default UkPayeeAddModal;
