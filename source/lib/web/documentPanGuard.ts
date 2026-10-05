/**
 * Stops the browser from panning the page when nothing in the app can scroll.
 *
 * The document is locked (`body { overflow: hidden }`, `#root` sized to the
 * visible area by lib/web/appViewportHeight), yet iOS Safari still pans the
 * VISUAL viewport over the layout viewport once the keyboard is open: the
 * layout viewport stays the full screen height while only the part above the
 * keyboard shows, so a drag anywhere moves the whole app up by up to the
 * keyboard height (measured on the iPhone SE: 160px on the username screen,
 * whose content fits). `appViewportHeight` snaps it back when the finger lets
 * go, which is the "it scrolls although there is nothing to scroll to" bounce.
 * `overscroll-behavior` and `touch-action` do not reach that pan; cancelling
 * the touchmove does.
 *
 * So a one-finger drag is cancelled unless an element under the finger can
 * still scroll in the drag's direction (vertical or horizontal), which leaves
 * every real scroller, its momentum, and its pull at the ends untouched, and
 * only removes the drag that would move the page itself. Pinch zoom (two
 * fingers) is never touched. No-op on native and without touch events.
 */

/** The parts of an element this reads. Structural, so the decision is testable without a DOM. */
export type PanGuardElement = {
  tagName?: string;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  parentElement: PanGuardElement | null;
};

export type OverflowOf = (element: PanGuardElement) => { x: string; y: string };

const SCROLLABLE = /^(auto|scroll|overlay)$/;

function rangeY(element: PanGuardElement, overflowY: string): number {
  if (!SCROLLABLE.test(overflowY)) return 0;
  return element.scrollHeight - element.clientHeight;
}

function rangeX(element: PanGuardElement, overflowX: string): number {
  // A text input scrolls its own value sideways without a computed overflow.
  if (element.tagName !== "INPUT" && !SCROLLABLE.test(overflowX)) return 0;
  return element.scrollWidth - element.clientWidth;
}

function canScrollY(element: PanGuardElement, overflowY: string, dy: number): boolean {
  const range = rangeY(element, overflowY);
  if (range < 1) return false;
  // Finger moving up (dy < 0) scrolls content down, towards the end.
  if (dy < 0) return element.scrollTop < range - 0.5;
  if (dy > 0) return element.scrollTop > 0.5;
  return false;
}

function canScrollX(element: PanGuardElement, overflowX: string, dx: number): boolean {
  const range = rangeX(element, overflowX);
  if (range < 1) return false;
  if (dx < 0) return element.scrollLeft < range - 0.5;
  if (dx > 0) return element.scrollLeft > 0.5;
  return false;
}

/**
 * True when the drag from the touch's start may proceed: some element from the
 * touched one up to (not including) the document's root element can scroll
 * along EITHER axis in the drag's direction. Checking both axes, not only the
 * dominant one, keeps a diagonal drag on a vertical list scrolling. The root
 * itself is excluded on purpose: its "scroll" is the page pan this guard
 * exists to stop.
 */
export function dragCanScroll(
  start: PanGuardElement | null,
  dx: number,
  dy: number,
  overflowOf: OverflowOf,
  root: PanGuardElement | null,
): boolean {
  for (let el = start; el && el !== root; el = el.parentElement) {
    if (el.tagName === "BODY") break;
    const overflow = overflowOf(el);
    if (canScrollY(el, overflow.y, dy) || canScrollX(el, overflow.x, dx)) return true;
  }
  return false;
}

/**
 * True when anything from the touched element up to (not including) the root
 * can scroll at all, in any direction. False means only the page could move.
 */
export function hasScrollRange(
  start: PanGuardElement | null,
  overflowOf: OverflowOf,
  root: PanGuardElement | null,
): boolean {
  for (let el = start; el && el !== root; el = el.parentElement) {
    if (el.tagName === "BODY") break;
    const overflow = overflowOf(el);
    if (rangeY(el, overflow.y) >= 1 || rangeX(el, overflow.x) >= 1) return true;
  }
  return false;
}

/**
 * Movement (px, on the larger axis) before a drag on a scrollable screen counts
 * as intent. Smaller first samples are touch jitter: their direction and axis
 * are noise, so nothing is decided from them.
 */
export const DRAG_INTENT_PX = 8;

type TouchPoint = { clientX: number; clientY: number };
type GuardTouchEvent = {
  touches: ArrayLike<TouchPoint>;
  target: unknown;
  cancelable?: boolean;
  preventDefault: () => void;
};

export type PanGuardDocument = {
  documentElement: PanGuardElement | null;
  addEventListener: (
    type: string,
    listener: (event: GuardTouchEvent) => void,
    options?: unknown,
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: GuardTouchEvent) => void,
    options?: unknown,
  ) => void;
};

/**
 * Installs the guard on `doc` and returns the teardown. The decision is taken
 * once per gesture and then kept: a gesture the browser has started scrolling
 * is not cancellable afterwards, and one that was cancelled stays cancelled, so
 * a drag cannot start in a scroller and continue as a page pan. Where nothing
 * can scroll it is taken on the first move; where something can, only once the
 * finger has moved `DRAG_INTENT_PX`, so jitter cannot pick the axis.
 */
export function installDocumentPanGuard(
  doc: PanGuardDocument | undefined,
  overflowOf: OverflowOf,
): (() => void) | undefined {
  if (!doc || typeof doc.addEventListener !== "function") return undefined;
  let startX = 0;
  let startY = 0;
  let decided: "allow" | "block" | null = null;

  const onStart = (event: GuardTouchEvent) => {
    // A second finger turns the gesture into a pinch: never touch it, and do
    // not re-decide it from the first finger's stale start point.
    if (event.touches.length !== 1) {
      decided = "allow";
      return;
    }
    decided = null;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
  };
  const onMove = (event: GuardTouchEvent) => {
    if (event.touches.length !== 1) {
      decided = "allow";
      return;
    }
    if (decided === null) {
      const target = event.target as PanGuardElement;
      const dx = event.touches[0].clientX - startX;
      const dy = event.touches[0].clientY - startY;
      if (dx === 0 && dy === 0) return;
      if (!hasScrollRange(target, overflowOf, doc.documentElement)) {
        // Nothing under the finger can scroll in any direction: whatever the
        // finger does next, the only thing that could move is the page.
        // Decided now, because a move the browser has already turned into a
        // pan can no longer be cancelled.
        decided = "block";
      } else if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_INTENT_PX) {
        // A scroller is here, but the direction is still jitter: decide later.
        return;
      } else {
        decided = dragCanScroll(target, dx, dy, overflowOf, doc.documentElement)
          ? "allow"
          : "block";
      }
    }
    if (decided === "block" && event.cancelable !== false) event.preventDefault();
  };

  const listen = { capture: true, passive: false };
  doc.addEventListener("touchstart", onStart, listen);
  doc.addEventListener("touchmove", onMove, listen);
  return () => {
    doc.removeEventListener("touchstart", onStart, listen);
    doc.removeEventListener("touchmove", onMove, listen);
  };
}
