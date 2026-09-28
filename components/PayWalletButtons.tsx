// @component pay-wallet-buttons
// Additive wallet handoff from #1163. QR/copy remain available on every rail.
import { useState } from "react";
import { Linking } from "react-native";
import { Button, ButtonIcon, ButtonText, Text, View } from "@ds";
import { t } from "../lib/i18n";
import type { PayTarget } from "../lib/pay/payTarget";
import { payWalletUri } from "../lib/pay/payWalletUri";

export default function PayWalletButtons({ target }: { target: PayTarget }) {
  const [failed, setFailed] = useState(false);
  const uri = payWalletUri(target);
  if (!uri) return null;
  const open = async () => {
    setFailed(false);
    try {
      await Linking.openURL(uri);
    } catch {
      setFailed(true);
    }
  };
  return (
    <View direction="column" align="stretch" gap="sm">
      <Button
        size="lg"
        variant="soft"
        onPress={() => void open()}
        accessibilityLabel={t("screen.PayLink.openWallet")}
      >
        <ButtonIcon name="wallet" />
        <ButtonText>{t("screen.PayLink.openWallet")}</ButtonText>
      </Button>
      {failed ? (
        <Text size="sm" muted align="center">
          {t("screen.PayLink.walletUnavailable")}
        </Text>
      ) : null}
    </View>
  );
}
