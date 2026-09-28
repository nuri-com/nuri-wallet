import { useEffect, type RefObject } from "react";
import { InteractionManager, Keyboard, Platform } from "react-native";

// Anything focusable: RN TextInput or a DS TextFieldHandle. focusOnce only
// touches focus/blur/setNativeProps, all optional-chained.
type FocusableInput = {
  focus?: () => void;
  blur?: () => void;
  setNativeProps?: (props: object) => void;
};

type FocusOptions = {
  delayMs?: number;
  retryCount?: number;
  retryIntervalMs?: number;
  blurBeforeFocus?: boolean;
  retryBlur?: boolean;
  stopOnKeyboardShow?: boolean;
  maxDurationMs?: number;
};

export const focusAndroidTextInput = (
  ref: RefObject<FocusableInput | null>,
  options: FocusOptions = {},
) => {
  if (Platform.OS !== "android") return () => {};
  let cancelled = false;
  let keyboardShown = false;
  const {
    delayMs = 100,
    retryCount = 6,
    retryIntervalMs = 180,
    blurBeforeFocus = true,
    retryBlur = true,
    stopOnKeyboardShow = true,
    maxDurationMs = 2200,
  } = options;

  let softInputEnabled = false;
  let blurredForSequence = false;
  const focusOnce = (doBlur = blurBeforeFocus) => {
    if (cancelled) return;
    const node = ref.current;
    if (!node) return;
    if (!softInputEnabled) {
      softInputEnabled = true;
      try {
        node.setNativeProps?.({ showSoftInputOnFocus: true });
      } catch {}
    }
    if (doBlur && !blurredForSequence) {
      blurredForSequence = true;
      try {
        node.blur?.();
      } catch {}
    }
    try {
      node.focus?.();
    } catch {}
  };

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const schedule = (ms: number) => {
    timers.push(
      setTimeout(() => {
        if (cancelled || keyboardShown) return;
        focusOnce();
      }, ms),
    );
  };

  schedule(delayMs);
  for (let i = 0; i < retryCount; i += 1) {
    const ms = delayMs + (i + 1) * retryIntervalMs;
    timers.push(
      setTimeout(() => {
        if (cancelled) return;
        if (keyboardShown) return;
        focusOnce(retryBlur);
      }, ms),
    );
  }

  const interaction =
    delayMs === 0
      ? InteractionManager.runAfterInteractions(() => {
          if (cancelled || keyboardShown) return;
          focusOnce();
          schedule(retryIntervalMs);
        })
      : null;

  const keyboardSub = stopOnKeyboardShow
    ? Keyboard.addListener("keyboardDidShow", () => {
        keyboardShown = true;
        cancelled = true;
        timers.forEach((t) => clearTimeout(t));
      })
    : null;

  const cleanup = () => {
    cancelled = true;
    timers.forEach((t) => clearTimeout(t));
    keyboardSub?.remove?.();
    try {
      interaction?.cancel?.();
    } catch {}
  };

  if (maxDurationMs > 0) {
    timers.push(
      setTimeout(() => {
        cleanup();
      }, maxDurationMs),
    );
  }

  return cleanup;
};

export const useAndroidAutofocus = (ref: RefObject<FocusableInput | null>, enabled: boolean) => {
  useEffect(() => {
    if (Platform.OS !== "android") return undefined;
    if (!enabled) return undefined;
    return focusAndroidTextInput(ref);
  }, [enabled, ref]);
};
