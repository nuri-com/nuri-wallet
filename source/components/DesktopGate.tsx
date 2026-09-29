import { StyleSheet, View as RNView } from "react-native";
import { Text, View } from "@ds";

import AddressQrTile from "./AddressQrTile";
import { t } from "../lib/i18n";

/**
 * DesktopGate — Nuri is a mobile wallet (passkeys, one-hand layout), so desktop
 * browsers get a full-screen block instead of the cramped phone column. It shows
 * a QR of this exact URL; scanning it just opens the same site on a phone, where
 * the viewport is a touch device and the app renders normally. Web-only, gated on
 * a fine-pointer/hover device in App.
 *
 * The content sits in a fixed-width column so AddressQrTile (which measures its
 * own width via onLayout) resolves to a real size — a bare `width: "100%"` under
 * a centering flex parent collapses to 0.
 */
export default function DesktopGate() {
  const url = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <RNView style={styles.overlay}>
      <View chrome="canvas" fill="grow" align="center" justify="center" paddingX="xl">
        <RNView style={styles.content}>
          <Text size="lg" emphasis align="center">
            Nuri
          </Text>
          <Text size="md" muted align="center">
            {t("screen.DesktopGate.subtitle")}
          </Text>
          {url ? <AddressQrTile value={url} /> : null}
          <Text size="sm" muted align="center">
            {t("screen.DesktopGate.footer")}
          </Text>
        </RNView>
      </View>
    </RNView>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  content: {
    width: 320,
    maxWidth: "100%",
    alignItems: "center",
    rowGap: 20,
  },
});
