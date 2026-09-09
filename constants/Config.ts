import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Local Development Configuration - Single source of truth for local backend IP
// ⚠️ CHANGE THIS IP ADDRESS TO UPDATE ALL LOCAL DEVELOPMENT URLs
// This affects: API backend URL, Expo dev server URL, and all local development endpoints
export const LOCAL_DEV_IP = '192.168.1.8';
export const LOCAL_DEV_PORT = 5000;
export const EXPO_DEV_PORT = 8081; // Metro bundler default port
export const LOCAL_DEV_URL = `http://${LOCAL_DEV_IP}:${LOCAL_DEV_PORT}`;

// API Configuration - Auto-detect based on environment
const PRODUCTION_API_URL = 'https://api.grabdocs.com';

export const API_BASE_URL = (() => {
  const appOwnership = Constants.appOwnership;
  // Expo Go signed-in: 'expo'. Expo Go opened from QR without Expo login: 'guest' — still must use dev LAN URL.
  // Only installed binaries use 'standalone' (treat as production unless EXPO_PUBLIC_* overrides elsewhere).
  const runsInExpoGo = appOwnership === 'expo' || appOwnership === 'guest';
  const isStandalone = !runsInExpoGo;

  // For standalone apps (dev builds, production builds, EAS updates): ALWAYS use production.
  // EAS Update can accidentally bake in local .env (e.g. EXPO_PUBLIC_API_URL=http://192.168.x.x)
  // when run locally. Ignore env for standalone to avoid "app not connecting" after updates.
  if (isStandalone) {
    return PRODUCTION_API_URL;
  }

  // 1. For Expo Go only: check explicit environment variable
  const raw = process.env.EXPO_PUBLIC_API_URL;
  const envApiUrl = typeof raw === 'string' ? raw.trim() : '';
  if (envApiUrl !== '') {
    const isLocalUrl =
      envApiUrl.includes('192.168.') ||
      envApiUrl.includes('10.') ||
      envApiUrl.includes('localhost') ||
      envApiUrl.includes('127.0.0.1');
    // When user explicitly sets a local URL (e.g. http://192.168.1.4:5000), use it so the phone can reach the dev backend
    if (isLocalUrl) {
      return envApiUrl.replace(/\/$/, '');
    }
    let finalUrl = envApiUrl;
    if (finalUrl.includes('api.grabdocs.com') && !finalUrl.startsWith('https://')) {
      finalUrl = finalUrl.replace(/^http:\/\//, 'https://');
    }
    return finalUrl;
  }
  
  // 2. Check if running on web platform
  const isWeb = Platform.OS === 'web';
  
  // For web platform in development, use localhost (requires CORS configuration on backend)
  if (isWeb && __DEV__) {
    return 'http://localhost:5000'; // Local development - backend must allow CORS from http://localhost:8081
  }

  // Expo Go (signed-in or guest): same LAN backend as dev machine (see LOCAL_DEV_IP).
  if (runsInExpoGo) {
    return LOCAL_DEV_URL;
  }

  // 4. For standalone apps (dev builds or production builds), ALWAYS use production
  // This includes:
  // - Dev builds installed on physical devices (appOwnership: 'standalone' or null)
  // - Production builds (appOwnership: 'standalone')
  // - Any app that's not Expo Go
  // IMPORTANT: iOS dev builds installed on physical devices are standalone apps
  // and should ALWAYS use production backend unless explicitly overridden
  // CRITICAL: Always use HTTPS for production - iOS requires it
  return PRODUCTION_API_URL;
})();

export const ENVIRONMENT = process.env.EXPO_PUBLIC_ENVIRONMENT || (__DEV__ ? 'development' : 'production');

// OAuth Configuration - Platform-specific client IDs
// Exported so the native Google Sign-In SDK can use the Web client ID as `webClientId`
// (required to mint an idToken) and the iOS client ID as `iosClientId`.
export const GOOGLE_CLIENT_ID_WEB = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB || '';
export const GOOGLE_CLIENT_ID_ANDROID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID || '';
export const GOOGLE_CLIENT_ID_IOS = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS || '';

// Select the appropriate client ID based on platform and environment.
// EAS Build sets EXPO_OS; fallback to Platform.OS for correctness.
export const GOOGLE_CLIENT_ID = (() => {
  const isAndroid = process.env.EXPO_OS === 'android' || Platform.OS === 'android';
  const isIos = process.env.EXPO_OS === 'ios' || Platform.OS === 'ios';
  // For Expo Go / development, use web client ID
  if (__DEV__) {
    return GOOGLE_CLIENT_ID_WEB;
  }
  if (isAndroid && GOOGLE_CLIENT_ID_ANDROID) return GOOGLE_CLIENT_ID_ANDROID;
  if (isIos && GOOGLE_CLIENT_ID_IOS) return GOOGLE_CLIENT_ID_IOS;
  return GOOGLE_CLIENT_ID_WEB;
})();

// Apple Sign In Configuration
export const APPLE_CLIENT_ID = process.env.EXPO_PUBLIC_APPLE_CLIENT_ID || 'com.grabdocs.mobile.service'; // Service ID for web/Android fallback
export const APPLE_REDIRECT_URI = (() => {
  // Use production redirect URI (matches Apple Developer Console configuration)
  return 'https://api.grabdocs.com/auth/apple/callback';
})();

export const DROPBOX_CLIENT_ID = process.env.EXPO_PUBLIC_DROPBOX_APP_KEY || ''; // Dropbox App Key (same as Client ID)

// Expo Development Server URL - Automatically uses LOCAL_DEV_IP
export const EXPO_DEV_URL = `http://${LOCAL_DEV_IP}:${EXPO_DEV_PORT}`;

// Frontend Web URL - Used for sharing links that should open in browser
export const FRONTEND_URL = (() => {
  // 1. Check explicit environment variable
  if (process.env.EXPO_PUBLIC_FRONTEND_URL) {
    return process.env.EXPO_PUBLIC_FRONTEND_URL;
  }
  
  // 2. Auto-detect based on development mode
  if (__DEV__) {
    return 'http://localhost:3000'; // Local development web frontend
  }
  
  // 3. Production fallback (app subdomain hosts /form/ and web app)
  return 'https://app.grabdocs.com';
})();

// App Configuration
export const APP_NAME = process.env.EXPO_PUBLIC_APP_NAME || 'GrabDocs Mobile';
export const APP_VERSION = process.env.EXPO_PUBLIC_APP_VERSION || '1.0.0';

/** Store URLs for "Update required" deep links. Backend min version is in Render env (MIN_SUPPORTED_APP_VERSION, etc.). */
export const STORE_URLS = {
  ios: 'https://apps.apple.com/app/id6752529430',
  android: 'https://play.google.com/store/apps/details?id=com.grabdocs.mobile',
} as const;

/**
 * 100ms iOS screenshare: required for screen share from iPhone/iPad.
 * The Expo plugin (plugins/ios-hms-screenshare.js) adds the Broadcast Extension automatically.
 * Set in EAS/Env: EXPO_PUBLIC_HMS_IOS_APP_GROUP, EXPO_PUBLIC_HMS_IOS_PREFERRED_EXTENSION
 * (defaults: group.com.grabdocs.mobile, GrabDocsBroadcastUpload).
 * See docs/MOBILE_SCREENSHARE_WHITEBOARD.md.
 */
export const HMS_IOS_SCREENSHARE = (() => {
  const appGroup = process.env.EXPO_PUBLIC_HMS_IOS_APP_GROUP?.trim() || 'group.com.grabdocs.mobile';
  const preferredExtension = process.env.EXPO_PUBLIC_HMS_IOS_PREFERRED_EXTENSION?.trim() || 'GrabDocsBroadcastUpload';
  return { appGroup, preferredExtension };
})();

// API Endpoints
export const API_ENDPOINTS = {
  // Authentication
  LOGIN: '/api/login',
  LOGOUT: '/api/logout',
  SIGNUP: '/api/signup',
  AUTH_CHECK: '/api/auth-check',
  FORGOT_PASSWORD: '/api/forgot-password',
  RESET_PASSWORD: '/api/reset-password',
  
  // User
  USER: '/api/user',
  USER_UPDATE: '/api/user/update',
  USER_THEME: '/api/user/theme',
  
  // Files
  FILES: '/api/files',
  UPLOAD: '/api/upload',
  FILES_BY_ID: (id: number) => `/api/files/${id}`,
  DOWNLOAD_FILE: (id: number) => `/api/files/${id}/download`,
  VIEW_FILE: (id: number) => `/api/files/${id}/view`,
  CATEGORIZE_FILE: (id: number) => `/api/files/${id}/categorize`,
  AUTO_CATEGORIZE: (id: number) => `/api/files/${id}/auto-categorize`,
  BATCH_AUTO_CATEGORIZE: '/api/files/batch-auto-categorize',
  EDIT_FILE: (id: number) => `/api/files/${id}/edit`,
  
  // Chat (AI Assistant)
  SMART_CHAT: '/api/chat/smart',
  SMART_CHAT_STREAM: '/api/chat/smart/stream',
  CHAT_HISTORY: '/api/chat/history',
  CHAT_CONVERSATION: (id: number) => `/api/chat/history/${id}`,
  NEW_CHAT: '/api/chat/new',
  UPDATE_CHAT: (id: number) => `/api/chat/history/${id}`,
  DELETE_CHAT: (id: number) => `/api/chat/history/${id}`,
  
  // User Chat - WEB ENDPOINTS (for web app only)
  // NOTE: Mobile app uses /api/v1/mobile/user-chat/* endpoints (defined in services/api.ts MOBILE_ENDPOINTS)
  // Mobile and web user chat are SEPARATED to avoid 403 errors
  USER_CHATS: '/api/v1/web/user-chat/chats',
  USER_CHAT_MESSAGES: (chatId: number) => `/api/v1/web/user-chat/chats/${chatId}/messages`,
  USER_CHAT_SEND: (chatId: number) => `/api/v1/web/user-chat/chats/${chatId}/send`,
  USER_CHAT_START: '/api/v1/web/user-chat/start-chat',
  USER_CHAT_SEARCH_USERS: '/api/v1/web/user-chat/search-users',
  
  // User Chat - MOBILE ENDPOINTS (for mobile app only)
  // Mobile app should use these via services/api.ts methods, not directly
  USER_CHATS_MOBILE: '/api/v1/mobile/user-chat/chats',
  USER_CHAT_MESSAGES_MOBILE: (chatId: number) => `/api/v1/mobile/user-chat/chats/${chatId}/messages`,
  USER_CHAT_SEND_MOBILE: (chatId: number) => `/api/v1/mobile/user-chat/chats/${chatId}/send`,
  USER_CHAT_START_MOBILE: '/api/v1/mobile/user-chat/start-chat',
  USER_CHAT_SEARCH_USERS_MOBILE: '/api/v1/mobile/user-chat/search-users',
  
  // Forms
  FORMS: '/api/forms',
  FORMS_BY_ID: (id: number) => `/api/forms/${id}`,
  PUBLIC_FORM: (shareUrl: string) => `/api/forms/${shareUrl}/public`,
  SUBMIT_FORM: (shareUrl: string) => `/api/forms/${shareUrl}/submit`,
  FORM_RESPONSES: (id: number) => `/api/forms/${id}/responses`,
  DUPLICATE_FORM: (id: number) => `/api/forms/${id}/duplicate`,
  
  // Document Templates
  DOCUMENT_TEMPLATES: '/api/document-templates',
  UPLOAD_TEMPLATE: '/api/document-templates/upload',
  DELETE_TEMPLATE: (id: number) => `/api/document-templates/${id}`,
  DEACTIVATE_TEMPLATE: (id: number) => `/api/document-templates/${id}/deactivate`,
  CREATE_DOCUMENT: '/api/create-document',
  COMPLETED_DOCUMENTS: '/api/completed-documents',
  DOWNLOAD_COMPLETED_DOC: (id: number) => `/api/completed-documents/${id}/download`,
  
  // Analytics
  DASHBOARD_ANALYTICS: '/api/dashboard/analytics',
  ANALYTICS: '/api/analysis',
  ACTIVITY_ANALYTICS: '/api/analysis/activity',
  USER_ANALYTICS: '/api/analysis/users',
  RECEIPT_ANALYTICS: '/api/analysis/receipts',
  
  // Admin
  ALL_USERS: '/api/admin/users',
  UPDATE_USER_STATUS: (id: number) => `/api/admin/users/${id}/status`,
  DELETE_USER: (id: number) => `/api/admin/users/${id}`,
  UPDATE_USER_ADMIN: (id: number) => `/api/admin/users/${id}/admin`,
  
  // Upload Links (web API — public upload-to + owner management)
  UPLOAD_LINKS: '/api/v1/web/upload-links',
  UPLOAD_LINK_BY_ID: (id: number) => `/api/v1/web/upload-links/${id}`,
  REGENERATE_UPLOAD_LINK: (id: number) => `/api/v1/web/upload-links/${id}/regenerate`,
  FILES_UPLOADED_VIA_LINKS: '/api/v1/web/files/uploaded-via-links',
  PUBLIC_UPLOAD_INFO: (token: string) => `/api/v1/web/upload-to/${token}`,
  PUBLIC_UPLOAD: (token: string) => `/api/v1/web/upload-to/${token}`,
  
  // Notifications
  NOTIFICATIONS: '/api/notifications',
  MARK_NOTIFICATION_READ: (id: number) => `/api/notifications/${id}/read`,
  MARK_ALL_NOTIFICATIONS_READ: '/api/notifications/mark-all-read',
  
  // Workspaces
  WORKSPACES: '/api/workspaces',
  
  // Feedback
  FEEDBACK: '/api/feedback',
  
  // Health
  HEALTH: '/health',

  // App config (min supported version from backend; no auth required)
  APP_CONFIG: '/api/app-config',
  
  // Mobile OAuth
  MOBILE_GOOGLE_AUTH: '/api/v1/mobile/external-auth/googledrive',
  MOBILE_DROPBOX_AUTH: '/api/v1/mobile/external-auth/dropbox',
  MOBILE_DROPBOX_EXCHANGE: '/api/v1/mobile/external-auth/dropbox/exchange',
  MOBILE_GOOGLE_EXCHANGE: '/api/v1/mobile/external-auth/googledrive/exchange',
  
  // External Files
  EXTERNAL_DROPBOX_FILES: '/api/v1/mobile/external-files/dropbox',
  EXTERNAL_GOOGLE_FILES: '/api/v1/mobile/external-files/googledrive',
} as const;

// Storage Keys
export const STORAGE_KEYS = {
  AUTH_TOKEN: 'auth_token',
  REFRESH_TOKEN: 'refresh_token',
  USER_DATA: 'user_data',
  THEME: 'theme',
  SETTINGS: 'settings',
  OFFLINE_QUEUE: 'offline_queue',
  DEVICE_TOKEN: 'device_token',
  /** Chat IDs where the user explicitly removed the document/bookmark/workspace context. */
  CONTEXT_REMOVED_CHAT_IDS: 'context_removed_chat_ids',
  /** Default landing path from web (`/upload` = ChatGD, `/files`, etc.); may use '/' for mobile-only Main Home. */
  DEFAULT_HOME_WEB_PATH: 'default_home_web_path',
  /** Calendar home: `calendar` vs `list` segmented control. */
  CALENDAR_LAYOUT_MODE: 'calendar_layout_mode',
  /** Device-scoped AI File Manager session correlation id */
  AI_FM_SESSION: 'gd_ai_fm_session',
  /** Legacy single-flag key; migrated into USER_PREFERENCES. */
  WIFI_ONLY_UPLOAD: 'wifi_only_upload',
  /** Full mobile settings preferences blob (display, upload, privacy, etc.). */
  USER_PREFERENCES: 'user_app_preferences',
} as const;

/** After API/network failures, wait this long before showing the orange offline banner (reduces flicker on brief outages). */
export const OFFLINE_BANNER_DELAY_MS = 3500;

// File Upload Settings
export const FILE_UPLOAD = {
  MAX_SIZE: 50 * 1024 * 1024, // 50MB
  ALLOWED_TYPES: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ],
  ALLOWED_EXTENSIONS: [
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', 
    '.ppt', '.pptx', '.txt', '.csv', 
    '.jpg', '.jpeg', '.png', '.gif', '.webp'
  ],
} as const;

// Theme Colors
export const COLORS = {
  primary: '#2563eb',
  primaryDark: '#1d4ed8',
  primaryLight: '#dbeafe',
  secondary: '#64748b',
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  info: '#0ea5e9',
  background: '#ffffff',
  backgroundDark: '#1f2937',
  surface: '#f8fafc',
  surfaceDark: '#374151',
  card: '#f8fafc',
  text: '#1f2937',
  textDark: '#f9fafb',
  textSecondary: '#64748b',
  border: '#e2e8f0',
  borderDark: '#4b5563',
  white: '#ffffff',
  black: '#000000',
} as const;

// Layout Constants
export const LAYOUT = {
  HEADER_HEIGHT: 60,
  TAB_BAR_HEIGHT: 80,
  BORDER_RADIUS: 8,
  SPACING: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 40,
  },
} as const;

// Spacing Constants (separate export for convenience)
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 40,
} as const;

// Typography Constants
export const TYPOGRAPHY = {
  h1: {
    fontSize: 32,
    fontWeight: 'bold' as const,
    lineHeight: 40,
  },
  h2: {
    fontSize: 24,
    fontWeight: 'bold' as const,
    lineHeight: 32,
  },
  h3: {
    fontSize: 20,
    fontWeight: '600' as const,
    lineHeight: 28,
  },
  h4: {
    fontSize: 18,
    fontWeight: '600' as const,
    lineHeight: 24,
  },
  body: {
    fontSize: 16,
    fontWeight: 'normal' as const,
    lineHeight: 22,
  },
  bodySmall: {
    fontSize: 14,
    fontWeight: 'normal' as const,
    lineHeight: 20,
  },
  caption: {
    fontSize: 12,
    fontWeight: 'normal' as const,
    lineHeight: 16,
  },
  button: {
    fontSize: 16,
    fontWeight: '600' as const,
    lineHeight: 20,
  },
} as const;

// Animation Durations
export const ANIMATION = {
  FAST: 150,
  NORMAL: 300,
  SLOW: 500,
} as const;

const ENV = {
  dev: {
    apiUrl: 'http://localhost:5000',
    stripePublishableKey: 'pk_test_your-stripe-test-publishable-key-here', // Replace with your test key
  },
  staging: {
    apiUrl: 'https://your-staging-api.com',
    stripePublishableKey: 'pk_test_your-stripe-test-publishable-key-here', // Replace with your test key
  },
  prod: {
    apiUrl: 'https://your-production-api.com',
    stripePublishableKey: 'pk_live_your-stripe-live-publishable-key-here', // Replace with your live key
  },
};

function getEnvVars(env = Constants.expoConfig?.extra?.releaseChannel) {
  // What is __DEV__ ?
  // This variable is set to true when react-native is running in Dev mode.
  // __DEV__ is true when run locally, but false when published.
  if (process.env.NODE_ENV === 'development') {
    return ENV.dev;
  } else if (env === 'staging') {
    return ENV.staging;
  } else if (env === 'production') {
    return ENV.prod;
  } else {
    return ENV.dev;
  }
}

export default getEnvVars; 