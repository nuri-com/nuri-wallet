"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_plugins_1 = require("@expo/config-plugins");
const MLKIT_DEPENDENCIES_NAME = "com.google.mlkit.vision.DEPENDENCIES";
const withMlKitDependencies = (config) => (0, config_plugins_1.withAndroidManifest)(config, (nextConfig) => {
    const androidManifest = nextConfig.modResults;
    const mainApplication = androidManifest.manifest.application?.[0];
    if (!mainApplication) {
        throw new Error("Could not find Android application node");
    }
    androidManifest.manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    mainApplication["meta-data"] = mainApplication["meta-data"] ?? [];
    const mlKitMetaData = {
        $: {
            "android:name": MLKIT_DEPENDENCIES_NAME,
            "android:value": "face,barcode_ui",
            "tools:replace": "android:value",
        },
    };
    const existingIndex = mainApplication["meta-data"].findIndex((item) => item.$?.["android:name"] === MLKIT_DEPENDENCIES_NAME);
    if (existingIndex >= 0) {
        mainApplication["meta-data"][existingIndex] = mlKitMetaData;
    }
    else {
        mainApplication["meta-data"].push(mlKitMetaData);
    }
    return nextConfig;
});
exports.default = withMlKitDependencies;
