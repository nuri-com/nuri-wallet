import { Platform } from "react-native";

// biome-ignore lint/suspicious/noExplicitAny: native SDK bridge is untyped
type SumsubSdk = any;

let cached: SumsubSdk | undefined;

/**
 * Lazy-load the Sumsub React Native bridge. The native module ships
 * device-fingerprinting code; deferring `require()` keeps it out of the
 * cold-start path so it only loads when the KYC flow is actually launched.
 */
export function getSumsubSdk(): SumsubSdk {
  if (cached !== undefined) return cached;
  if (Platform.OS === "web") {
    cached = null;
    return cached;
  }
  try {
    cached = require("@sumsub/react-native-mobilesdk-module");
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Launch the native Sumsub Mobile SDK with an access token and await the flow's
 * completion. Throws `sumsub_sdk_unavailable` when the native bridge isn't
 * present (web, or the module failed to load) so callers can fall back to the
 * hosted webview. Single source for the init → build → launch sequence.
 */
export async function launchSumsubSdk(params: {
  token: string;
  locale?: string;
  // biome-ignore lint/suspicious/noExplicitAny: native SDK launch result is untyped
}): Promise<any> {
  const SNSMobileSDK = getSumsubSdk();
  if (!SNSMobileSDK || typeof SNSMobileSDK.init !== "function") {
    throw new Error("sumsub_sdk_unavailable");
  }
  const { token, locale = "en" } = params;
  // One access token per KYC session; hand the same one back on the SDK's
  // expiry callback.
  const instance = SNSMobileSDK.init(token, async () => token)
    .withLocale(locale)
    .withDebug(__DEV__ === true)
    .withAnalyticsEnabled(false)
    .build();
  try {
    return await instance.launch();
  } catch (error) {
    try {
      instance?.dismiss?.();
    } catch {}
    throw error;
  }
}
