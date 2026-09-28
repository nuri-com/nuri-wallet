// Must be the very first import (react-native-gesture-handler requirement).
import "react-native-gesture-handler";
// Web only (no-op on native): install Metro's async-bundle loader before the
// rest of the graph evaluates, so a dependency's dynamic import() can fetch its
// chunk instead of failing with "Requiring unknown module".
import "./lib/web/installMetroAsyncRequire";
import { registerRootComponent } from "expo";
import { getRandomBytes } from "expo-crypto";
import "react-native-get-random-values";
import "@azure/core-asynciterator-polyfill";
import { Buffer } from "buffer";
import "text-encoding";

import { installDebugLogBuffer } from "./services/logging/DebugLogBuffer";
import { setLogLevel } from "./lib/log";
import { installApiProxy } from "./lib/web/apiProxy";

// Install early so we can ship a useful journey log via support dumps.
installDebugLogBuffer({ maxEntries: 800, maxEntryChars: 720 });

// Log verbosity. Default "event": user actions + errors + one-line summaries;
// background/system machinery is muted. To see everything, set
// EXPO_PUBLIC_LOG_LEVEL=trace in .env (restart), or flip live in the debugger
// console: logLevel("trace" | "event" | "warn").
const initialLogLevel = process.env.EXPO_PUBLIC_LOG_LEVEL;
if (initialLogLevel === "trace" || initialLogLevel === "event" || initialLogLevel === "warn") {
  setLogLevel(initialLogLevel);
}
globalThis.logLevel = setLogLevel;

// Web (PWA) only: route backend calls through same-origin /api/* (no CORS).
// No-op on native. Must run before any service can fire a request.
installApiProxy();

// Use require to ensure our log buffer is installed before App executes.
const App = require("./App").default;

// Polyfill crypto.getRandomValues for Noble libraries in React Native
if (!globalThis.crypto) {
  globalThis.crypto = {};
}

if (!globalThis.crypto.getRandomValues) {
  globalThis.crypto.getRandomValues = (arr) => {
    const bytes = getRandomBytes(arr.byteLength);
    arr.set(bytes);
    return arr;
  };
}

// Also set globals for compatibility (RN + web)
if (typeof global !== "undefined") {
  if (!global.crypto) {
    global.crypto = globalThis.crypto;
  }
  if (!global.Buffer) {
    global.Buffer = Buffer;
  }
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
