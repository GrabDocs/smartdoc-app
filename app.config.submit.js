// Minimal config for EAS submit only. No plugins = no plugin resolution.
// Used when swapping app.config.js during submit to avoid "Failed to resolve
// plugin for module expo-dev-client" (EAS submit does not need plugins).
//
// IMPORTANT: This file must be standalone. When the workflow copies it over
// app.config.js, require("./app.config.js") would be circular and break the
// config (no projectId → "EAS project not configured" prompt in CI).
const versions = require("./app.versions.json");

module.exports = {
  expo: {
    name: "GrabDocs",
    slug: "grabdocs",
    version: versions.version,
    scheme: "grabdocs",
    plugins: [],
    ios: {
      bundleIdentifier: "com.grabdocs.mobile",
      buildNumber: versions.ios?.buildNumber ?? "1",
    },
    android: {
      package: "com.grabdocs.mobile",
      versionCode: versions.android?.versionCode ?? 1,
    },
    extra: {
      eas: {
        projectId: "341d1cdf-5759-41ef-8ae3-36e4cf7fab00",
      },
    },
  },
};
