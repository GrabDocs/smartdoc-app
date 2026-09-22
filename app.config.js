// Single source of config (no app.json) so Expo doctor passes and EAS uses one config.
// Version/build from app.versions.json (updated by scripts/deploy.ps1).
const isCI = !!process.env.CI;
const isDevProfile = process.env.EAS_BUILD_PROFILE === "development";

const versions = require("./app.versions.json");

// Reversed iOS OAuth client ID for @react-native-google-signin's config plugin.
// Derived from the iOS client ID env var; falls back to a placeholder so prebuild never fails.
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS || "";
const googleIosUrlScheme = googleIosClientId
  ? `com.googleusercontent.apps.${googleIosClientId.replace(/\.apps\.googleusercontent\.com$/, "")}`
  : "com.googleusercontent.apps.placeholder";

const baseExpo = {
  name: "GrabDocs",
  slug: "grabdocs",
  version: versions.version,
  // Allow rotation for large screens (foldables, tablets); Android 16 ignores portrait lock on large devices
  orientation: "default",
  icon: "./assets/images/grabdocs-brand-app-images/png/icon-1024-light.png",
  userInterfaceStyle: "automatic",
  scheme: "grabdocs",
  splash: {
    image: "./assets/images/grabdocs-brand-app-images/png/logo-600x200.png",
    resizeMode: "contain",
    backgroundColor: "#ffffff",
  },
  assetBundlePatterns: ["**/*"],
  ios: {
    newArchEnabled: true,
    jsEngine: "hermes",
    supportsTablet: true,
    bundleIdentifier: "com.grabdocs.mobile",
    buildNumber: String(versions.ios?.buildNumber ?? "1"),
    usesAppleSignIn: true,
    associatedDomains: [
      "applinks:api.grabdocs.com",
      "applinks:app.grabdocs.com",
      "applinks:grabdocs.com",
      "applinks:www.grabdocs.com",
    ],
    splash: {
      image: "./assets/images/grabdocs-brand-app-images/png/logo-600x200.png",
      resizeMode: "contain",
      backgroundColor: "#ffffff",
    },
    infoPlist: {
      NSCameraUsageDescription:
        "GrabDocs needs access to your camera to scan documents, take photos, and enable video conferencing.",
      NSPhotoLibraryUsageDescription:
        "GrabDocs needs access to your photo library to upload existing documents and photos.",
      NSPhotoLibraryAddUsageDescription:
        "GrabDocs needs access to save scanned documents to your photo library.",
      NSMicrophoneUsageDescription:
        "GrabDocs needs access to your microphone for voice notes, audio features, and video conferencing.",
      NSLocalNetworkUsageDescription:
        "GrabDocs needs access to your local network to enable video conferencing and real-time communication.",
      NSFaceIDUsageDescription:
        "GrabDocs uses Face ID for secure and convenient authentication to access your account and documents.",
      NSBiometricUsageDescription:
        "GrabDocs uses biometric authentication (Face ID or Touch ID) for secure and convenient access to your account and documents.",
      ITSAppUsesNonExemptEncryption: false,
      // Allow canOpenURL / preferred open for calendar Join → native meeting apps
      LSApplicationQueriesSchemes: [
        "zoommtg",
        "zoomus",
        "msteams",
        "googlemeet",
        "comgooglemeet",
        "wbx",
        "comgooglemaps",
        "maps",
      ],
      UIBackgroundModes: ["voip", "audio"],
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
        NSExceptionDomains: {
          "api.grabdocs.com": {
            NSExceptionAllowsInsecureHTTPLoads: false,
            NSIncludesSubdomains: true,
            NSExceptionRequiresForwardSecrecy: true,
            NSExceptionMinimumTLSVersion: "TLSv1.2",
            NSThirdPartyExceptionRequiresForwardSecrecy: false,
          },
        },
      },
    },
  },
  android: {
    package: "com.grabdocs.mobile",
    versionCode: versions.android?.versionCode ?? 55,
    softwareKeyboardLayoutMode: "resize",
    edgeToEdgeEnabled: true,
    adaptiveIcon: {
      foregroundImage:
        "./assets/images/grabdocs-brand-app-images/png/icon-1024-light-android.png",
      backgroundColor: "#ffffff",
      monochromeImage:
        "./assets/images/grabdocs-brand-app-images/png/icon-1024-light-android.png",
    },
    permissions: [
      "android.permission.CAMERA",
      "android.permission.INTERNET",
      "android.permission.CHANGE_NETWORK_STATE",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.RECORD_AUDIO",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.USE_BIOMETRIC",
      "android.permission.USE_FINGERPRINT",
      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
    ],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          { scheme: "https", host: "api.grabdocs.com", pathPrefix: "/auth" },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          { scheme: "https", host: "api.grabdocs.com", pathPrefix: "/meeting" },
          { scheme: "https", host: "app.grabdocs.com", pathPrefix: "/meeting" },
          { scheme: "https", host: "app.grabdocs.com", pathPrefix: "/join-meeting" },
          { scheme: "https", host: "grabdocs.com", pathPrefix: "/join-meeting" },
          { scheme: "https", host: "grabdocs.com", pathPrefix: "/meeting" },
          { scheme: "https", host: "www.grabdocs.com", pathPrefix: "/join-meeting" },
          { scheme: "https", host: "www.grabdocs.com", pathPrefix: "/meeting" },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          { scheme: "https", host: "app.grabdocs.com", pathPrefix: "/secure-message-invite" },
          { scheme: "https", host: "app.grabdocs.com", pathPrefix: "/workspace-invite" },
          { scheme: "https", host: "app.grabdocs.com", pathPrefix: "/verify-email-change" },
          { scheme: "https", host: "grabdocs.com", pathPrefix: "/secure-message-invite" },
          { scheme: "https", host: "grabdocs.com", pathPrefix: "/workspace-invite" },
          { scheme: "https", host: "grabdocs.com", pathPrefix: "/verify-email-change" },
          { scheme: "https", host: "www.grabdocs.com", pathPrefix: "/secure-message-invite" },
          { scheme: "https", host: "www.grabdocs.com", pathPrefix: "/workspace-invite" },
          { scheme: "https", host: "www.grabdocs.com", pathPrefix: "/verify-email-change" },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: {
    bundler: "metro",
    output: "static",
    favicon:
      "./assets/images/grabdocs-brand-app-images/favicon/favicon-48x48.png",
  },
  plugins: [
    "./plugins/android-pip",
    "./plugins/android-hms-screenshare",
    "./plugins/android-large-screen",
    "./plugins/android-disable-release-lint",
    "./plugins/android-autofill-highlight",
    "./plugins/ios-pip",
    "expo-dev-client",
    "expo-font",
    "expo-router",
    "expo-web-browser",
    [
      "@react-native-google-signin/google-signin",
      { iosUrlScheme: googleIosUrlScheme },
    ],
    [
      "expo-build-properties",
      {
        ios: {
          deploymentTarget: "16.0",
          // Google Sign-In pulls AppCheckCore (Swift), which needs modular headers
          // on these ObjC pods when linking as static libraries.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
        android: {
          minSdkVersion: 24,
          compileSdkVersion: 36,
          targetSdkVersion: 36,
        },
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission:
          "GrabDocs needs access to your photos to let you share them with your workspaces.",
        cameraPermission:
          "GrabDocs needs access to your camera to let you take photos of documents.",
      },
    ],
    ["expo-document-picker", { iCloudContainerEnvironment: "Production" }],
    [
      "expo-local-authentication",
      {
        faceIDPermission:
          "GrabDocs uses Face ID for secure and convenient authentication to access your account and documents.",
      },
    ],
    "expo-apple-authentication",
    [
      "expo-media-library",
      {
        photosPermission:
          "GrabDocs needs access to your photos, videos, and audio files to let you upload documents and media.",
        savePhotosPermission:
          "GrabDocs needs access to save scanned documents to your photo library.",
        isAccessMediaLocationEnabled: false,
      },
    ],
    "expo-secure-store",
    // Must be last: injects Broadcast Extension block into Podfile (nested in main target) via config plugin only.
    [
      "./plugins/ios-hms-screenshare",
      {
        appGroup: "group.com.grabdocs.mobile",
        extensionName: "GrabDocsBroadcastUpload",
      },
    ],
  ],
  experiments: { typedRoutes: true, newArchEnabled: true },
  extra: {
    router: {},
    eas: {
      projectId: "341d1cdf-5759-41ef-8ae3-36e4cf7fab00",
      build: {
        experimental: {
          ios: {
            appExtensions: [
              {
                targetName: "GrabDocsBroadcastUpload",
                bundleIdentifier: "com.grabdocs.mobile.GrabDocsBroadcastUpload",
                entitlements: {
                  "com.apple.security.application-groups": ["group.com.grabdocs.mobile"],
                },
              },
            ],
          },
        },
      },
    },
  },
};

const basePlugins = baseExpo.plugins || [];
const plugins =
  isCI || isDevProfile
    ? basePlugins.filter((p) => {
        const name = Array.isArray(p) ? p[0] : p;
        return name !== "expo-dev-client";
      })
    : basePlugins;

const config = {
  expo: {
    ...baseExpo,
    plugins,
    // Fixed runtimeVersion (NOT tied to app version) so OTA (eas update) reaches every build that
    // shares this string, across app versions. Fingerprint policy is not used here because this is
    // a bare/prebuilt project built locally, where local vs EAS fingerprints diverge and break builds.
    // IMPORTANT: bump this string ONLY when you change the native layer (new native deps, SDK
    // upgrades, permissions, plugins) and ship a new binary, so JS updates never land on an
    // incompatible binary.
    runtimeVersion: "1.0.0",
    updates: {
      url: "https://u.expo.dev/341d1cdf-5759-41ef-8ae3-36e4cf7fab00",
    },
  },
};

module.exports = config;
