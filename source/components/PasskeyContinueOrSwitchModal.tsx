// @screen auth.continue-or-switch
import type React from "react";

import { Button, ButtonText, Header, IconButton, Text, Topbar, TopbarTrailing, View } from "@ds";
import { t } from "../lib/i18n";
import DsSheetHost from "./DsSheetHost";

type Props = {
  visible: boolean;
  displayName: string;
  onContinue: () => void;
  onUseOther: () => void;
  onClose: () => void;
};

const PasskeyContinueOrSwitchModal: React.FC<Props> = ({
  visible,
  displayName,
  onContinue,
  onUseOther,
  onClose,
}) => {
  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="sheet">
      <Header paddingTop="lg">
        <Topbar surface="transparent">
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
      <View direction="column" align="stretch" gap="md" paddingX="lg" paddingBottom="lg">
        <Text size="lg" emphasis>
          {t("screen.PasskeyContinueOrSwitchModal.title")}
        </Text>
        <Button
          size="lg"
          variant="solid"
          accent="lilac"
          onPress={onContinue}
          accessibilityLabel={t("screen.PasskeyContinueOrSwitchModal.continueWith", {
            name: displayName,
          })}
        >
          <ButtonText>
            {t("screen.PasskeyContinueOrSwitchModal.continueWith", { name: displayName })}
          </ButtonText>
        </Button>
        <Button
          size="lg"
          variant="soft"
          onPress={onUseOther}
          accessibilityLabel={t("screen.PasskeyContinueOrSwitchModal.useOtherPasskey")}
        >
          <ButtonText>{t("screen.PasskeyContinueOrSwitchModal.useOtherPasskey")}</ButtonText>
        </Button>
      </View>
    </DsSheetHost>
  );
};

export default PasskeyContinueOrSwitchModal;
