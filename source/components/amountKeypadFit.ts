/**
 * Whether an amount screen's keypad should use its compact size
 * (components/AmountKeypad), decided from what the screen measured.
 *
 * A short phone in a browser tab (Safari's bottom bar on screen) leaves too
 * little height for the amount, the full-size keypad and the confirm button, so
 * the screen had to scroll and the last key row slid under the footer. The
 * keypad gives up height first: once the content is taller than its scroll
 * viewport it switches to the compact keys, and only a screen too short even
 * for those still scrolls.
 *
 * The content box grows to fill the viewport, so its height only says "too
 * tall", never how much room is spare. Compact therefore stays on until the
 * viewport itself grows (rotation, the browser bars leaving), which re-tries the
 * full keypad and measures again.
 */
export type KeypadFit = {
  compact: boolean;
  viewportHeight: number;
  contentHeight: number;
};

export const INITIAL_KEYPAD_FIT: KeypadFit = {
  compact: false,
  viewportHeight: 0,
  contentHeight: 0,
};

/** Layout rounding: a sub-pixel difference is not an overflow. */
const TOLERANCE_PX = 1;

export function nextKeypadFit(
  state: KeypadFit,
  measured: { viewportHeight?: number; contentHeight?: number },
): KeypadFit {
  const viewportHeight = measured.viewportHeight ?? state.viewportHeight;
  const contentHeight = measured.contentHeight ?? state.contentHeight;
  let compact = state.compact;
  if (compact && viewportHeight > state.viewportHeight + TOLERANCE_PX) compact = false;
  if (!compact && viewportHeight > 0 && contentHeight > viewportHeight + TOLERANCE_PX) {
    compact = true;
  }
  if (
    compact === state.compact &&
    viewportHeight === state.viewportHeight &&
    contentHeight === state.contentHeight
  ) {
    return state;
  }
  return { compact, viewportHeight, contentHeight };
}
