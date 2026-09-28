import { useEffect, useState } from "react";
import { Dimensions, Keyboard, Platform } from "react-native";

/**
 * How much of the screen the keyboard covers, in the same units as the layout.
 *
 * iOS reports this through `Keyboard`. Android reports 0 on purpose:
 * `adjustResize` already shrinks the window, so a second lift would move the
 * footer twice.
 *
 * Web reports 0 for the same reason: the app's own frame follows the visual
 * viewport there (lib/web/appViewportHeight), which is what the browser shrinks
 * when the keyboard appears — so the screen is already inset by the keyboard and a
 * footer lifted by this value too would move twice. It used to read the visual
 * viewport here, from when the frame ignored it.
 */
export function useKeyboardHeight(): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "ios") {
      return;
    }
    const showEvent = "keyboardWillShow" as const;
    const hideEvent = "keyboardWillHide" as const;

    const onShow = (e: any) => setKeyboardHeight(e?.endCoordinates?.height ?? 0);
    const onHide = () => setKeyboardHeight(0);

    const subShow = Keyboard.addListener(showEvent, onShow);
    const subHide = Keyboard.addListener(hideEvent, onHide);

    const subChange = Keyboard.addListener("keyboardWillChangeFrame", (e: any) => {
      try {
        const screenHeight = Dimensions.get("screen").height;
        const endY = e?.endCoordinates?.screenY ?? screenHeight;
        const h = Math.max(0, screenHeight - endY);
        setKeyboardHeight(h);
      } catch {}
    });

    return () => {
      subShow.remove();
      subHide.remove();
      subChange.remove();
    };
  }, []);

  return Platform.OS === "ios" ? keyboardHeight : 0;
}
