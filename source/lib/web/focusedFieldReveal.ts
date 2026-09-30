/**
 * Scrolls the focused text field into view inside the app's own scroll view.
 *
 * On the web the browser brings a focused field into view by scrolling the
 * DOCUMENT (iOS Safari: by up to the keyboard's height). The app's document is
 * locked (lib/web/appViewportHeight pins it back to the top), because a scrolled
 * document moves the whole app, header included, and leaves a gap the size of
 * that scroll above the keyboard. The field still has to be seen, so the scroll
 * happens where the app can scroll: the nearest scrollable ancestor of the field
 * (a form's DS Scroll), just far enough to show it above the footer.
 *
 * Structural types only, so a test can pass plain objects instead of a browser.
 */

export type RevealRect = { top: number; bottom: number };

export type RevealElement = {
  tagName?: string;
  isContentEditable?: boolean;
  parentElement?: RevealElement | null;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  getBoundingClientRect?: () => RevealRect;
};

export type RevealDocument = { activeElement?: RevealElement | null };

export type OverflowOf = (element: RevealElement) => string | undefined;

/** Space kept between the field and the scroll view's edge, so its label shows too. */
export const FOCUSED_FIELD_MARGIN_PX = 36;

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTextEntry(element: RevealElement): boolean {
  return (
    TEXT_ENTRY_TAGS.has((element.tagName ?? "").toUpperCase()) || element.isContentEditable === true
  );
}

function isScrollable(element: RevealElement, overflowOf: OverflowOf): boolean {
  const overflow = overflowOf(element);
  if (overflow !== "auto" && overflow !== "scroll") return false;
  return (element.scrollHeight ?? 0) > (element.clientHeight ?? 0);
}

/**
 * The distance to scroll `scroller` so that `field` sits inside it with `margin`
 * to spare at both edges; negative scrolls up, 0 when it is already in view.
 * A field taller than the room keeps its top in view.
 */
export function revealDelta(field: RevealRect, scroller: RevealRect, margin: number): number {
  const top = scroller.top + margin;
  const bottom = scroller.bottom - margin;
  if (field.top < top) return field.top - top;
  if (field.bottom > bottom) return Math.min(field.bottom - bottom, field.top - top);
  return 0;
}

/**
 * Brings the focused text field into view in its nearest scrollable ancestor.
 * Returns how far it scrolled (0 when nothing needed to move).
 */
export function revealFocusedField(
  doc: RevealDocument | undefined,
  overflowOf: OverflowOf,
  margin: number = FOCUSED_FIELD_MARGIN_PX,
): number {
  const field = doc?.activeElement;
  if (!field || !isTextEntry(field) || typeof field.getBoundingClientRect !== "function") return 0;
  let scroller = field.parentElement ?? null;
  while (scroller && !isScrollable(scroller, overflowOf)) scroller = scroller.parentElement ?? null;
  if (!scroller || typeof scroller.getBoundingClientRect !== "function") return 0;
  const delta = revealDelta(
    field.getBoundingClientRect(),
    scroller.getBoundingClientRect(),
    margin,
  );
  if (delta !== 0) scroller.scrollTop = (scroller.scrollTop ?? 0) + delta;
  return delta;
}
