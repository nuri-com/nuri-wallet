// The frame a full-page status screen (a wait, Try again, Payment received)
// renders in: it scrolls if it must, the Scroll adds the device's bottom inset
// and this adds the app's one bottom gap (lib/ui/bottomGap), so a status
// screen's button sits exactly where AppFooter puts every other bottom button.
import type React from "react";

import { Scroll, useNuriSafeAreaInsets, View } from "@ds";

import { bottomGapToken } from "../lib/ui/bottomGap";

export default function StatusHost({ children }: { children: React.ReactNode }) {
  const insets = useNuriSafeAreaInsets();
  return (
    <Scroll safeAreaBottom>
      <View
        direction="column"
        align="stretch"
        fill="grow"
        paddingBottom={bottomGapToken(insets.bottom)}
      >
        {children}
      </View>
    </Scroll>
  );
}
