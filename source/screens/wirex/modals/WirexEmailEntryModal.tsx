// @screen wirex.open-account-email
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  Button,
  ButtonText,
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
import { focusAndroidTextInput } from "../../../lib/androidFocus";
import { t } from "../../../lib/i18n";
import AppFooter from "../../../components/AppFooter";

const K = "screen.CardScreen";
// Shape check only; the server is the authority on deliverability.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Props = {
  visible: boolean;
  onClose: () => void;
  onSubmit: (email: string) => void;
  busy: boolean;
  failed: boolean;
  emailInUse: boolean;
};

const WirexEmailEntryModal: React.FC<Props> = ({
  visible,
  onClose,
  onSubmit,
  busy,
  failed,
  emailInUse,
}) => {
  const [email, setEmail] = useState("");
  // The email the last failure belongs to. Once the user edits it, the old
  // "could not set up" line no longer describes what is in the field.
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const emailFieldRef = useRef<TextFieldHandle>(null);
  const stopAndroidFocus = useRef<(() => void) | null>(null);
  const valid = EMAIL_RE.test(email.trim());
  const showFailure = failed && submittedEmail === email.trim();

  // This component stays mounted across open/close (only the sheet's children
  // unmount), so typed state would silently survive into the next open while
  // the native field remounts empty — and this email becomes the permanent
  // account identity. Never let a hidden stale value submit.
  useEffect(() => {
    if (visible) return;
    setEmail("");
    setSubmittedEmail(null);
    stopAndroidFocus.current?.();
    stopAndroidFocus.current = null;
  }, [visible]);
  useEffect(() => () => stopAndroidFocus.current?.(), []);

  // Android ignores a single focus() right after the page animates in and the
  // keyboard never opens; the shared helper retries until it does.
  const focusEmail = () => {
    if (Platform.OS !== "android") {
      emailFieldRef.current?.focus();
      return;
    }
    stopAndroidFocus.current?.();
    stopAndroidFocus.current = focusAndroidTextInput(emailFieldRef, { delayMs: 0 });
  };

  return (
    // While the account is being set up, closing mid-flight would orphan the
    // signup — hide the X and disable scrim/back dismissal until it settles.
    <DsSheetHost
      visible={visible}
      onClose={onClose}
      mode="full"
      dismissible={!busy}
      onOpenComplete={() => {
        if (!busy) focusEmail();
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
            {showFailure ? (
              <Text size="sm" emphasis>
                {t(`${K}.${emailInUse ? "openAccountEmailInUse" : "openAccountDeployFailed"}`)}
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

          <AppFooter>
            <Button
              size="lg"
              variant="solid"
              accent="lilac"
              disabled={!valid}
              onPress={() => {
                const next = email.trim();
                setSubmittedEmail(next);
                onSubmit(next);
              }}
              accessibilityLabel={t(`${K}.openAccountEmailSubmit`)}
            >
              <ButtonText>{t(`${K}.openAccountEmailSubmit`)}</ButtonText>
            </Button>
          </AppFooter>
        </>
      )}
    </DsSheetHost>
  );
};

export default WirexEmailEntryModal;
