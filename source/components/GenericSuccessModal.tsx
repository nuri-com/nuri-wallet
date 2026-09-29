// @screen app.success
import type React from "react";
import { Image, StyleSheet } from "react-native";
import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Scroll,
  Topbar,
  TopbarTrailing,
  View,
} from "@ds";
import { t } from "../lib/i18n";
import BrandDisplayTitle from "./BrandDisplayTitle";
import DsSheetHost from "./DsSheetHost";

type Props = {
  visible: boolean;
  onClose: () => void;
};

const ILLUSTRATION = require("../assets/illustrations/euro-bitcoin-paperplane.png");

const GenericSuccessModal: React.FC<Props> = ({ visible, onClose }) => (
  <DsSheetHost visible={visible} onClose={onClose} mode="full">
    <Header safeAreaTop chrome="canvas">
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

    <Scroll>
      <View
        direction="column"
        align="stretch"
        justify="start"
        gap="lg"
        paddingX="lg"
        paddingBottom="lg"
        fill="grow"
      >
        <BrandDisplayTitle>{t("component.BitcoinSuccessModal.title")}</BrandDisplayTitle>
        <View direction="column" align="center" justify="center" fill="grow">
          <Image source={ILLUSTRATION} style={styles.illustration} resizeMode="contain" />
        </View>
      </View>
    </Scroll>

    <Footer safeAreaBottom direction="column" align="stretch" paddingBottom="sm" paddingX="lg">
      <Button size="lg" variant="solid" accent="lilac" onPress={onClose}>
        <ButtonText>{t("component.BitcoinSuccessModal.close")}</ButtonText>
      </Button>
    </Footer>
  </DsSheetHost>
);

// Brand illustration asset (structural, not design-system chrome).
const styles = StyleSheet.create({
  illustration: {
    width: 260,
    height: 260,
  },
});

export default GenericSuccessModal;
