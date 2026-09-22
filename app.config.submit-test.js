// Test/submit config — keep in sync by reading from app.versions.json (same as app.config.js).
const versions = require("./app.versions.json");

module.exports = { expo: {
  "name": "GrabDocs",
  "slug": "grabdocs",
  "version": versions.version,
  "orientation": "portrait",
  "icon": "./assets/images/grabdocs-brand-app-images/png/icon-1024-light.png",
  "userInterfaceStyle": "automatic",
  "scheme": "grabdocs",
  "splash": {
    "image": "./assets/images/grabdocs-brand-app-images/png/logo-600x200.png",
    "resizeMode": "contain",
    "backgroundColor": "#ffffff"
  },
  "assetBundlePatterns": [
    "**/*"
  ],
  "ios": {
    "supportsTablet": true,
    "bundleIdentifier": "com.grabdocs.mobile",
    "buildNumber": String(versions.ios?.buildNumber ?? "1"),
    "usesAppleSignIn": true,
    "associatedDomains": [
      "applinks:api.grabdocs.com",
      "applinks:app.grabdocs.com",
      "applinks:grabdocs.com",
      "applinks:www.grabdocs.com"
    ],
    "splash": {
      "image": "./assets/images/grabdocs-brand-app-images/png/logo-600x200.png",
      "resizeMode": "contain",
      "backgroundColor": "#ffffff"
    },
    "infoPlist": {
      "NSCameraUsageDescription": "GrabDocs needs access to your camera to scan documents, take photos, and enable video conferencing.",
      "NSPhotoLibraryUsageDescription": "GrabDocs needs access to your photo library to upload existing documents and photos.",
      "NSPhotoLibraryAddUsageDescription": "GrabDocs needs access to save scanned documents to your photo library.",
      "NSMicrophoneUsageDescription": "GrabDocs needs access to your microphone for voice notes, audio features, and video conferencing.",
      "NSLocalNetworkUsageDescription": "GrabDocs needs access to your local network to enable video conferencing and real-time communication.",
      "NSFaceIDUsageDescription": "GrabDocs uses Face ID for secure and convenient authentication to access your account and documents.",
      "NSBiometricUsageDescription": "GrabDocs uses biometric authentication (Face ID or Touch ID) for secure and convenient access to your account and documents.",
      "ITSAppUsesNonExemptEncryption": false,
      "NSAppTransportSecurity": {
        "NSAllowsArbitraryLoads": true,
        "NSExceptionDomains": {
          "api.grabdocs.com": {
            "NSExceptionAllowsInsecureHTTPLoads": false,
            "NSIncludesSubdomains": true,
            "NSExceptionRequiresForwardSecrecy": true,
            "NSExceptionMinimumTLSVersion": "TLSv1.2",
            "NSThirdPartyExceptionRequiresForwardSecrecy": false
          }
        }
      }
    }
  },
  "android": {
    "package": "com.grabdocs.mobile",
    "versionCode": versions.android?.versionCode ?? 31,
    "adaptiveIcon": {
      "foregroundImage": "./assets/images/grabdocs-brand-app-images/png/icon-1024-light-android.png",
      "backgroundColor": "#ffffff",
      "monochromeImage": "./assets/images/grabdocs-brand-app-images/png/icon-1024-light-android.png"
    },
    "permissions": [
      "android.permission.CAMERA",
      "android.permission.INTERNET",
      "android.permission.CHANGE_NETWORK_STATE",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.RECORD_AUDIO",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.USE_BIOMETRIC",
      "android.permission.USE_FINGERPRINT"
    ],
    "intentFilters": [
      {
        "action": "VIEW",
        "autoVerify": true,
        "data": [
          {
            "scheme": "https",
            "host": "api.grabdocs.com",
            "pathPrefix": "/auth"
          }
        ],
        "category": [
          "BROWSABLE",
          "DEFAULT"
        ]
      },
      {
        "action": "VIEW",
        "autoVerify": true,
        "data": [
          {
            "scheme": "https",
            "host": "api.grabdocs.com",
            "pathPrefix": "/join-meeting"
          },
          {
            "scheme": "https",
            "host": "api.grabdocs.com",
            "pathPrefix": "/meeting"
          }
        ],
        "category": [
          "BROWSABLE",
          "DEFAULT"
        ]
      }
    ]
  },
  "web": {
    "bundler": "metro",
    "output": "static",
    "favicon": "./assets/images/grabdocs-brand-app-images/favicon/favicon-48x48.png"
  },
  "experiments": {
    "typedRoutes": true
  },
  "extra": {
    "router": {},
    "eas": {
      "projectId": "341d1cdf-5759-41ef-8ae3-36e4cf7fab00"
    }
  }
} };