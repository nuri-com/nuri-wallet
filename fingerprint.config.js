/** @type {import('@expo/fingerprint').Config} */
const config = {
  // EAS auto-increments versionCode (Android) and buildNumber (iOS) at
  // build time via `appVersionSource: "remote"` + `autoIncrement: true` in
  // eas.json. Without skipping these from the fingerprint, the local
  // ExpoConfig (with placeholder values) and the EAS-substituted ExpoConfig
  // produce different fingerprints — causing a "Runtime version calculated
  // on local machine not equal to runtime version calculated during build"
  // failure on every cloud build.
  //
  // `packageJson:scripts` hashes the whole scripts object as one blob, so
  // editing any of the ~22 dev-only scripts (lint/format/test/wf/mailer:*/
  // mercuryo:*/...) burns a runtime version and blocks OTA, even though none
  // of them can reach the native binary. EAS does not run the `ios`/`android`
  // scripts on a cloud build, and `config-plugins:build` is covered anyway via
  // its compiled outputs under config-plugins/build/, which are fingerprinted
  // as their own sources.
  //
  // `ExpoConfigExtraSection` does the same for `extra`, which is read from JS
  // at runtime and ships fine over OTA.
  //
  // A skip changes the fingerprint itself, so these two ride the next native
  // binary — the API-36 release (#935). That release is cut as an RC from dev
  // like every release, so merging here to dev is the normal path; the changed
  // hash reaches users through that RC's new build, not over OTA to the old
  // runtime. Only add further skips together with a binary-cutting release.
  sourceSkips: ["ExpoConfigVersions", "PackageJsonScriptsAll", "ExpoConfigExtraSection"],
};

module.exports = config;
