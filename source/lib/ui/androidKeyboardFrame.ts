// How much of the keyboard a full page on Android is pushed up by twice.
//
// The DS full modal lifts its content by the keyboard's height (it pads its
// surface by the keyboard inset). On Android phones that ALSO shrink the app
// window above the keyboard (adjustResize honoured, typically Android 14 and
// older), the page is then lifted a second time: the content ends a keyboard
// height above the keyboard, the Continue button jumps up under the field, and
// the band between it and the keyboard is see-through, showing the home behind
// it. Phones that keep the window full size (edge-to-edge, Android 15+) are lifted
// once and stay untouched here.
//
// The vendored DS is not ours to change, so the app measures both sides and
// cancels only the overlap: the app frame's shrink FOR THE KEYBOARD (from a probe
// at the app root) and the DS padding (frame height minus the page panel's height).
//
// The hard part is telling a keyboard shrink from a real window resize (split
// screen, freeform), because the shrink can lay out just before the keyboard
// event arrives. Every height change while the keyboard is hidden is taken as a
// real resize and becomes the new resting height. Only a shrink that lands
// shortly before the keyboard opens AND matches the keyboard's height is undone
// as the keyboard's own; anything else keeps the resized height as resting.

/** How long before the keyboard event a shrink may still be the keyboard's. */
export const PRE_SHOW_WINDOW_MS = 1000;
/** Slack between the window shrink and the reported keyboard height (nav bar strip). */
export const KEYBOARD_MATCH_SLACK = 96;

type PendingShrink = { restingHeight: number; at: number };

export type AppFrameState = {
  /** Current height of the app root frame, null until measured. */
  frameHeight: number | null;
  /** The frame height without a keyboard, for the current window size. */
  restingHeight: number | null;
  width: number | null;
  keyboardVisible: boolean;
  keyboardHeight: number;
  /** The resting height before the latest keyboard-hidden shrink. */
  pendingShrink: PendingShrink | null;
};

export const INITIAL_APP_FRAME: AppFrameState = {
  frameHeight: null,
  restingHeight: null,
  width: null,
  keyboardVisible: false,
  keyboardHeight: 0,
  pendingShrink: null,
};

function rounded(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** A new root layout at time `now` (ms). */
export function withFrameLayout(
  state: AppFrameState,
  width: number,
  height: number,
  now: number,
): AppFrameState {
  const w = rounded(width);
  const h = rounded(height);
  if (w === null || h === null) return state;
  // First layout or a width change (rotation): start over.
  if (state.width !== w || state.restingHeight === null) {
    return { ...state, width: w, frameHeight: h, restingHeight: h, pendingShrink: null };
  }
  if (state.frameHeight === h) return state;
  // While the keyboard is up the resting height is fixed for this cycle.
  if (state.keyboardVisible) return { ...state, frameHeight: h };
  // Keyboard hidden: a real resize, unless the keyboard opens right after it.
  const pendingShrink =
    h < state.restingHeight ? { restingHeight: state.restingHeight, at: now } : null;
  return { ...state, frameHeight: h, restingHeight: h, pendingShrink };
}

/** The keyboard opened at time `now` with the height Android reported. */
export function withKeyboardShown(
  state: AppFrameState,
  keyboardHeight: number,
  now: number,
): AppFrameState {
  const kb = rounded(keyboardHeight) ?? 0;
  let restingHeight = state.restingHeight;
  const pending = state.pendingShrink;
  if (pending && state.frameHeight !== null && now - pending.at <= PRE_SHOW_WINDOW_MS) {
    const shrink = pending.restingHeight - state.frameHeight;
    if (kb > 0 && Math.abs(shrink - kb) <= KEYBOARD_MATCH_SLACK) {
      restingHeight = pending.restingHeight;
    }
  }
  return {
    ...state,
    keyboardVisible: true,
    keyboardHeight: kb,
    restingHeight,
    pendingShrink: null,
  };
}

/** The keyboard closed: whatever the frame is now is resting until it grows back. */
export function withKeyboardHidden(state: AppFrameState): AppFrameState {
  if (!state.keyboardVisible) return state;
  return {
    ...state,
    keyboardVisible: false,
    keyboardHeight: 0,
    restingHeight: state.frameHeight ?? state.restingHeight,
    pendingShrink: null,
  };
}

/** How far the app frame itself shrank for the keyboard. */
export function frameKeyboardShrink(state: AppFrameState): number {
  if (!state.keyboardVisible || state.frameHeight === null || state.restingHeight === null)
    return 0;
  const shrink = Math.max(0, state.restingHeight - state.frameHeight);
  // Never more than the keyboard itself (plus the nav bar strip).
  return Math.min(shrink, state.keyboardHeight + KEYBOARD_MATCH_SLACK);
}

/**
 * The part of the DS keyboard padding that the frame shrink already covers.
 * `panelHeight` is the full page's panel: the frame minus the DS padding.
 */
export function doubleCountedKeyboardInset(
  state: AppFrameState,
  panelHeight: number | null,
): number {
  const shrink = frameKeyboardShrink(state);
  if (shrink === 0 || state.frameHeight === null || panelHeight === null) return 0;
  const padding = Math.max(0, state.frameHeight - Math.round(panelHeight));
  return Math.min(padding, shrink);
}

// ── store ────────────────────────────────────────────────────────────────

let current: AppFrameState = INITIAL_APP_FRAME;
const listeners = new Set<() => void>();

function set(next: AppFrameState): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch {}
  }
}

export function reportAppFrameLayout(width: number, height: number): void {
  set(withFrameLayout(current, width, height, Date.now()));
}

export function reportKeyboardShown(keyboardHeight: number): void {
  set(withKeyboardShown(current, keyboardHeight, Date.now()));
}

export function reportKeyboardHidden(): void {
  set(withKeyboardHidden(current));
}

export function getAppFrame(): AppFrameState {
  return current;
}

export function subscribeAppFrame(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function resetAppFrameForTests(): void {
  current = INITIAL_APP_FRAME;
  listeners.clear();
}
