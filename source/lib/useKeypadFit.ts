import { useCallback, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

import { INITIAL_KEYPAD_FIT, nextKeypadFit } from "../components/amountKeypadFit";

/**
 * Wires an amount screen to components/amountKeypadFit: pass `onViewportLayout`
 * to its `Scroll`, `onContentLayout` to the content stack directly inside it, and
 * `compact` to its `AmountKeypad`.
 */
export function useKeypadFit(measureContent = true): {
  compact: boolean;
  onViewportLayout: (event: LayoutChangeEvent) => void;
  onContentLayout: (event: LayoutChangeEvent) => void;
} {
  const [fit, setFit] = useState(INITIAL_KEYPAD_FIT);
  // Off while the screen shows something other than the keypad (a recipient
  // step's list): that height says nothing about whether the keypad fits.
  const measureContentRef = useRef(measureContent);
  measureContentRef.current = measureContent;
  const onViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const viewportHeight = event.nativeEvent.layout.height;
    setFit((state) => nextKeypadFit(state, { viewportHeight }));
  }, []);
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    if (!measureContentRef.current) return;
    const contentHeight = event.nativeEvent.layout.height;
    setFit((state) => nextKeypadFit(state, { contentHeight }));
  }, []);
  return { compact: fit.compact, onViewportLayout, onContentLayout };
}
