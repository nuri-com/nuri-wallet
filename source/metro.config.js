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
// resolves instead of its build and cannot bundle. Neither wallet picker offers
// Porto (lib/pay/payWallet.web.tsx lists its wallets explicitly; native uses
// AppKit's own connector), so it is never constructed and nothing reads these
// modules at runtime, on any platform.
const UNUSED_STUBS = new Set(["porto", "porto/internal"]);

// Reown AppKit's React Native packages each install their own valtio 2 copy
// (the web AppKit inside wagmi's WalletConnect connector needs valtio 1 at the
// top). A proxy made by one copy is "not a proxy" to the other, so AppKit dies
// at createAppKit ("Please use proxy object"). Every valtio import from those
// packages resolves through appkit-core's copy, so they share one.
const APPKIT_RN = /[\\/]node_modules[\\/]@reown[\\/]appkit-[a-z-]*react-native[\\/]/;
const APPKIT_VALTIO_ORIGIN = path.join(
  __dirname,
  "node_modules/@reown/appkit-core-react-native/package.json",
);

// These packages' `exports` and `browser` maps send Metro to a subpath they
// do not export, so every start warned and fell back to the file anyway.
// Resolving them by file directly is that same fallback, without the noise.
const FILE_RESOLVED = /^(@noble\/hashes|multiformats|uint8arrays)(\/|$)/;

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (FILE_RESOLVED.test(moduleName)) {
    return context.resolveRequest(
      { ...context, unstable_enablePackageExports: false },
      moduleName,
      platform,
    );
  }

  if (
    (moduleName === "valtio" || moduleName.startsWith("valtio/")) &&
    APPKIT_RN.test(context.originModulePath)
  ) {
    return context.resolveRequest(
      { ...context, originModulePath: APPKIT_VALTIO_ORIGIN },
      moduleName,
      platform,
    );
  }

  if (NODE_ONLY_STUBS.has(moduleName)) {
    return { type: "empty" };
  }

  if (UNUSED_STUBS.has(moduleName)) {
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
