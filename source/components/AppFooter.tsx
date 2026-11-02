/**
 * AppFooter: the one bottom action bar every screen uses.
 *
 * A DS Footer with the app's single bottom rule baked in: the device bottom
 * inset (added by the DS Footer itself) plus one fixed gap (lib/ui/bottomGap),
 * the same horizontal padding and the same spacing between stacked buttons.
 * Screens never choose their own bottom padding; a screen that needs more room
 * gets it here, for every screen at once.
 *
 * Must render inside a DS host that reports the bottom inset (a DS Modal via
 * DsSheetHost, or a DS Screen), like every DS Footer.
 */

import type * as React from "react";

import { Footer, useNuriSafeAreaInsets } from "@ds";

import { bottomGapToken } from "../lib/ui/bottomGap";

type Props = {
  /** Paint the canvas behind the bar (full pages whose content scrolls under it). */
  canvas?: boolean;
  children?: React.ReactNode;
};

export default function AppFooter({ canvas = false, children }: Props) {
  const insets = useNuriSafeAreaInsets();
  return (
    <Footer
      safeAreaBottom
      {...(canvas ? { chrome: "canvas" as const } : {})}
      direction="column"
      align="stretch"
      gap="sm"
      paddingX="lg"
      paddingBottom={bottomGapToken(insets.bottom)}
    >
      {children}
    </Footer>
  );
}
