/**
 * DsOverlayRoot — the single app-root DS overlay/theme scope.
 *
 * Mounted once in App.tsx, inside the app's SafeAreaProvider, wrapping all app
 * content. It provides the DS theme, the ONE OverlayProvider every in-app DS
 * sheet registers into, the DS safe-area context (fed from the native insets),
 * and the ToastProvider that backs useToast() app-wide. The safe-area
 * provider sits OUTSIDE the overlay, so every Layer and Modal reads the real
 * insets and no screen seeds its own. Because every DS Modal
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
import { Keyboard, Platform, View as RNView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NuriSafeAreaProvider, NuriThemeProvider, OverlayProvider, ToastProvider } from "@ds";

import CopyToastBridge from "./CopyToastBridge";
import OtaUpdateAutoApplyBridge from "./OtaUpdateAutoApplyBridge";
import V2MoveStatusBridge from "./V2MoveStatusBridge";
import {
  reportAppFrameLayout,
  reportKeyboardHidden,
  reportKeyboardShown,
} from "../lib/ui/androidKeyboardFrame";

/**
 * Android only: measures the app frame (the same box the overlay outlet fills)
 * and whether the keyboard is up, so a full page can tell when the window shrank
 * for the keyboard on top of the DS lifting it (lib/ui/androidKeyboardFrame).
 * Raw View: an invisible measuring layer, which the DS does not model.
 */
function AndroidAppFrameProbe() {
  React.useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) =>
      reportKeyboardShown(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () => reportKeyboardHidden());
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return (
    <RNView
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={(e) =>
        reportAppFrameLayout(e.nativeEvent.layout.width, e.nativeEvent.layout.height)
      }
    />
  );
}

export default function DsOverlayRoot({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <NuriThemeProvider mode="light" accent="neutral">
      {/* The insets wrap the overlay too: its outlet renders every Layer and
          Modal as a sibling of {children}, so a provider inside it left them
          (and a sheet opened from a sheet) at inset 0. */}
      <NuriSafeAreaProvider top={insets.top} bottom={insets.bottom}>
        <OverlayProvider>
          <ToastProvider>
            <CopyToastBridge />
            <OtaUpdateAutoApplyBridge />
            <V2MoveStatusBridge />
            {Platform.OS === "android" ? <AndroidAppFrameProbe /> : null}
            {children}
          </ToastProvider>
        </OverlayProvider>
      </NuriSafeAreaProvider>
    </NuriThemeProvider>
  );
}
