// Lightweight portal that replaces RN <Modal>. Any component renders content as
// a top-of-app layer via <Layer>. Layers register into the DS overlay outlet
// (the single OverlayProvider mounted by DsOverlayRoot), the SAME outlet DS
// bottom sheets stack in — so legacy layers and DS sheets share one z-order,
// stacked by registration order (later = on top). A passkey confirm appearing
// while a DS sheet is open therefore lands ABOVE the sheet; with a separate
// host the sheet outlet (zIndex 100000, painted after all app content) covered
// every legacy layer, burying the passkey prompt under "Sending your Bitcoin…".
//
// Android hardware back is routed by OverlayProvider to the topmost layer's
// onRequestClose (a blocking top layer still swallows back). Not handled here
// (intentionally, for parity with prior <Modal> usage): iOS card
// swipe-to-dismiss — use the close button/backdrop.
import { type ReactNode, useId, useLayoutEffect } from "react";
import { useOverlay } from "@ds";

import { noteSurfaceOpened } from "../lib/ui/openSurfaces";

type LayerProps = {
  visible: boolean;
  children: ReactNode;
  /** Android hardware back / parity with Modal.onRequestClose. */
  onRequestClose?: () => void;
};

/**
 * Renders `children` as a top-level app layer while `visible`. Replaces a
 * RN <Modal>: same "floats above everything" behaviour, but as a layer in the
 * shared app-root overlay so later layers (and DS sheets) can stack above it.
 */
export function Layer({ visible, children, onRequestClose }: LayerProps): null {
  const id = useId();
  const overlay = useOverlay();

  // Counted like a sheet: a full cover is as much "the user is busy" as a
  // sheet is. See lib/ui/openSurfaces.
  useLayoutEffect(() => {
    if (!visible) return;
    return noteSurfaceOpened();
  }, [visible]);

  // Keep the layer's node fresh while visible (re-renders of the parent flow
  // through here so live content like "Preparing…" stays in sync).
  useLayoutEffect(() => {
    if (visible) overlay.register(id, children, { onRequestClose });
  }, [overlay, id, visible, children, onRequestClose]);

  // Remove on hide or unmount.
  useLayoutEffect(() => {
    if (!visible) overlay.unregister(id);
    return () => overlay.unregister(id);
  }, [overlay, id, visible]);

  return null;
}
