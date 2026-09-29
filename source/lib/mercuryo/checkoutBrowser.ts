// Hands Mercuryo checkout to the OS browser. Separate from ./helpers so the pure
// status logic stays importable without an expo-web-browser dependency.
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { log } from "../../services/logging/LoggerService";
import { CHROME_PACKAGE } from "../../config/constants";
import { errMsg } from "../errorMessage";
import { mercuryoFlowLog, safeUrlForLog } from "./helpers";

/**
 * Opens checkout in the OS browser (Chrome Custom Tab / SFSafariViewController)
 * rather than an in-app WebView: Mercuryo requires identity verification for
 * every user, and that flow needs the camera, the browser's own session and
 * Apple Pay's web integration — none of which an embedded WebView is a
 * dependable host for. Web has no native container and opens a tab instead.
 */
export const openExternalCheckout = async (url: string) => {
  if (Platform.OS !== "android" && Platform.OS !== "ios") return;
  const isAndroid = Platform.OS === "android";
  mercuryoFlowLog("external_browser_open_start", {
    platform: Platform.OS,
    url: safeUrlForLog(url),
  });
  if (isAndroid) {
    try {
      await WebBrowser.mayInitWithUrlAsync(url, CHROME_PACKAGE);
    } catch {
      try {
        await WebBrowser.mayInitWithUrlAsync(url);
      } catch {}
    }
  }
  try {
    await WebBrowser.openBrowserAsync(url, {
      ...(isAndroid ? { browserPackage: CHROME_PACKAGE } : {}),
      enableBarCollapsing: true,
      showTitle: true,
    });
  } catch (err: unknown) {
    // Android only: the preferred package may not be installed, so retry
    // without it. On iOS there is no second container to fall back to.
    try {
      if (!isAndroid) throw err;
      await WebBrowser.openBrowserAsync(url, {
        enableBarCollapsing: true,
        showTitle: true,
      });
    } catch (fallbackErr: unknown) {
      const errMessage = errMsg(err);
      const fallbackMessage = errMsg(fallbackErr);
      const msg = fallbackMessage || errMessage || String(fallbackErr || err);
      log("[MercuryoBuyBitcoinModal] open browser failed", msg);
      mercuryoFlowLog("external_browser_open_failed", {
        platform: Platform.OS,
        error: msg,
      });
    }
  }
};

/** Android-only Custom Tab warm-up; a no-op everywhere else. */
export const prewarmExternalCheckout = async (url: string) => {
  if (Platform.OS !== "android") return;
  try {
    await WebBrowser.warmUpAsync(CHROME_PACKAGE);
  } catch {
    try {
      await WebBrowser.warmUpAsync();
    } catch {}
  }
  try {
    await WebBrowser.mayInitWithUrlAsync(url, CHROME_PACKAGE);
  } catch {
    try {
      await WebBrowser.mayInitWithUrlAsync(url);
    } catch {}
  }
};
