import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  APP_VIEWPORT_HEIGHT_PROPERTY,
  applyAppViewportHeight,
  measureAppViewportHeight,
  observeAppViewportHeight,
  type AppViewportTarget,
} from "./appViewportHeight";

type FakeWindow = AppViewportTarget & {
  listeners: Map<string, Set<() => void>>;
  visualViewportListeners: Map<string, Set<() => void>>;
  written: string[];
  emit: (type: string, source?: "window" | "visualViewport") => void;
};

type FakeWindowOptions = {
  innerHeight?: number;
  clientHeight?: number;
  /** The area between the browser's bars, as the browser reports it. */
  visualHeight?: number;
  visualScale?: number;
  /** How far the browser has panned that window down the document. */
  visualOffset?: number;
};

function fakeWindow(overrides: FakeWindowOptions = {}): FakeWindow {
  const listeners = new Map<string, Set<() => void>>();
  const visualViewportListeners = new Map<string, Set<() => void>>();
  const written: string[] = [];

  const track = (store: Map<string, Set<() => void>>) => ({
    addEventListener: (type: string, listener: () => void) => {
      const set = store.get(type) ?? new Set();
      set.add(listener);
      store.set(type, set);
    },
    removeEventListener: (type: string, listener: () => void) => {
      store.get(type)?.delete(listener);
    },
  });

  const target: FakeWindow = {
    innerHeight: overrides.innerHeight,
    document: {
      documentElement: {
        clientHeight: overrides.clientHeight,
        style: {
          setProperty: (property: string, value: string) => {
            written.push(`${property}:${value}`);
          },
        },
      },
    },
    visualViewport: {
      ...track(visualViewportListeners),
      height: overrides.visualHeight,
      scale: overrides.visualScale,
      offsetTop: overrides.visualOffset,
    },
    ...track(listeners),
    listeners,
    visualViewportListeners,
    written,
    emit: (type: string, source = "window") => {
      const store = source === "window" ? listeners : visualViewportListeners;
      for (const listener of store.get(type) ?? []) listener();
    },
  };
  return target;
}

describe("measureAppViewportHeight", () => {
  it("reads the live layout viewport when the browser has no chrome to subtract", () => {
    expect(measureAppViewportHeight(fakeWindow({ innerHeight: 664 }))).toBe(664);
  });

  // The #1372 case: a Safari tab reports the full screen as innerHeight and the
  // area between its bars as the visual viewport, and the app has to be the
  // smaller one or its bottom rows stay under the bars, unreachable.
  it("takes the visual viewport when browser chrome is what shrinks it", () => {
    expect(measureAppViewportHeight(fakeWindow({ innerHeight: 844, visualHeight: 724 }))).toBe(724);
  });

  // No threshold anywhere: a keyboard shrinks the visual viewport too, so the app
  // follows it there as well — which is what native does when it pads the frame by
  // the keyboard inset, and why the web no longer lifts a footer a second time
  // (lib/useKeyboardHeight returns 0 on web).
  it("follows the visual viewport for a keyboard-sized deficit too", () => {
    expect(measureAppViewportHeight(fakeWindow({ innerHeight: 844, visualHeight: 520 }))).toBe(520);
    expect(measureAppViewportHeight(fakeWindow({ innerHeight: 844, visualHeight: 504 }))).toBe(504);
  });

  // iOS pans the visual viewport when an input is focused, so the visible interval
  // starts below the document's top. A frame anchored at Y=0 sized by the height
  // alone would end `offsetTop` px above the visible bottom — the onboarding footer
  // would float above the keyboard — so the measurement is the window's END.
  it("accounts for a panned visual viewport", () => {
    expect(
      measureAppViewportHeight(
        fakeWindow({ innerHeight: 844, visualHeight: 724, visualOffset: 60 }),
      ),
    ).toBe(784);
  });

  it("ignores an unusable visual viewport offset", () => {
    for (const visualOffset of [undefined, 0, -1, Number.NaN]) {
      expect(
        measureAppViewportHeight(fakeWindow({ innerHeight: 844, visualHeight: 724, visualOffset })),
      ).toBe(724);
    }
  });

  // React Native Web's own scaling: pinch zoom shrinks the visual viewport without
  // meaning the layout should shrink with it.
  it("scales the visual viewport the way the modals' window dimensions do", () => {
    expect(
      measureAppViewportHeight(
        fakeWindow({ innerHeight: 900, visualHeight: 620, visualScale: 1.4 }),
      ),
    ).toBe(868);
  });

  it("ignores an unusable visual viewport", () => {
    for (const visualHeight of [undefined, 0, Number.NaN]) {
      expect(measureAppViewportHeight(fakeWindow({ innerHeight: 664, visualHeight }))).toBe(664);
    }
  });

  it("uses the visual viewport when the layout viewport is unusable", () => {
    expect(measureAppViewportHeight(fakeWindow({ visualHeight: 664 }))).toBe(664);
  });

  it("rounds a fractional viewport", () => {
    expect(measureAppViewportHeight(fakeWindow({ innerHeight: 664.4 }))).toBe(664);
    expect(measureAppViewportHeight(fakeWindow({ innerHeight: 844, visualHeight: 723.6 }))).toBe(
      724,
    );
  });

  // A browser that reports nothing usable must not become a zero-height app: the
  // stylesheet's own fallback is the better answer.
  it("falls back to documentElement.clientHeight", () => {
    expect(measureAppViewportHeight(fakeWindow({ clientHeight: 700 }))).toBe(700);
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores an unusable innerHeight (%s)",
    (innerHeight) => {
      expect(
        measureAppViewportHeight(fakeWindow({ innerHeight: innerHeight as number })),
      ).toBeNull();
    },
  );

  it("returns null with no target at all", () => {
    expect(measureAppViewportHeight(undefined)).toBeNull();
  });
});

describe("applyAppViewportHeight", () => {
  it("writes the measured height as the root custom property", () => {
    const target = fakeWindow({ innerHeight: 664 });
    expect(applyAppViewportHeight(target)).toBe(664);
    expect(target.written).toEqual([`${APP_VIEWPORT_HEIGHT_PROPERTY}:664px`]);
  });

  it("writes nothing when the viewport cannot be measured", () => {
    const target = fakeWindow({});
    expect(applyAppViewportHeight(target)).toBeNull();
    expect(target.written).toEqual([]);
  });

  it("survives a document that cannot take the property", () => {
    expect(applyAppViewportHeight({ innerHeight: 664 })).toBeNull();
  });
});

describe("observeAppViewportHeight", () => {
  it("applies once on subscribe", () => {
    const target = fakeWindow({ innerHeight: 664 });
    observeAppViewportHeight(target);
    expect(target.written).toEqual([`${APP_VIEWPORT_HEIGHT_PROPERTY}:664px`]);
  });

  // The layout viewport moves with Safari's dynamic toolbar, which is the whole
  // point: a one-shot read at launch leaves the app sized for the toolbar state
  // of that instant (the #1372 home kept its bottom rows under the toolbar).
  it("follows the window resizing", () => {
    const target = fakeWindow({ innerHeight: 664 });
    observeAppViewportHeight(target);
    target.innerHeight = 712;
    target.emit("resize");
    expect(target.written.at(-1)).toBe(`${APP_VIEWPORT_HEIGHT_PROPERTY}:712px`);
  });

  it("follows an orientation change and the visual viewport's own resize", () => {
    const target = fakeWindow({ innerHeight: 664 });
    observeAppViewportHeight(target);
    target.innerHeight = 390;
    target.emit("orientationchange");
    expect(target.written.at(-1)).toBe(`${APP_VIEWPORT_HEIGHT_PROPERTY}:390px`);
    target.innerHeight = 388;
    target.emit("resize", "visualViewport");
    expect(target.written.at(-1)).toBe(`${APP_VIEWPORT_HEIGHT_PROPERTY}:388px`);
  });

  // The bars ARE the visual viewport, and iOS also pans the page as they move, so
  // both of its events have to re-apply the measurement.
  it("follows the browser's bars appearing and going, via the visual viewport", () => {
    const target = fakeWindow({ innerHeight: 844, visualHeight: 844 });
    observeAppViewportHeight(target);
    expect(target.written.at(-1)).toBe(`${APP_VIEWPORT_HEIGHT_PROPERTY}:844px`);
    if (target.visualViewport) target.visualViewport.height = 724;
    target.emit("resize", "visualViewport");
    expect(target.written.at(-1)).toBe(`${APP_VIEWPORT_HEIGHT_PROPERTY}:724px`);
    if (target.visualViewport) target.visualViewport.height = 844;
    target.emit("scroll", "visualViewport");
    expect(target.written.at(-1)).toBe(`${APP_VIEWPORT_HEIGHT_PROPERTY}:844px`);
  });

  it("stops following after teardown", () => {
    const target = fakeWindow({ innerHeight: 664 });
    const stop = observeAppViewportHeight(target);
    stop?.();
    target.innerHeight = 500;
    target.emit("resize");
    target.emit("resize", "visualViewport");
    target.emit("scroll", "visualViewport");
    target.emit("orientationchange");
    expect(target.written).toEqual([`${APP_VIEWPORT_HEIGHT_PROPERTY}:664px`]);
  });

  it("is a no-op without a window (native, headless render)", () => {
    expect(observeAppViewportHeight(undefined)).toBeUndefined();
  });

  it("removes every listener it added", () => {
    const target = fakeWindow({ innerHeight: 664 });
    const remove = vi.spyOn(target, "removeEventListener");
    observeAppViewportHeight(target)?.();
    expect(remove.mock.calls.map(([type]) => type).sort()).toEqual(["orientationchange", "resize"]);
  });
});

// The custom property is written by the app (App.tsx), so the stylesheet half of the
// contract is asserted here: `#root` must resolve its height against it, keep a
// viewport-unit fallback for a script-less load, and let the INSTALLED PWA override
// to the full screen (that context has no browser chrome, and the small-viewport
// units stop ~47px short of it).
describe("public/index.html root height", () => {
  const html = readFileSync(path.join(__dirname, "../../public/index.html"), "utf8");
  const standaloneBlock = (() => {
    const start = html.indexOf("@media all and (display-mode: standalone)");
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("}", html.indexOf("#root", start)) + 1);
  })();

  it("sizes #root from the measured viewport height, falling back to svh", () => {
    expect(html).toMatch(/height:\s*var\(--nuri-viewport-height,\s*100svh\)/);
  });

  // The installed PWA has no browser chrome, so its FALLBACK is the full screen —
  // but the measurement still has to win there. The frame follows the visual
  // viewport in every context (that is what makes web keyboard handling
  // unnecessary: lib/useKeyboardHeight returns 0 on web), and a hard
  // `height: 100vh` in this block takes that away in exactly the context where a
  // keyboard appears: onboarding, with Continue behind it.
  it("lets the measured height win in the installed PWA too", () => {
    const rootRule = standaloneBlock.slice(standaloneBlock.indexOf("#root"));
    expect(rootRule).toMatch(/height:\s*var\(--nuri-viewport-height,\s*100vh\)/);
    expect(rootRule).not.toMatch(/height:\s*100vh\s*;/);
  });

  it("keeps that block after the base rule, so the tab fallback is unaffected", () => {
    expect(html.indexOf("display-mode: standalone")).toBeGreaterThan(
      html.indexOf("var(--nuri-viewport-height"),
    );
  });

  it("still locks the document", () => {
    expect(html).toMatch(/body\s*\{[^}]*overflow:\s*hidden/);
  });
});

// The stylesheet and the hook are ONE contract: the frame follows the visual
// viewport in every context, so nothing on the web may lift a footer by the
// keyboard a second time. Asserted across both files, because a change to either
// half silently breaks the other and the vitest lane has no renderer for the hook.
describe("the web keyboard contract", () => {
  const hook = readFileSync(path.join(__dirname, "../../lib/useKeyboardHeight.ts"), "utf8");
  const html = readFileSync(path.join(__dirname, "../../public/index.html"), "utf8");

  it("lifts a footer only on iOS, where the frame cannot follow the keyboard", () => {
    expect(hook).toMatch(/return Platform\.OS === "ios" \? keyboardHeight : 0;/);
  });

  it("pins no context's #root to a viewport unit, which is what would break it", () => {
    // Every #root rule that sets a HEIGHT resolves through the measured property:
    // the base rule and the installed-PWA block (the width-cap rules set no height).
    const rootRules = (html.match(/#root\s*\{[^}]*\}/g) ?? []).filter((rule) =>
      /height:/.test(rule),
    );
    expect(rootRules.length).toBeGreaterThan(1);
    for (const rule of rootRules) {
      expect(rule).toMatch(/height:\s*var\(--nuri-viewport-height/);
    }
  });
});

// The property has ONE writer, and it must sit in the root that EVERY route shares.
// `App` picks between two roots (`PayLinkApp` for /pay/@username, `WalletApp`
// otherwise) and `#root` is the same element for both, so an observer mounted
// inside either one leaves the other route on the broken svh fallback: the payment
// link's own keypad footer was reported hidden under browser chrome for exactly
// this reason. A source-level guard, because the app has no renderer in this lane.
describe("App.tsx wiring", () => {
  const app = readFileSync(path.join(__dirname, "../../App.tsx"), "utf8");

  it("installs the observer once", () => {
    // One call site only: two observers would just write the same measurement twice.
    const callSites = app.match(/observeAppViewportHeight\(/g) ?? [];
    expect(callSites).toHaveLength(1);
    expect(app).toMatch(
      /import \{ observeAppViewportHeight \} from "\.\/lib\/web\/appViewportHeight"/,
    );
  });

  it("installs it in the shared App root, not in a route's own root", () => {
    const appRoot = app.indexOf("export default function App(");
    const payLinkRoot = app.indexOf("function PayLinkApp(");
    const walletRoot = app.indexOf("function WalletApp(");
    const callSite = app.indexOf("observeAppViewportHeight(");
    expect(appRoot).toBeGreaterThan(-1);
    expect(payLinkRoot).toBeGreaterThan(appRoot);
    expect(walletRoot).toBeGreaterThan(payLinkRoot);
    expect(callSite).toBeGreaterThan(appRoot);
    expect(callSite).toBeLessThan(payLinkRoot);
  });
});
