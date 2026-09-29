import * as Updates from "expo-updates";
import { Platform } from "react-native";
import { getBundleAppVersion } from "../services/app/AppUpdateService";

// Compiled into this JS release. Never read deployment.json: an open tab may
// still run an older bundle after the server has deployed a newer release.
export const JS_RELEASE_VERSION = "0.97.0";

/**
 * The version the user is running: the manifest of the JS bundle actually
 * loaded, so an OTA moves it (the store binary's Info.plist version would not).
 * Falls back to the compiled release constant when no manifest is readable.
 */
export function getAppVersion(): string {
  return getBundleAppVersion() || JS_RELEASE_VERSION;
}

export function getLoadedAppIdentity(): string {
  if (Platform.OS === "web") return `${JS_RELEASE_VERSION} · web`;
  const source = Updates.isEmbeddedLaunch
    ? "embedded"
    : Updates.updateId
      ? `OTA ${Updates.updateId}`
      : "development";
  const manifestVersion = getBundleAppVersion();
  const metadata = Updates.runtimeVersion
    ? ` · runtime ${Updates.runtimeVersion}`
    : manifestVersion
      ? ` · manifest ${manifestVersion}`
      : "";
  return `${JS_RELEASE_VERSION} · ${Platform.OS} · ${source}${metadata}`;
}
