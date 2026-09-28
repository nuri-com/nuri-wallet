import { ExpoConfig } from "@expo/config";

// For new releases, bump only the marketing `appVersion` below
// (or run `node scripts/bump-version.mjs`). Build numbers
// (iosBuildNumber / androidVersionCode) are owned by EAS in the
// cloud via `appVersionSource: "remote"` + `autoIncrement: true`
// in eas.json — they're auto-bumped per build.
// Allow configuring key values (name, bundle IDs, schemes, domains) via envs.
// This makes it easy to rebrand or switch companies without editing code.
type AppVariant = "development" | "preview" | "production";

const DEFAULT_PAYMENT_SCHEMES = ["lightning", "bitcoin", "btc", "ln"];

function splitCsv(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveVariant(value: string | undefined): AppVariant {
  const normalized = String(value ?? "").toLowerCase();

  if (["production", "prod", "release"].includes(normalized)) return "production";
  if (normalized === "preview") return "preview";
  return "development";
}

const variant = resolveVariant(
  process.env.APP_VARIANT ?? process.env.EAS_BUILD_PROFILE ?? process.env.NODE_ENV,
);
const isProd = variant === "production";

const variantDefaults: Record<
  AppVariant,
  {
    appName: string;
    iosBundleId: string;
    androidPackage: string;
    schemes: string[];
    iconPath: string;
    splashPath: string;
  }
> = {
  development: {
    appName: "Nuri Dev",
    iosBundleId: "com.nuri.nuriwallet.dev",
    androidPackage: "com.nuri.mobileios.dev",
    schemes: ["nuri-dev", "nuriwallet-dev", ...DEFAULT_PAYMENT_SCHEMES],
    iconPath: "./assets/app-variants/development/icon.png",
    splashPath: "./assets/app-variants/development/splash.png",
  },
  preview: {
    appName: "Nuri Preview",
    iosBundleId: "com.nuri.nuriwallet.preview",
    androidPackage: "com.nuri.mobileios.preview",
    schemes: ["nuri-preview", "nuriwallet-preview", ...DEFAULT_PAYMENT_SCHEMES],
    iconPath: "./assets/app-variants/preview/icon.png",
    splashPath: "./assets/app-variants/preview/splash.png",
  },
  production: {
    appName: "Nuri.com",
    iosBundleId: "com.nuri.nuriwallet",
    androidPackage: "com.nuri.mobileios",
    schemes: ["nuri", "nuriwallet", ...DEFAULT_PAYMENT_SCHEMES],
    iconPath: "./assets/app-variants/production/icon.png",
    splashPath: "./assets/app-variants/production/splash.png",
  },
};

const appDefaults = variantDefaults[variant];
const appName = process.env.APP_NAME ?? appDefaults.appName;
// Keep the Expo slug aligned with the linked EAS projectId across profiles.
// Variant-specific native bundle IDs still come from APP_VARIANT below.
const appSlug = process.env.APP_SLUG ?? "nuricom";
const appVersion = "0.99.2";
const iosBundleId = process.env.IOS_BUNDLE_ID ?? appDefaults.iosBundleId;
// Build numbers are managed remotely by EAS (`appVersionSource: "remote"` +
// `autoIncrement: true` in eas.json) — values below are placeholders that EAS
// overrides at build time. Keeping them static (not Date.now()-derived)
// ensures the runtime fingerprint is stable across config evaluations.
const iosBuildNumber = process.env.IOS_BUILD_NUMBER ?? "1";
const androidPackage = process.env.ANDROID_PACKAGE ?? appDefaults.androidPackage;
const androidVersionCode = Number(process.env.ANDROID_VERSION_CODE ?? 1);

const schemes = splitCsv(process.env.APP_SCHEMES) ?? appDefaults.schemes;

const associatedDomains = splitCsv(process.env.IOS_ASSOCIATED_DOMAINS) ?? [
  "webcredentials:nuri.com",
  "webcredentials:passkey.nuri.com",
  "webcredentials:confirm.nuri.com",
];
// Info.plist values that are always required.
// NFC has been removed to avoid Transporter entitlement validation issues.
const baseInfoPlist: Record<string, string> = {
  NSCameraUsageDescription: "This app uses the camera to scan QR codes for guardian keys.",
  // Wording is pinned to what the shipped binary already carries: this key feeds
  // the iOS fingerprint, and `runtimeVersion.policy = "fingerprint"` means any
  // edit here mints a new runtime version and cuts OTA off from that build.
  // Changing it therefore requires shipping a new binary — do it only alongside
  // one. iOS shows this string once, in the "would like to use Face ID" consent
  // alert; the prompt users read on every unlock is the i18n string
  // `screen.SecureKeyStorage.storeWalletKeyPrompt`, which ships over OTA.
  NSFaceIDUsageDescription: "Authenticate with Face ID to access your wallet keys",
  NSLocationWhenInUseUsageDescription:
    "We use your location only while the app is open to improve nearby services and security.",
  NSPhotoLibraryUsageDescription:
    "We use your photo library to upload identity verification photos and to import QR codes.",
};

// ATS exceptions are useful during development, but should not ship to production.
const devATSPolicy: Record<string, unknown> = {
  NSAppTransportSecurity: {
    NSAllowsArbitraryLoads: false,
    NSExceptionDomains: {
      "exp.direct": {
        NSExceptionAllowsInsecureHTTPLoads: true,
        NSIncludesSubdomains: true,
      },
      localhost: { NSExceptionAllowsInsecureHTTPLoads: true },
      "192.168.8.104": { NSExceptionAllowsInsecureHTTPLoads: true },
      "192.168.3.1": { NSExceptionAllowsInsecureHTTPLoads: true },
    },
  },
};

const devLocalNetwork: Record<string, string | string[]> = {
  NSLocalNetworkUsageDescription:
    "Allow local network access to connect to the development server.",
  NSBonjourServices: ["_expo._tcp", "_http._tcp"],
};

const infoPlist = {
  ...baseInfoPlist,
  ...(isProd ? {} : { ...devATSPolicy, ...devLocalNetwork }),
  // iPhone: portrait only
  UISupportedInterfaceOrientations: ["UIInterfaceOrientationPortrait"],
  // iPad multitasking requires all four orientations
  "UISupportedInterfaceOrientations~ipad": [
    "UIInterfaceOrientationPortrait",
    "UIInterfaceOrientationPortraitUpsideDown",
    "UIInterfaceOrientationLandscapeLeft",
    "UIInterfaceOrientationLandscapeRight",
  ],
};

const usesNonExemptEncryption =
  (process.env.IOS_USES_NONEXEMPT_ENCRYPTION ?? "false").toLowerCase() === "true";

const plugins: NonNullable<ExpoConfig["plugins"]> = [
  "expo-camera",
  "expo-web-browser",
  "expo-sqlite",
  // Adds the iOS `aps-environment` entitlement and pulls firebase-messaging in
  // on Android. Remote push is an OS capability, so this is a fingerprint source
  // by definition: it only reaches devices through a new native build, never OTA.
  "expo-notifications",
  "./config-plugins/build/withMlKitDependencies",
  "./config-plugins/build/withNativeModules",
  ["./config-plugins/build/withSumsub", { targetVersion: "1.40.2" }],
  [
    "expo-build-properties",
    {
      ios: {
        // Ensure iOS deployment target meets PRF (Passkey) requirements
        deploymentTarget: "18.0",
      },
      android: {
        // Android 16 / API 36: Google Play requires targetSdkVersion 36
        // for production updates after 2026-08-30 (#935).
        compileSdkVersion: 36,
        targetSdkVersion: 36,
        // Android 11+: react-native-keychain can only enforce device-credential
        // auth on API 30+, so older devices cannot protect wallet keys (#585).
        // Pre-11 devices keep their installed version and stop receiving updates.
        minSdkVersion: 30,
      },
    },
  ],
];

const config: ExpoConfig = {
  name: appName,
  slug: appSlug,
  owner: "nuri-com",
  version: appVersion,
  orientation: "portrait",
  icon: process.env.APP_ICON_PATH ?? appDefaults.iconPath,
  userInterfaceStyle: "light",
  newArchEnabled: true,
  scheme: schemes,
  splash: {
    image: process.env.APP_SPLASH_PATH ?? appDefaults.splashPath,
    resizeMode: "cover",
    backgroundColor: "#ffffff",
  },
  android: {
    package: androidPackage,
    versionCode: androidVersionCode,
    // FCM config for expo-notifications; Android has no other remote-push
    // transport. ONE committed file covers every variant: google-services.json
    // carries a `client` entry per package name and the Google Services Gradle
    // plugin picks the matching one, so nothing has to be selected per build
    // profile and no variant can quietly ship without FCM. A package missing
    // from the file fails the Android build loudly rather than producing an app
    // that cannot receive notifications. The env var only points a local build
    // at a different file.
    // Trimmed-truthy, not `??`: `.env.example` ships the override as `""`, and
    // a copied-unchanged .env would otherwise count as a real override and
    // evaluate to an empty path — an Android build with no FCM config at all.
    googleServicesFile: (process.env.GOOGLE_SERVICES_JSON ?? "").trim() || "./google-services.json",
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: "nuri.com" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  ios: {
    bundleIdentifier: iosBundleId,
    buildNumber: iosBuildNumber,
    supportsTablet: true,
    config: { usesNonExemptEncryption },
    associatedDomains,
    entitlements: {
      "com.apple.developer.associated-domains": associatedDomains,
    },
    infoPlist,
  },
  plugins,
  updates: {
    url: "https://u.expo.dev/094b337a-d639-434e-8231-170d02bcb66a",
    checkAutomatically: "ON_LOAD",
    // Launch instantly with the cached bundle; let the OTA check run in the
    // background and apply on the *next* launch. A non-zero value here makes
    // app launch block for up to that many ms while we wait for the update
    // check — terrible UX for a wallet on bad networks. The trade-off is that
    // an OTA published right now reaches users on the launch *after* this one,
    // not this one.
    fallbackToCacheTimeout: 0,
    // EAS Update code signing is disabled: it requires the EAS Enterprise
    // plan (nuri-com is on Starter). If reintroduced, the private key must
    // stay in CI/release-only secrets and never reach developer machines.
  },
  runtimeVersion: {
    policy: "fingerprint",
  },
  extra: {
    eas: { projectId: "094b337a-d639-434e-8231-170d02bcb66a" },
    appVariant: variant,
    // Testnet-vs-mainnet switch. Mainnet is the default when unset. `extra` is
    // excluded from the fingerprint via `sourceSkips` ("ExpoConfigExtraSection")
    // in fingerprint.config.js, so this build-time key no longer mints a new
    // runtime version. Read back in config/network.ts. Falls back to the legacy
    // `EXPO_PUBLIC_APP_NETWORK` until the EAS environments migrate to APP_NETWORK
    // — an unmigrated preview env still sets the old key and must not route to
    // mainnet.
    appNetwork:
      String(process.env.APP_NETWORK ?? process.env.EXPO_PUBLIC_APP_NETWORK ?? "").toLowerCase() ===
      "testnet"
        ? "testnet"
        : "mainnet",
  },
};

export default config;
