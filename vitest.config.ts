import { configDefaults, defineConfig } from "vitest/config";

const isLiveTestRun = process.env.VITEST_LIVE === "1";

export default defineConfig({
  test: {
    include: [isLiveTestRun ? "**/*.live.test.ts" : "**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      ...(isLiveTestRun ? [] : ["**/*.live.test.ts"]),
    ],
    environment: "node",
    server: {
      deps: {
        // @arkade-os/swap ships modern ESM vitest must transform, not require from node_modules.
        inline: [/@arkade-os/],
      },
    },
    globals: true,
    testTimeout: isLiveTestRun ? 120_000 : undefined,
    hookTimeout: isLiveTestRun ? 120_000 : undefined,
    fileParallelism: !isLiveTestRun,
    maxConcurrency: isLiveTestRun ? 1 : undefined,
    passWithNoTests: isLiveTestRun,
    sequence: {
      concurrent: isLiveTestRun ? false : undefined,
    },
  },
  resolve: {
    alias: {
      // Stub out React Native and Expo modules that don't exist in Node
      "react-native": "./__mocks__/react-native.ts",
      "expo-clipboard": "./__mocks__/expo-stub.ts",
      "expo-localization": "./__mocks__/expo-localization.ts",
      "expo-secure-store": "./__mocks__/expo-stub.ts",
      "expo-sqlite": "./__mocks__/expo-sqlite.ts",
      "expo-local-authentication": "./__mocks__/expo-stub.ts",
      "@sumsub/react-native-mobilesdk-module": "./__mocks__/expo-stub.ts",
    },
  },
});
