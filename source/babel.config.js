module.exports = (api) => {
  api.cache(true);
  const lockFontScalingPlugin = require("./config/babel/lockFontScaling");

  return {
    presets: [
      [
        "babel-preset-expo",
        {
          // The pay page's wallet picker (RainbowKit/WalletConnect) pulls in
          // zustand/valtio ESM builds that read `import.meta.env`, which a
          // classic web script cannot parse. Web only: native bundles never
          // include these packages and stay byte-identical.
          web: { unstable_transformImportMeta: true },
        },
      ],
    ],
    plugins: [
      "@babel/plugin-transform-class-static-block",
      lockFontScalingPlugin,
      // MUST be last — Reanimated's worklet transform has to run after everything else.
      "react-native-reanimated/plugin",
    ],
  };
};
