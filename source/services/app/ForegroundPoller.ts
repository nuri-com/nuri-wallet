// services/app/ForegroundPoller.ts
//
// A poll loop that runs while the app is in the foreground and nothing else.
// Every balance poll in the app used to be a screen effect keyed on
// `isActive && isAppActive`, so it existed only while a tab was mounted. With a
// single screen there is no tab visibility left to key on, and the figures still
// have to be current the moment anything renders them — so the gate is the app's
// own foreground state and the loop lives here, startable by a caller that has
// no React tree at all.

import { AppState } from "react-native";

export type ForegroundPoller = {
  /** Idempotent: starting an already-running loop is a no-op. */
  start(): void;
  stop(): void;
  isRunning(): boolean;
};

export function isAppForeground(): boolean {
  return AppState.currentState === "active";
}

/**
 * Fires every time the app becomes active. For work that has to be current when
 * the user comes back but has no cadence of its own to repeat on.
 */
export function onAppForegroundEnter(listener: () => void): () => void {
  let wasForeground = isAppForeground();
  const sub = AppState.addEventListener("change", (next) => {
    const isForeground = next === "active";
    const entered = isForeground && !wasForeground;
    wasForeground = isForeground;
    if (entered) listener();
  });
  return () => sub.remove();
}

export function createForegroundPoller(options: {
  intervalMs: number;
  tick: () => void;
  /**
   * Second gate, checked per tick — offline, for instance. Kept as a predicate
   * so this module stays a timer and nothing else: whatever the extra condition
   * is, only the driver that has it knows how to read it.
   */
  canTick?: () => boolean;
}): ForegroundPoller {
  const { intervalMs, tick, canTick } = options;

  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let removeAppStateListener: (() => void) | null = null;

  const guardedTick = (): void => {
    if (canTick && !canTick()) return;
    tick();
  };

  const evaluate = (): void => {
    if (!running || !isAppForeground()) {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      return;
    }
    if (timer !== null) return;
    timer = setInterval(guardedTick, intervalMs);
    // Fire on the transition, not a full interval later: returning to the app
    // must show current figures, which is what the screen effects did too.
    guardedTick();
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      const subscription = AppState.addEventListener("change", evaluate);
      removeAppStateListener = () => subscription.remove();
      evaluate();
    },
    stop(): void {
      running = false;
      try {
        removeAppStateListener?.();
      } catch {}
      removeAppStateListener = null;
      evaluate();
    },
    isRunning(): boolean {
      return running;
    },
  };
}
