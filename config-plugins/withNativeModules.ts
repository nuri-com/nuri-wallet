import type { ConfigPlugin } from "@expo/config-plugins";
import {
  IOSConfig,
  withAppBuildGradle,
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
  withStringsXml,
  withXcodeProject,
} from "@expo/config-plugins";
import fs from "node:fs";
import path from "node:path";

const IOS_SOURCE_FILES = ["PasskeyModule.swift", "PasskeyModuleBridge.m"];

const IOS_BRIDGING_HEADER = "Nuricom-Bridging-Header.h";
const ANDROID_PASSKEY_IMPORT = "import com.nuri.mobileios.passkey.PasskeyPackage";
const ANDROID_PASSKEY_REGISTRATION = "packages.add(PasskeyPackage())";
const ANDROID_ASSET_STATEMENTS_NAME = "asset_statements";
const ANDROID_ASSET_STATEMENTS_JSON = JSON.stringify([
  {
    relation: [
      "delegate_permission/common.get_login_creds",
      "delegate_permission/common.use_as_origin",
    ],
    target: {
      namespace: "web",
      site: "https://nuri.com",
    },
  },
]);
const ANDROID_ASSET_STATEMENTS_VALUE = ANDROID_ASSET_STATEMENTS_JSON.replace(/"/g, '\\"');
const ANDROID_PASSKEY_DEPENDENCIES = [
  'implementation("androidx.credentials:credentials:1.6.0")',
  'implementation("androidx.credentials:credentials-play-services-auth:1.6.0")',
  'implementation("com.upokecenter:cbor:4.5.1")',
];

type XcodeBuildConfiguration = {
  buildSettings?: Record<string, string>;
};

function copyFile(sourcePath: string, destinationPath: string) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyDirectory(sourceDir: string, destinationDir: string) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Native module source directory does not exist: ${sourceDir}`);
  }

  fs.mkdirSync(destinationDir, { recursive: true });
  fs.cpSync(sourceDir, destinationDir, { recursive: true });
}

function addPasskeyPackageToMainApplication(contents: string): string {
  let next = contents;

  if (!next.includes(ANDROID_PASSKEY_IMPORT)) {
    next = next.replace(
      /import com\.facebook\.react\.PackageList\n/,
      `import com.facebook.react.PackageList\n${ANDROID_PASSKEY_IMPORT}\n`,
    );
  }

  if (!next.includes(ANDROID_PASSKEY_REGISTRATION)) {
    next = next.replace(
      /(val packages = PackageList\(this\)\.packages\n)/,
      `$1            ${ANDROID_PASSKEY_REGISTRATION}\n`,
    );
  }

  return next;
}

function addAndroidPasskeyDependencies(contents: string): string {
  const missingDependencies = ANDROID_PASSKEY_DEPENDENCIES.filter(
    (dependency) => !contents.includes(dependency),
  );

  if (missingDependencies.length === 0) return contents;

  const dependencyBlock = missingDependencies.map((dependency) => `    ${dependency}`).join("\n");
  if (contents.includes('implementation("com.facebook.react:react-android")')) {
    return contents.replace(
      'implementation("com.facebook.react:react-android")',
      `implementation("com.facebook.react:react-android")\n${dependencyBlock}`,
    );
  }

  return contents.replace(/dependencies\s*\{\s*/, (match) => `${match}${dependencyBlock}\n`);
}

function setAndroidStringResource(
  strings: { resources?: { string?: Array<{ _: string; $: Record<string, string> }> } },
  name: string,
  value: string,
) {
  strings.resources = strings.resources ?? {};
  strings.resources.string = strings.resources.string ?? [];

  const existing = strings.resources.string.find((item) => item.$?.name === name);
  if (existing) {
    existing._ = value;
    existing.$.translatable = "false";
    return;
  }

  strings.resources.string.push({
    _: value,
    $: { name, translatable: "false" },
  });
}

function setAndroidApplicationMetadata(
  application: { "meta-data"?: Array<{ $: Record<string, string> }> },
  name: string,
  attributes: Record<string, string>,
) {
  application["meta-data"] = application["meta-data"] ?? [];
  const existing = application["meta-data"].find((item) => item.$?.["android:name"] === name);

  if (existing) {
    existing.$ = attributes;
  } else {
    application["meta-data"].push({ $: attributes });
  }
}

const withNativeModules: ConfigPlugin = (config) => {
  let nextConfig = withDangerousMod(config, [
    "ios",
    async (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      const projectName = modConfig.modRequest.projectName;
      const sourceRoot = path.join(projectRoot, "native-modules", "ios");
      const iosProjectRoot = path.join(projectRoot, "ios", projectName);

      for (const fileName of IOS_SOURCE_FILES) {
        copyFile(path.join(sourceRoot, fileName), path.join(iosProjectRoot, fileName));
      }
      copyFile(
        path.join(sourceRoot, IOS_BRIDGING_HEADER),
        path.join(iosProjectRoot, `${projectName}-Bridging-Header.h`),
      );

      return modConfig;
    },
  ]);

  nextConfig = withXcodeProject(nextConfig, (modConfig) => {
    const project = modConfig.modResults;
    const projectName = modConfig.modRequest.projectName;
    const targetUuid = IOSConfig.XcodeUtils.getApplicationNativeTarget({
      project,
      projectName,
    }).uuid;

    for (const fileName of IOS_SOURCE_FILES) {
      const filePath = path.join(projectName, fileName);
      if (!project.hasFile(filePath)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: filePath,
          groupName: projectName,
          project,
          targetUuid,
        });
      }
    }

    const buildConfigurations = project.pbxXCBuildConfigurationSection() as Record<
      string,
      XcodeBuildConfiguration | string
    >;
    for (const configuration of Object.values(buildConfigurations)) {
      if (typeof configuration === "string" || !configuration.buildSettings) continue;
      configuration.buildSettings.SWIFT_OBJC_BRIDGING_HEADER = `${projectName}/${projectName}-Bridging-Header.h`;
      configuration.buildSettings.SWIFT_VERSION = "5.0";
    }

    return modConfig;
  });

  nextConfig = withDangerousMod(nextConfig, [
    "android",
    async (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      copyDirectory(
        path.join(projectRoot, "native-modules", "android"),
        path.join(projectRoot, "android", "app", "src", "main", "java"),
      );
      return modConfig;
    },
  ]);

  nextConfig = withMainApplication(nextConfig, (modConfig) => {
    modConfig.modResults.contents = addPasskeyPackageToMainApplication(
      modConfig.modResults.contents,
    );
    return modConfig;
  });

  nextConfig = withAppBuildGradle(nextConfig, (modConfig) => {
    modConfig.modResults.contents = addAndroidPasskeyDependencies(modConfig.modResults.contents);
    return modConfig;
  });

  nextConfig = withStringsXml(nextConfig, (modConfig) => {
    setAndroidStringResource(
      modConfig.modResults,
      ANDROID_ASSET_STATEMENTS_NAME,
      ANDROID_ASSET_STATEMENTS_VALUE,
    );
    return modConfig;
  });

  nextConfig = withAndroidManifest(nextConfig, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("Could not find Android application node");
    }

    setAndroidApplicationMetadata(application, "asset_statements", {
      "android:name": "asset_statements",
      "android:resource": "@string/asset_statements",
    });
    return modConfig;
  });

  return nextConfig;
};

export default withNativeModules;
