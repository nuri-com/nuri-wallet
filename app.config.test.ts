import { describe, expect, it } from "vitest";

import config from "./app.config";

type BuildPropertiesPlugin = [
  "expo-build-properties",
  {
    android?: {
      compileSdkVersion?: number;
      minSdkVersion?: number;
      targetSdkVersion?: number;
    };
  },
];

function resolveBuildPropertiesAndroidConfig() {
  const plugin = config.plugins?.find(
    (entry) => Array.isArray(entry) && entry[0] === "expo-build-properties",
  );

  if (!plugin) {
    throw new Error("expo-build-properties plugin not found in app config");
  }

  const [, options] = plugin as BuildPropertiesPlugin;

  return options.android;
}

describe("app.config Android SDK versions", () => {
  it("pins compile and target SDK 36 while preserving min SDK 30", () => {
    expect(resolveBuildPropertiesAndroidConfig()).toEqual(
      expect.objectContaining({
        compileSdkVersion: 36,
        minSdkVersion: 30,
        targetSdkVersion: 36,
      }),
    );
  });
});
