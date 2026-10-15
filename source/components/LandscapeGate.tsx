import { StyleSheet, View as RNView } from "react-native";
import { Text, View } from "@ds";

import { t } from "../lib/i18n";

/**
 * LandscapeGate — Nuri is a portrait mobile wallet. The manifest pins
 * `orientation: portrait`, but iOS Safari/PWA ignores it and has no web API to
 * lock orientation, so a landscape phone would render the portrait layout
 * sideways. Cover it with a "rotate to portrait" block instead. Web-only, shown
 * on touch devices in landscape (desktop gets DesktopGate); it clears itself the
 * moment the device returns to portrait.
 */
export default function LandscapeGate() {
  return (
    <RNView style={styles.overlay}>
      <View
        chrome="canvas"
        fill="grow"
        direction="column"
        align="center"
        justify="center"
        gap="md"
        paddingX="xl"
      >
        <Text size="lg" emphasis align="center">
          {t("screen.LandscapeGate.title")}
        </Text>
        <Text size="md" muted align="center">
          {t("screen.LandscapeGate.subtitle")}
        </Text>
      </View>
    </RNView>
  );
}

// Above the DS overlay outlet (zIndex 100000), where Settings, the QR scanner
// and every other sheet or layer render; otherwise they paint over this gate.
const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100001,
  },
});
