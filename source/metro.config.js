const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
const punycodePath = require.resolve("punycode/punycode.js");
// react-native-webview ships only a "not supported" stub for web; on web,
// resolve it to our iframe-backed implementation instead.
const webViewWebShim = path.resolve(__dirname, "lib/web/WebViewWeb.tsx");
// react-native-keychain has no web build; direct callers would hit undefined
// methods. Alias to a localStorage-backed shim on web.
const keychainWebShim = path.resolve(__dirname, "lib/web/ReactNativeKeychainWeb.ts");

// Enable package exports so Metro can resolve @bufbuild/protobuf/wire.
config.resolver.unstable_enablePackageExports = true;

// Add .mjs and .cjs support for Noble modules
config.resolver.sourceExts = [...config.resolver.sourceExts, "mjs", "cjs"];

// Ensure proper module resolution
config.resolver.resolverMainFields = ["react-native", "browser", "module", "main"];

// Polyfill Node core module imports used by SDK dependencies.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  events: require.resolve("events/"),
  punycode: punycodePath,
};

// viem's `chains` barrel pulls in the Tempo chain definitions, which reach
// `ox/tempo`'s salt miner. Its Node branch imports `node:worker_threads` behind
// a variable specifier — Metro resolves that anyway and fails the whole export,
// even though the branch is unreachable off Node (`isNode` is false in the app,
// and nothing here talks to Tempo). Resolving it to nothing keeps the module
// graph buildable; the only code that would notice is the code we never run.
const NODE_ONLY_STUBS = new Set(["node:worker_threads"]);

// wagmi's connector barrel re-exports the Porto connector, which imports
// `porto` at module scope. Porto's `ox` copy ships TypeScript sources Metro
// resolves instead of its build and cannot bundle. The pay page never offers
// Porto (lib/pay/payWallet.web.tsx lists its wallets explicitly), so the
// connector is never constructed and nothing reads these modules at runtime.
const WEB_UNUSED_STUBS = new Set(["porto", "porto/internal"]);

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (NODE_ONLY_STUBS.has(moduleName)) {
    return { type: "empty" };
  }

  if (platform === "web" && WEB_UNUSED_STUBS.has(moduleName)) {
    return { type: "empty" };
  }

  if (platform === "web" && moduleName === "react-native-webview") {
    return {
      type: "sourceFile",
      filePath: webViewWebShim,
    };
  }

  if (platform === "web" && moduleName === "react-native-keychain") {
    return {
      type: "sourceFile",
      filePath: keychainWebShim,
    };
  }

  if (moduleName === "punycode") {
    return {
      type: "sourceFile",
      filePath: punycodePath,
    };
  }

  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

// SVG transformer: treat .svg files as React components via react-native-svg-transformer.
config.resolver.assetExts = config.resolver.assetExts.filter((ext) => ext !== "svg");
config.resolver.sourceExts = [...config.resolver.sourceExts, "svg"];
config.transformer = {
  ...config.transformer,
  babelTransformerPath: require.resolve("react-native-svg-transformer/expo"),
};

module.exports = config;
