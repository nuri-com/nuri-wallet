/**
 * FullscreenLayer: the full-page layout for screens shown as a top-of-app
 * Layer (lock screen, payment received, card payment approval, passkey
 * confirm).
 *
 * Built from the same DS parts as every other full page: a DS Screen (which
 * reports the device insets), a Header for the top inset and the shared
 * AppFooter for the bottom actions, so these screens put their buttons exactly
 * where every sheet and page does. Content sits between them: title at the
 * top, illustration in the middle.
 */

import type React from "react";

import { Header, Screen, View } from "@ds";

import AppFooter from "./AppFooter";
import { Layer } from "./LayerHost";

type Props = {
  visible: boolean;
  /** Omitted where the surface is not dismissible (the biometric lock). */
  onRequestClose?: () => void;
  /** The bottom actions, rendered in the shared AppFooter. */
  footer?: React.ReactNode;
  children: React.ReactNode;
};

export default function FullscreenLayer({ visible, onRequestClose, footer, children }: Props) {
  return (
    <Layer visible={visible} onRequestClose={onRequestClose}>
      <View chrome="canvas" direction="column" align="stretch" fill="grow">
        <Screen>
          <Header safeAreaTop chrome="canvas" />
          <View
            direction="column"
            align="stretch"
            justify="between"
            gap="lg"
            paddingX="lg"
            paddingTop="xl"
            paddingBottom="lg"
            fill="grow"
          >
            {children}
          </View>
          {footer ? <AppFooter>{footer}</AppFooter> : null}
        </Screen>
      </View>
    </Layer>
  );
}
