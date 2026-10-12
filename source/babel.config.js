module.exports = (api) => {
  api.cache(true);
  const lockFontScalingPlugin = require("./config/babel/lockFontScaling");

  return {
    presets: [
      [
        "babel-preset-expo",
        {
          // The wallet pickers (RainbowKit on web, Reown AppKit on native) pull
          // in zustand/valtio ESM builds that read `import.meta.env`, which
          // neither a classic web script nor Hermes can parse.
          unstable_transformImportMeta: true,
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
