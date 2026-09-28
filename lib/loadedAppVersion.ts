import * as Updates from "expo-updates";
import { Platform } from "react-native";
import { getBundleAppVersion } from "../services/app/AppUpdateService";

// Compiled into this JS release. Never read deployment.json: an open tab may
// still run an older bundle after the server has deployed a newer release.
export const JS_RELEASE_VERSION = "0.97.0";

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
