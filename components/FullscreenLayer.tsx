/**
 * FullscreenLayer — the scaffold every fullscreen Layer surface shares.
 *
 * A Layer is not a DS sheet: it has no Header/Footer parts, so it owns its own
 * safe areas. This wraps the canvas surface, the safe-area frame, and the one
 * padded column those screens lay their content out in — title at the top,
 * illustration in the middle, actions at the bottom, via `justify="between"`.
 */

import type React from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { View } from "@ds";

import { Layer } from "./LayerHost";

type Props = {
  visible: boolean;
  /** Omitted where the surface is not dismissible (the biometric lock). */
  onRequestClose?: () => void;
  children: React.ReactNode;
};

export default function FullscreenLayer({ visible, onRequestClose, children }: Props) {
  return (
    <Layer visible={visible} onRequestClose={onRequestClose}>
      <View chrome="canvas" direction="column" align="stretch" fill="grow">
        <SafeAreaView edges={["top", "bottom"]} style={styles.safeArea}>
          <View
            direction="column"
            align="stretch"
            justify="between"
            gap="lg"
            paddingX="lg"
            paddingY="xl"
            fill="grow"
          >
            {children}
          </View>
        </SafeAreaView>
      </View>
    </Layer>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
});
