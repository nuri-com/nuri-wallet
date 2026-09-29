// @screen wirex.apple-wallet
// Manual "Add to Apple Wallet" helper. Wirex has no in-app card provisioning
// (PKAddPaymentPass), so this is a copy-the-PAN + deep-link-to-Wallet flow: the
// parent reveals the card number (one biometric signing), auto-copies it, and
// this sheet shows the number plus the manual steps. The CTA re-copies and
// opens the iOS Wallet app, where the user pastes the number to finish setup.
// SECURITY: presentational only — never logs or persists the PAN; the parent
// clears it from memory on close.
import type React from "react";
import {
  Button,
  ButtonIcon,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "../../../components/DsSheetHost";
import Spinner from "../../../components/Spinner";
import { t } from "../../../lib/i18n";

type Props = {
  visible: boolean;
  onClose: () => void;
  revealing: boolean;
  cardNumber: string | null;
  expiry: string | null;
  cvv: string | null;
  onCopyNumber: () => void;
  onOpenWallet: () => void;
};

// Group into 4-digit blocks for readability; the parent copies the raw digits.
function groupDigits(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

const WirexAppleWalletModal: React.FC<Props> = ({
  visible,
  onClose,
  revealing,
  cardNumber,
  expiry,
  cvv,
  onCopyNumber,
  onOpenWallet,
}) => {
  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t("screen.CardScreen.appleWalletTitle")}</TopbarTitle>
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
        <View
          direction="column"
          align="stretch"
          justify="start"
          gap="xl"
          paddingX="lg"
          paddingBottom="lg"
          fill="grow"
        >
          <View variant="soft" radius="md" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="sm" muted>
              {t("screen.CardScreen.overlayCardNumberLabel")}
            </Text>
            {revealing ? (
              <Spinner />
            ) : cardNumber ? (
              <View direction="row" align="center" justify="between" gap="sm">
                <Text size="lg" mono>
                  {groupDigits(cardNumber)}
                </Text>
                <IconButton
                  icon="copy"
                  variant="soft"
                  accessibilityLabel={t("screen.CardScreen.copyCardNumber")}
                  onPress={onCopyNumber}
                />
              </View>
            ) : (
              <Text size="md" muted>
                {t("screen.WirexCard.detailsError")}
              </Text>
            )}
            {!revealing && cardNumber ? (
              <View direction="row" align="stretch" gap="xl">
                <View direction="column" align="start" gap="xs">
                  <Text size="sm" muted>
                    {t("screen.CardScreen.overlayExpiryLabel")}
                  </Text>
                  <Text size="md" mono>
                    {expiry ?? "—"}
                  </Text>
                </View>
                <View direction="column" align="start" gap="xs">
                  <Text size="sm" muted>
                    {t("screen.CardScreen.overlayCvvLabel")}
                  </Text>
                  <Text size="md" mono>
                    {cvv ?? "—"}
                  </Text>
                </View>
              </View>
            ) : null}
          </View>

          <View direction="column" align="stretch" gap="sm">
            <Text size="md">{t("screen.CardScreen.appleWalletInstruction1")}</Text>
            <Text size="md">{t("screen.CardScreen.appleWalletInstruction2")}</Text>
            <Text size="md">{t("screen.CardScreen.appleWalletInstruction3")}</Text>
          </View>
        </View>
      </Scroll>

      <Footer
        safeAreaBottom
        chrome="canvas"
        direction="column"
        align="stretch"
        paddingBottom="sm"
        paddingX="lg"
      >
        <Button
          size="lg"
          variant="solid"
          accent="neutral"
          disabled={revealing}
          onPress={onOpenWallet}
          accessibilityLabel={t("screen.CardScreen.appleWalletCta")}
        >
          <ButtonIcon name="wallet" />
          <ButtonText>{t("screen.CardScreen.appleWalletCta")}</ButtonText>
        </Button>
      </Footer>
    </DsSheetHost>
  );
};

export default WirexAppleWalletModal;
