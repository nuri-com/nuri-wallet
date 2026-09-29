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
 * too: that is the same thing native does when it pads the frame by the keyboard
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
 * The visible window's extent from the document's top, in layout px, scaled the
 * way React Native Web scales it. Null when the browser reports nothing usable.
 *
 * `offsetTop` is part of the measurement, not decoration: focusing an input makes
 * iOS pan the visual viewport (`offsetTop > 0`) so the visible interval starts
 * below the document's top. The app is anchored at the top, so a frame sized by
 * `height` alone would end `offsetTop` px above the visible bottom — a
 * bottom-anchored control (the onboarding footer with Continue) would float above
 * the keyboard, and the top would be clipped for nothing. Sized to the window's
 * END, the frame reaches the visible bottom exactly, which is what the pan is for:
 * the browser has already chosen which part of the document to show, and its
 * `scroll` event re-measures this.
 */
function measureVisualViewport(target: AppViewportTarget | undefined): number | null {
  const viewport = target?.visualViewport;
  if (!viewport || !usable(viewport.height)) return null;
  const scale = usable(viewport.scale) ? viewport.scale : 1;
  const offsetTop = usable(viewport.offsetTop) ? viewport.offsetTop : 0;
  return viewport.height * scale + offsetTop;
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
 * a rotation arrives on `window`.
 */
export function observeAppViewportHeight(
  target: AppViewportTarget | undefined,
): (() => void) | undefined {
  if (!target) return undefined;
  applyAppViewportHeight(target);

  const update = () => {
    applyAppViewportHeight(target);
  };
  const sources: AppViewportEventSource[] = [];
  if (target.visualViewport) sources.push(target.visualViewport);

  for (const source of sources) {
    source.addEventListener?.("resize", update);
    source.addEventListener?.("scroll", update);
  }
  target.addEventListener?.("resize", update);
  target.addEventListener?.("orientationchange", update);

  return () => {
    for (const source of sources) {
      source.removeEventListener?.("resize", update);
      source.removeEventListener?.("scroll", update);
    }
    target.removeEventListener?.("resize", update);
    target.removeEventListener?.("orientationchange", update);
  };
}
