// @screen wirex.3ds-approval
// Purely presentational fullscreen approval view for an in-app Wirex 3DS
// challenge — same fullscreen Layer scaffold as the claim/signing screens
// (PaymentReceivedModal / WebAuthnPrfOverlay). No close button by design: the
// deliberate per-challenge tap is the user's consent, so the user answers with
// Approve or Decline (Android back still dismisses without responding, and the
// view auto-dismisses once the challenge is no longer pending).
import type React from "react";
import { Image, StyleSheet } from "react-native";
import { Button, ButtonIcon, ButtonText, Text, View } from "@ds";
import BrandDisplayTitle from "../../../components/BrandDisplayTitle";
import FullscreenLayer from "../../../components/FullscreenLayer";
import { t } from "../../../lib/i18n";
import type { Wirex3dsChallenge } from "../../../services/wirex/WirexService";

const ILLUSTRATION = require("../../../assets/illustrations/card-present.png");

type Props = {
  visible: boolean;
  challenge: Wirex3dsChallenge | null;
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onClose: () => void;
};

const Wirex3dsApprovalModal: React.FC<Props> = ({
  visible,
  challenge,
  busy,
  onApprove,
  onDecline,
  onClose,
}) => {
  return (
    <FullscreenLayer visible={visible && challenge != null} onRequestClose={onClose}>
      <View direction="column" align="center" gap="md" paddingTop="lg">
        <BrandDisplayTitle>{t("screen.Wirex3dsApproval.title")}</BrandDisplayTitle>
        {challenge ? (
          <View direction="column" align="center" gap="xs">
            <Text size="md" emphasis align="center">
              {challenge.merchantName ?? t("screen.Wirex3dsApproval.unknownMerchant")}
            </Text>
            {challenge.amount != null ? (
              <Text size="xl" emphasis align="center">
                {challenge.currency != null
                  ? `${challenge.currency} ${challenge.amount}`
                  : String(challenge.amount)}
              </Text>
            ) : null}
            {challenge.cardLast4 != null ? (
              <Text size="md" muted align="center">
                {t("screen.Wirex3dsApproval.cardLabel", { last4: challenge.cardLast4 })}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      <View direction="column" align="center" justify="center" fill="grow">
        <Image source={ILLUSTRATION} style={styles.illustration} resizeMode="contain" />
      </View>

      <View direction="column" align="stretch" gap="sm">
        <Button
          size="lg"
          variant="solid"
          accent="lilac"
          disabled={busy}
          onPress={onApprove}
          accessibilityLabel={t("screen.Wirex3dsApproval.approveA11yLabel")}
        >
          <ButtonIcon name="check-circle" />
          <ButtonText>{t("screen.Wirex3dsApproval.approveLabel")}</ButtonText>
        </Button>
        <Button
          size="lg"
          variant="soft"
          disabled={busy}
          onPress={onDecline}
          accessibilityLabel={t("screen.Wirex3dsApproval.declineA11yLabel")}
        >
          <ButtonIcon name="cross" />
          <ButtonText>{t("screen.Wirex3dsApproval.declineLabel")}</ButtonText>
        </Button>
      </View>
    </FullscreenLayer>
  );
};

const styles = StyleSheet.create({
  illustration: {
    width: 260,
    height: 260,
  },
});

export default Wirex3dsApprovalModal;
