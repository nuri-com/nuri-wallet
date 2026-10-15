/**
 * DsSheetHost — hosts a DS Modal in the app-root overlay.
 *
 * The app mounts ONE OverlayProvider (+ DS theme + DS safe-area) at its root
 * (components/DsOverlayRoot, wired in App.tsx), so every in-app modal registers
 * into that single overlay outlet. Modals therefore STACK: a modal opened from
 * within a modal is just another layer — no nested RN <Modal> (two native modals
 * mid-transition freeze iOS). The DS Modal owns its own enter/exit animation
 * and unmounts itself when `open` is false, so no manual teardown is needed.
 *
 * `mode="sheet"` is a content-height bottom sheet (inputs are forbidden there
 * by the DS); `mode="full"` is a full page with keyboard accommodation.
 *
 * Consumers keep this component mounted and toggle `visible`.
 */

import * as React from "react";
import { Platform, View as RNView, useWindowDimensions } from "react-native";

import { noteSurfaceOpened } from "../lib/ui/openSurfaces";

import { Modal, ModalPanel } from "@ds";
import type { ModalMode } from "@ds";

/** Mirrors the DS Modal's sheet cap (CONTENT_MAX_FRACTION, not exported). */
const SHEET_MAX_FRACTION = 0.82;

export type DsSheetHostProps = {
  visible: boolean;
  onClose: () => void;
  mode?: ModalMode;
  /** false disables scrim-tap (and hardware-back) dismissal — the modal then
   * closes only through its own UI (e.g. the close button). Default true. */
  dismissible?: boolean;
  /** Fires after the enter animation finishes — the safe frame for focus-on-open. */
  onOpenComplete?: () => void;
  children: React.ReactNode;
};

export default function DsSheetHost({
  visible,
  onClose,
  mode = "sheet",
  dismissible = true,
  onOpenComplete,
  children,
}: DsSheetHostProps) {
  // Count this sheet while it is up, so surfaces that must not interrupt a
  // flow (the OTA update toast) can tell the user is mid-something.
  React.useEffect(() => {
    if (!visible) return;
    return noteSurfaceOpened();
  }, [visible]);

  // Web only: the DS ModalPanel is flexGrow:1 / flexShrink:0, so in a browser a
  // full modal grows to its CONTENT instead of being capped by the full-screen
  // surface. Anything taller than the viewport then runs off the bottom with
  // nothing to scroll — the DS Scroll inside never gets a bounded height, and
  // the floating Footer (Continue, Sending…) ends up below the fold, behind the
  // browser toolbar. Pinning the panel's content to the window height restores
  // the viewport those children measure against. Native bounds it natively, and
  // sheet mode is content-height by design, so both keep the plain panel.
  const { height: windowHeight } = useWindowDimensions();
  const isViewportBound = Platform.OS === "web" && mode === "full";
  // Sheet mode: the DS caps the sheet surface at a share of the window, but the
  // panel inside it does not shrink, so a list taller than the cap is clipped
  // and the Scroll in it never gets a bounded height to scroll in. Capping the
  // content at the same height lets the Scroll shrink and scroll instead.
  const sheetMaxHeight = Math.round(windowHeight * SHEET_MAX_FRACTION);

  return (
    <Modal
      open={visible}
      mode={mode}
      dismissible={dismissible}
      onOpenChange={(next) => !next && onClose()}
      onOpenComplete={onOpenComplete}
    >
      <ModalPanel>
        {isViewportBound ? (
          <RNView style={{ height: windowHeight, minHeight: 0 }}>{children}</RNView>
        ) : mode === "sheet" ? (
          <RNView style={{ maxHeight: sheetMaxHeight, minHeight: 0 }}>{children}</RNView>
        ) : (
          children
        )}
      </ModalPanel>
    </Modal>
  );
}
