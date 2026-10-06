// "Log out?" confirmation in front of a logout.
import type React from "react";

import { Button, ButtonText, Footer, Header, Text, Topbar, TopbarTitle, View } from "@ds";

import DsSheetHost from "./DsSheetHost";
import { t } from "../lib/i18n";

type Props = {
  visible: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** The logout is running; the app is about to reload. */
  busy?: boolean;
};

const LogoutConfirmSheet: React.FC<Props> = ({ visible, onClose, onConfirm, busy }) => (
  <DsSheetHost visible={visible} onClose={onClose} mode="sheet" dismissible={!busy}>
    <Header paddingTop="lg">
      <Topbar surface="transparent" layout="fluid">
        <TopbarTitle>{t("screen.LogoutConfirm.title")}</TopbarTitle>
      </Topbar>
    </Header>
    <View paddingX="lg" paddingBottom="lg">
      <Text size="md" muted>
        {t("screen.LogoutConfirm.body")}
      </Text>
    </View>
    <Footer
      safeAreaBottom
      chrome="canvas"
      direction="column"
      align="stretch"
      gap="sm"
      paddingBottom="sm"
      paddingX="lg"
    >
      <Button size="lg" variant="solid" accent="orange" disabled={busy} onPress={onConfirm}>
        <ButtonText>
          {busy ? t("screen.LogoutConfirm.confirmBusy") : t("screen.LogoutConfirm.confirm")}
        </ButtonText>
      </Button>
      {busy ? null : (
        <Button size="lg" variant="soft" onPress={onClose}>
          <ButtonText>{t("screen.LogoutConfirm.cancel")}</ButtonText>
        </Button>
      )}
    </Footer>
  </DsSheetHost>
);

export default LogoutConfirmSheet;
