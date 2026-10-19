import AsyncStorage from '@react-native-async-storage/async-storage';
import { FILE_UPLOAD, STORAGE_KEYS } from '../constants/Config';

export type ThemePreference = 'light' | 'dark' | 'system';

export interface UserPreferences {
  theme: ThemePreference;
  notifications: {
    push_enabled: boolean;
    email_enabled: boolean;
    file_upload: boolean;
    file_processing: boolean;
    form_responses: boolean;
    upload_link_activity: boolean;
    workspace_updates: boolean;
  };
  file_management: {
    auto_categorization: boolean;
    auto_receipt_processing: boolean;
    file_preview: boolean;
    auto_backup: boolean;
    compress_images: boolean;
  };
  upload_settings: {
    wifi_only_upload: boolean;
    max_file_size_mb: number;
    allowed_file_types: string[];
  };
  privacy: {
    analytics_tracking: boolean;
    crash_reporting: boolean;
    usage_statistics: boolean;
  };
  display: {
    show_file_sizes: boolean;
    show_upload_dates: boolean;
    grid_view_default: boolean;
    items_per_page: number;
  };
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: 'system',
  notifications: {
    push_enabled: true,
    email_enabled: true,
    file_upload: true,
    file_processing: true,
    form_responses: true,
    upload_link_activity: true,
    workspace_updates: true,
  },
  file_management: {
    auto_categorization: true,
    auto_receipt_processing: true,
    file_preview: true,
    auto_backup: false,
    compress_images: false,
  },
  upload_settings: {
    wifi_only_upload: false,
    max_file_size_mb: Math.round(FILE_UPLOAD.MAX_SIZE / (1024 * 1024)) || 50,
    allowed_file_types: [
      'pdf',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'ppt',
      'pptx',
      'txt',
      'csv',
      'rtf',
      'odt',
      'ods',
      'odp',
      'html',
      'htm',
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'heic',
      'heif',
    ],
  },
  privacy: {
    analytics_tracking: true,
    crash_reporting: true,
    usage_statistics: true,
  },
  display: {
    show_file_sizes: true,
    show_upload_dates: true,
    grid_view_default: false,
    items_per_page: 20,
  },
};

function deepMergePreferences(
  base: UserPreferences,
  patch: Partial<UserPreferences> | null | undefined,
): UserPreferences {
  if (!patch) return { ...base, notifications: { ...base.notifications }, file_management: { ...base.file_management }, upload_settings: { ...base.upload_settings, allowed_file_types: [...base.upload_settings.allowed_file_types] }, privacy: { ...base.privacy }, display: { ...base.display } };

  return {
    theme: patch.theme ?? base.theme,
    notifications: { ...base.notifications, ...(patch.notifications || {}) },
    file_management: { ...base.file_management, ...(patch.file_management || {}) },
    upload_settings: {
      ...base.upload_settings,
      ...(patch.upload_settings || {}),
      allowed_file_types:
        patch.upload_settings?.allowed_file_types ??
        [...base.upload_settings.allowed_file_types],
    },
    privacy: { ...base.privacy, ...(patch.privacy || {}) },
    display: { ...base.display, ...(patch.display || {}) },
  };
}

let memoryCache: UserPreferences | null = null;
const listeners = new Set<(prefs: UserPreferences) => void>();

function notify(prefs: UserPreferences) {
  listeners.forEach((fn) => {
    try {
      fn(prefs);
    } catch {
      /* ignore subscriber errors */
    }
  });
}

export function subscribeUserPreferences(listener: (prefs: UserPreferences) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function getUserPreferences(): Promise<UserPreferences> {
  if (memoryCache) return memoryCache;

  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.USER_PREFERENCES);
    let parsed: Partial<UserPreferences> | null = null;
    if (raw) {
      parsed = JSON.parse(raw) as Partial<UserPreferences>;
    }

    // Migrate legacy wifi-only flag if present and not already in blob.
    if (parsed?.upload_settings?.wifi_only_upload == null) {
      try {
        const legacy = await AsyncStorage.getItem(STORAGE_KEYS.WIFI_ONLY_UPLOAD);
        if (legacy === 'true' || legacy === 'false') {
          parsed = {
            ...(parsed || {}),
            upload_settings: {
              ...(parsed?.upload_settings as UserPreferences['upload_settings']),
              wifi_only_upload: legacy === 'true',
            },
          };
        }
      } catch {
        /* ignore */
      }
    }

    memoryCache = deepMergePreferences(DEFAULT_USER_PREFERENCES, parsed);
    return memoryCache;
  } catch {
    memoryCache = deepMergePreferences(DEFAULT_USER_PREFERENCES, null);
    return memoryCache;
  }
}

export async function saveUserPreferences(prefs: UserPreferences): Promise<UserPreferences> {
  const next = deepMergePreferences(DEFAULT_USER_PREFERENCES, prefs);
  memoryCache = next;
  await AsyncStorage.setItem(STORAGE_KEYS.USER_PREFERENCES, JSON.stringify(next));
  // Keep legacy key in sync for any older readers.
  await AsyncStorage.setItem(
    STORAGE_KEYS.WIFI_ONLY_UPLOAD,
    next.upload_settings.wifi_only_upload ? 'true' : 'false',
  );
  notify(next);
  return next;
}

export async function updateUserPreferences(
  patch: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const current = await getUserPreferences();
  return saveUserPreferences(deepMergePreferences(current, patch));
}

export function getUserPreferencesSync(): UserPreferences {
  return memoryCache ?? deepMergePreferences(DEFAULT_USER_PREFERENCES, null);
}

export async function isAnalyticsTrackingEnabled(): Promise<boolean> {
  return (await getUserPreferences()).privacy.analytics_tracking;
}

export async function isCrashReportingEnabled(): Promise<boolean> {
  return (await getUserPreferences()).privacy.crash_reporting;
}

export async function isUsageStatisticsEnabled(): Promise<boolean> {
  return (await getUserPreferences()).privacy.usage_statistics;
}

export function getFileExtension(name: string): string {
  const parts = name.trim().toLowerCase().split('.');
  if (parts.length < 2) return '';
  return parts[parts.length - 1] || '';
}

export function validateFileAgainstUploadSettings(
  file: { name: string; size?: number; type?: string },
  prefs?: UserPreferences,
): void {
  const settings = (prefs ?? getUserPreferencesSync()).upload_settings;
  const maxBytes = settings.max_file_size_mb * 1024 * 1024;
  if (typeof file.size === 'number' && file.size > 0 && file.size > maxBytes) {
    throw new Error(
      `File too large. Maximum size is ${settings.max_file_size_mb} MB.`,
    );
  }

  const ext = getFileExtension(file.name);
  if (ext && settings.allowed_file_types.length > 0) {
    const allowed = settings.allowed_file_types.map((t) => t.toLowerCase());
    if (!allowed.includes(ext)) {
      throw new Error(
        `File type ".${ext}" is not allowed. Supported: ${allowed.join(', ')}.`,
      );
    }
  }
}
