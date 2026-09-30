import { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

import { INITIAL_KEYPAD_FIT, nextKeypadFit } from "../components/amountKeypadFit";

/**
 * Wires an amount screen to components/amountKeypadFit: pass `onViewportLayout`
 * to its `Scroll`, `onContentLayout` to the content stack directly inside it, and
 * `compact` to its `AmountKeypad`.
 */
export function useKeypadFit(): {
  compact: boolean;
  onViewportLayout: (event: LayoutChangeEvent) => void;
  onContentLayout: (event: LayoutChangeEvent) => void;
} {
  const [fit, setFit] = useState(INITIAL_KEYPAD_FIT);
  const onViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const viewportHeight = event.nativeEvent.layout.height;
    setFit((state) => nextKeypadFit(state, { viewportHeight }));
  }, []);
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    const contentHeight = event.nativeEvent.layout.height;
    setFit((state) => nextKeypadFit(state, { contentHeight }));
  }, []);
  return { compact: fit.compact, onViewportLayout, onContentLayout };
}
