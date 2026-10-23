import { useEffect, useState } from "react";
import { Platform } from "react-native";

/**
 * The one query that means "a desktop browser": a fine pointer that hovers. It
 * is the same string `public/index.html` uses to drop the phone-width cap for
 * the DesktopGate, so the CSS and the screens that need to know cannot drift.
 */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

/**
 * True on a desktop browser (mouse/trackpad, not a touch screen). Web only:
 * native always answers false, because a native build is never driven by a
 * hovering pointer.
 */
export function useFinePointer(): boolean {
  const [isFine, setIsFine] = useState(
    () =>
      Platform.OS === "web" &&
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.(FINE_POINTER_QUERY).matches),
  );
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(FINE_POINTER_QUERY);
    const onChange = () => setIsFine(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return isFine;
}
