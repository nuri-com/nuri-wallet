/**
 * DsOverlayRoot — the single app-root DS overlay/theme scope.
 *
 * Mounted once in App.tsx, inside the app's SafeAreaProvider, wrapping all app
 * content. It provides the DS theme, the ONE OverlayProvider every in-app DS
 * sheet registers into, the DS safe-area context (fed from the native insets),
 * and the ToastProvider that backs useToast() app-wide. Because every DS Modal
 * renders into this single overlay outlet,
 * sheets STACK as layers — a sheet opened from within a sheet is just another
 * layer, with no nested RN <Modal> (two native modals mid-transition freeze iOS).
 *
 * These are all context-only providers (no layout views), and the overlay outlet
 * is a pointer-events:box-none absolute layer that only intercepts touches when a
 * sheet is open — so wrapping the whole app changes nothing until a sheet mounts.
 * Legacy screens don't read DS context, so they are unaffected.
 */

import * as React from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NuriSafeAreaProvider, NuriThemeProvider, OverlayProvider, ToastProvider } from "@ds";

import CopyToastBridge from "./CopyToastBridge";
import OtaUpdateAutoApplyBridge from "./OtaUpdateAutoApplyBridge";
import V2MoveStatusBridge from "./V2MoveStatusBridge";

export default function DsOverlayRoot({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <NuriThemeProvider mode="light" accent="neutral">
      <OverlayProvider>
        <NuriSafeAreaProvider top={insets.top} bottom={insets.bottom}>
          <ToastProvider>
            <CopyToastBridge />
            <OtaUpdateAutoApplyBridge />
            <V2MoveStatusBridge />
            {children}
          </ToastProvider>
        </NuriSafeAreaProvider>
      </OverlayProvider>
    </NuriThemeProvider>
  );
}
