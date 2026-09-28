module.exports = (api) => {
  api.cache(true);
  const lockFontScalingPlugin = require("./config/babel/lockFontScaling");

  return {
    presets: ["babel-preset-expo"],
    plugins: [
      "@babel/plugin-transform-class-static-block",
      lockFontScalingPlugin,
      // MUST be last — Reanimated's worklet transform has to run after everything else.
      "react-native-reanimated/plugin",
    ],
  };
};
