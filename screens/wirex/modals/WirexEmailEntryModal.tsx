// @screen wirex.open-account-email
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Text,
  TextField,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import type { TextFieldHandle } from "@ds";
import DsSheetHost from "../../../components/DsSheetHost";
import Spinner from "../../../components/Spinner";
import { t } from "../../../lib/i18n";

const K = "screen.CardScreen";
// Shape check only; the server is the authority on deliverability.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Props = {
  visible: boolean;
  onClose: () => void;
  onSubmit: (email: string) => void;
  busy: boolean;
  failed: boolean;
};

const WirexEmailEntryModal: React.FC<Props> = ({ visible, onClose, onSubmit, busy, failed }) => {
  const [email, setEmail] = useState("");
  const emailFieldRef = useRef<TextFieldHandle>(null);
  const valid = EMAIL_RE.test(email.trim());

  // This component stays mounted across open/close (only the sheet's children
  // unmount), so typed state would silently survive into the next open while
  // the native field remounts empty — and this email becomes the permanent
  // account identity. Never let a hidden stale value submit.
  useEffect(() => {
    if (!visible) setEmail("");
  }, [visible]);

  return (
    // While the account is being set up, closing mid-flight would orphan the
    // signup — hide the X and disable scrim/back dismissal until it settles.
    <DsSheetHost
      visible={visible}
      onClose={onClose}
      mode="full"
      dismissible={!busy}
      onOpenComplete={() => {
        if (!busy) emailFieldRef.current?.focus();
      }}
    >
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t(`${K}.openAccountEmailTitle`)}</TopbarTitle>
          <TopbarTrailing>
            {!busy && (
              <IconButton
                icon="cross"
                variant="soft"
                accessibilityLabel={t("common.close")}
                onPress={onClose}
              />
            )}
          </TopbarTrailing>
        </Topbar>
      </Header>

      {busy ? (
        <View direction="column" align="center" justify="center" gap="lg" padding="lg" fill="grow">
          <Spinner />
          <Text size="lg" emphasis align="center">
            {t(`${K}.openAccountDeployingTitle`)}
          </Text>
          <Text size="md" muted align="center">
            {t(`${K}.openAccountDeployingBody`)}
          </Text>
        </View>
      ) : (
        <>
          <View
            direction="column"
            align="stretch"
            gap="lg"
            paddingX="lg"
            paddingBottom="lg"
            fill="grow"
          >
            {failed ? (
              <Text size="sm" emphasis>
                {t(`${K}.openAccountDeployFailed`)}
              </Text>
            ) : null}

            {/* Keep the remounted retry field bound to the submitted value.
                A blank field with a stale valid email in state could otherwise
                resubmit an address the user cannot see. */}
            <TextField
              ref={emailFieldRef}
              accent="lilac"
              value={email}
              onChangeText={setEmail}
              inputMode="email"
              autoCapitalize="none"
              placeholder={t(`${K}.openAccountEmailPlaceholder`)}
              accessibilityLabel={t(`${K}.openAccountEmailLabel`)}
            />
          </View>

          <Footer
            safeAreaBottom
            direction="column"
            align="stretch"
            paddingBottom="sm"
            paddingX="lg"
          >
            <Button
              size="lg"
              variant="solid"
              accent="lilac"
              disabled={!valid}
              onPress={() => onSubmit(email.trim())}
              accessibilityLabel={t(`${K}.openAccountEmailSubmit`)}
            >
              <ButtonText>{t(`${K}.openAccountEmailSubmit`)}</ButtonText>
            </Button>
          </Footer>
        </>
      )}
    </DsSheetHost>
  );
};

export default WirexEmailEntryModal;
