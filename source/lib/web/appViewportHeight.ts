/**
 * The height the web app may occupy, in px — the area the user can actually see,
 * measured, with no platform assumptions baked in.
 *
 * Every screen-sized scroller in the app is bounded by `#root` (public/index.html)
 * and `body` is `overflow: hidden`, so whatever `#root` is TALLER than the visible
 * area is unreachable: no document pan can bring it back, and the deepest row of
 * the screen's own scroll viewport sits under the browser chrome forever
 * (issue #1372 — the signed-in mobile home could not be scrolled, while the same
 * app and the same content scrolled on native).
 *
 * On iOS Safari a browser tab hands out TWO heights:
 *
 * - `window.innerHeight` (and `100vh`, `100lvh`) is the LARGE viewport: the full
 *   screen, including the strips behind the top and bottom bars. It does not shrink
 *   when those bars are on screen, so an app sized by it reaches under them.
 * - `window.visualViewport.height * scale` is the SMALL viewport: the area between
 *   the bars, which is what the user is looking at, and it is the number React
 *   Native Web's own `Dimensions` reports. Every full modal is therefore already
 *   pinned to it (`DsSheetHost` sizes web content by `useWindowDimensions`), which
 *   is why the transaction lists scroll on the same device where a screen-sized
 *   scroller bounded by the large viewport does not.
 *
 * The installed PWA has no browser chrome, so both numbers are the full screen
 * there, and native has no browser chrome at all — one measurement covers all
 * three, with nothing device-sized in between.
 *
 * The visual viewport also shrinks with the keyboard, and the app follows it there
 * too (the browser's own document scroll toward the focused field is undone and
 * done inside the app's scroll view instead, see `pinDocument`): that is the same thing native does when it pads the frame by the keyboard
 * inset, and it is why the web no longer lifts a footer a second time by hand
 * (lib/useKeyboardHeight returns 0 on web). The scale factor is React Native Web's:
 * pinch zoom shrinks the visual viewport without meaning the layout should shrink
 * with it.
 */
export const APP_VIEWPORT_HEIGHT_PROPERTY = "--nuri-viewport-height";

/**
 * The parts of `window` this reads. Structural, so a test (and a headless render)
 * can pass a plain object instead of a browser.
 */
export type AppViewportTarget = {
  innerHeight?: number;
  document?: {
    documentElement?: {
      clientHeight?: number;
      style?: { setProperty?: (property: string, value: string) => void };
    };
  };
  visualViewport?: AppViewportVisualViewport | null;
  scrollY?: number;
  scrollTo?: (x: number, y: number) => void;
  requestAnimationFrame?: (callback: () => void) => number;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

export type AppViewportVisualViewport = {
  height?: number;
  scale?: number;
  offsetTop?: number;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

type AppViewportEventSource = {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function usable(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The visible area's height in layout px, scaled the way React Native Web scales
 * it. Null when the browser reports nothing usable.
 *
 * `offsetTop` is deliberately NOT part of it. A pan (iOS scrolls the document to
 * bring a focused field above the keyboard) is undone by `pinDocument` below, so
 * the app always starts at the visible top and its height is the visible height.
 * Adding the pan instead made the frame taller than what shows, and the app then
 * sat shifted up by the pan: header gone, an empty band above the keyboard.
 */
function measureVisualViewport(target: AppViewportTarget | undefined): number | null {
  const viewport = target?.visualViewport;
  if (!viewport || !usable(viewport.height)) return null;
  const scale = usable(viewport.scale) ? viewport.scale : 1;
  return viewport.height * scale;
}

/**
 * Scrolls the document back to its top. `body` is `overflow: hidden`, yet the
 * browser still scrolls the document itself to show a focused field (iOS Safari
 * by up to the keyboard height), which moves the whole app, header included. The
 * app's own scroll view shows the field instead (lib/web/focusedFieldReveal).
 */
export function pinDocument(target: AppViewportTarget | undefined): boolean {
  if (!target || typeof target.scrollTo !== "function") return false;
  const scrolled = usable(target.scrollY) || usable(target.visualViewport?.offsetTop);
  if (!scrolled) return false;
  target.scrollTo(0, 0);
  return true;
}

/**
 * The height the user can see: the visual viewport wherever the browser reports it,
 * otherwise its own fallbacks. Returns null rather than inventing a height, so the
 * stylesheet's own fallback stands.
 */
export function measureAppViewportHeight(target: AppViewportTarget | undefined): number | null {
  if (!target) return null;
  const visual = measureVisualViewport(target);
  if (visual !== null) return Math.round(visual);
  if (usable(target.innerHeight)) return Math.round(target.innerHeight);
  const clientHeight = target.document?.documentElement?.clientHeight;
  return usable(clientHeight) ? Math.round(clientHeight) : null;
}

/**
 * Writes the measurement onto the root element as a custom property, which is what
 * `#root`'s height resolves against. Returns the height it applied, or null.
 */
export function applyAppViewportHeight(target: AppViewportTarget | undefined): number | null {
  const height = measureAppViewportHeight(target);
  if (height === null) return null;
  const style = target?.document?.documentElement?.style;
  if (typeof style?.setProperty !== "function") return null;
  style.setProperty(APP_VIEWPORT_HEIGHT_PROPERTY, `${height}px`);
  return height;
}

/**
 * Applies the measurement once and again on every change the browser reports, and
 * returns the teardown. The bars move as the user scrolls, so a one-shot read at
 * launch leaves the app sized for the chrome state it happened to load in.
 *
 * Both sources are needed: the bars' transition reaches `visualViewport` first
 * (and its `scroll` too, when the browser pans the page), while a window resize or
 * a rotation arrives on `window`. Each change also pins the document back to its
 * top and, once the new height has laid out, brings the focused field into view
 * inside its own scroll view (`onSettled`), which is where the browser's own
 * document scroll would otherwise have put it.
 */
export function observeAppViewportHeight(
  target: AppViewportTarget | undefined,
  onSettled?: () => void,
): (() => void) | undefined {
  if (!target) return undefined;
  pinDocument(target);
  applyAppViewportHeight(target);

  const update = () => {
    pinDocument(target);
    applyAppViewportHeight(target);
    if (!onSettled) return;
    if (typeof target.requestAnimationFrame === "function") target.requestAnimationFrame(onSettled);
    else onSettled();
  };
  const sources: AppViewportEventSource[] = [];
  if (target.visualViewport) sources.push(target.visualViewport);

  for (const source of sources) {
    source.addEventListener?.("resize", update);
    source.addEventListener?.("scroll", update);
  }
  target.addEventListener?.("resize", update);
  target.addEventListener?.("scroll", update);
  target.addEventListener?.("orientationchange", update);
  target.addEventListener?.("focusin", update);

  return () => {
    for (const source of sources) {
      source.removeEventListener?.("resize", update);
      source.removeEventListener?.("scroll", update);
    }
    target.removeEventListener?.("resize", update);
    target.removeEventListener?.("scroll", update);
    target.removeEventListener?.("orientationchange", update);
    target.removeEventListener?.("focusin", update);
  };
}
