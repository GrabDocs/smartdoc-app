/**
 * Mobile Home app visibility — registry (`APP_REGISTRY`) is the source of truth.
 *
 * Always-on = registry `system: true` (web + mobile): ChatGD, Reach, Calendar.
 * Hideable apps are the same registry keys on web and mobile.
 * Quick actions = Upload + My Files utilities, plus ChatGD and Reach.
 * Bookmarks is a shortcut, not an app, and is not stored in hidden_apps.
 */

export type MobileHomeAppKey =
  | 'upload'
  | 'files'
  | 'chatgd'
  | 'intake'
  | 'email-sync'
  | 'clients'
  | 'assist'
  | 'calendar'
  | 'meeting-call'
  | 'signatures'
  | 'upload-links'
  | 'form'
  | 'workspaces'
  | 'notes'
  | 'bookmarks'
  | 'chat'
  | 'analytics';

export type AppFeatureFromApi = {
  key: string;
  name: string;
  description?: string;
  path?: string;
  system?: boolean;
  availability?: string;
  sortOrder?: number;
};

export type VisibleAppChoice = {
  /** Home key when the app has a mobile screen; otherwise the registry key. */
  key: string;
  title: string;
  description?: string;
  /** Canonical registry key stored in User.hidden_apps. Same on web and mobile. */
  webKey: string;
  alwaysOn: boolean;
  /** Choose-your-apps grouping. Upload and Bookmarks are omitted from this catalog. */
  section: 'always-on' | 'apps';
  sortOrder: number;
};

/** Mobile-only utility shortcut on Home Quick actions — not a feature / not choosable. */
export const UPLOAD_UTILITY_KEY = 'upload' as const;

/** Home shortcut to the existing Documents tab — not choosable. */
export const FILES_UTILITY_KEY = 'files' as const;

export const VISIBLE_APPS_SETUP_VERSION = '2026-10-30';

/**
 * Registry key → mobile Home key for apps that have a mobile screen.
 * Registry apps without a mobile screen stay in Choose your apps under their registry key
 * so the hidden set matches web.
 */
export const REGISTRY_TO_MOBILE: Record<string, MobileHomeAppKey> = {
  chatgd: 'chatgd',
  reach: 'meeting-call',
  notes: 'notes',
  calendar: 'calendar',
  email_replies: 'email-sync',
  clients: 'clients',
  grabdocs_assist: 'assist',
  file_request: 'upload-links',
  intake: 'intake',
  forms: 'form',
  signatures: 'signatures',
  chat: 'chat',
  workspace: 'workspaces',
  financials: 'analytics',
};

export const MOBILE_TO_WEB_KEY: Record<string, string> = {
  [UPLOAD_UTILITY_KEY]: 'upload',
  [FILES_UTILITY_KEY]: 'files',
  ...Object.fromEntries(
    Object.entries(REGISTRY_TO_MOBILE).map(([webKey, mobileKey]) => [mobileKey, webKey]),
  ),
};

/**
 * Quick action *feature* tiles (ChatGD + Reach). Upload and My Files are utilities.
 */
export const QUICK_ACTION_FEATURE_WEB_KEYS = ['chatgd', 'reach'] as const;

export const QUICK_ACTION_APP_KEYS: readonly MobileHomeAppKey[] = [
  UPLOAD_UTILITY_KEY,
  FILES_UTILITY_KEY,
  'chatgd',
  'meeting-call',
];

export const QUICK_ACTION_APP_KEY_SET = new Set<string>(QUICK_ACTION_APP_KEYS);

/**
 * Offline / pre-registry fallback matching current backend system flags.
 * Used until auth-check / app-preferences delivers `appFeatures`.
 */
export const FALLBACK_REGISTRY: AppFeatureFromApi[] = [
  { key: 'chatgd', name: 'ChatGD', description: 'Ask questions of my documents', system: true, sortOrder: 10 },
  { key: 'reach', name: 'Reach', description: 'Start and join video meetings', system: true, sortOrder: 20 },
  { key: 'files', name: 'Files + AI', description: 'Browse and organize my files', system: false, sortOrder: 30 },
  { key: 'notes', name: 'Notes', description: 'Write and manage notes', system: false, sortOrder: 40 },
  { key: 'calendar', name: 'Calendar', description: 'Schedule and manage events', system: true, sortOrder: 50 },
  { key: 'email_replies', name: 'Email Replies', description: 'Draft replies to emails', system: false, sortOrder: 55 },
  { key: 'grabdocs_assist', name: 'Assist', description: 'Daily brief, archive, calls, and follow-ups', system: false, sortOrder: 57 },
  { key: 'clients', name: 'My Clients', description: 'Track client work', system: false, sortOrder: 58 },
  { key: 'agentic', name: 'Agents', description: 'Run custom document agents', system: false, sortOrder: 59 },
  { key: 'file_request', name: 'File Request', description: 'Collect files from others', system: false, sortOrder: 60 },
  { key: 'intake', name: 'Intake', description: 'Request documents with a checklist', system: false, sortOrder: 65 },
  { key: 'forms', name: 'Forms', description: 'Create and send forms', system: false, sortOrder: 70 },
  { key: 'signatures', name: 'Signatures', description: 'Send documents for signature', system: false, sortOrder: 80 },
  { key: 'chat', name: 'Secure Messaging', description: 'Private encrypted messaging', system: false, sortOrder: 90 },
  { key: 'workspace', name: 'Workspace', description: 'Collaborate with a team', system: false, sortOrder: 100 },
  { key: 'financials', name: 'Financials', description: 'Track expenses and receipts', system: false, sortOrder: 110 },
  { key: 'trends', name: 'Trends', description: 'See document trends', system: false, sortOrder: 120 },
  { key: 'categories', name: 'Categories', description: 'Organize files by category', system: false, sortOrder: 130 },
];

/** @deprecated Use buildMobileAppChoices(registry) — kept for tests / gradual migration. */
export const MOBILE_APP_CHOICES: readonly VisibleAppChoice[] =
  buildMobileAppChoices(FALLBACK_REGISTRY);

export function normalizePreferenceMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === 'string' && value === true) out[key] = true;
  }
  return out;
}

export function normalizeAppRegistry(raw: unknown): AppFeatureFromApi[] {
  if (!Array.isArray(raw)) return [];
  const out: AppFeatureFromApi[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.key !== 'string' || !o.key.trim()) continue;
    out.push({
      key: o.key,
      name: typeof o.name === 'string' && o.name.trim() ? o.name : o.key,
      description: typeof o.description === 'string' ? o.description : undefined,
      path: typeof o.path === 'string' ? o.path : undefined,
      system: Boolean(o.system),
      availability: typeof o.availability === 'string' ? o.availability : 'all',
      sortOrder: typeof o.sortOrder === 'number' ? o.sortOrder : 0,
    });
  }
  return out.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

export function webKeyForMobileApp(mobileKey: string): string | undefined {
  return MOBILE_TO_WEB_KEY[mobileKey];
}

export function mobileKeyForRegistryKey(webKey: string): MobileHomeAppKey | undefined {
  return REGISTRY_TO_MOBILE[webKey];
}

export function isUploadUtility(mobileKey: string): boolean {
  return mobileKey === UPLOAD_UTILITY_KEY;
}

export function isFilesUtility(mobileKey: string): boolean {
  return mobileKey === FILES_UTILITY_KEY;
}

export function isHomeUtility(mobileKey: string): boolean {
  return isUploadUtility(mobileKey) || isFilesUtility(mobileKey);
}

export function isQuickActionApp(mobileKey: string): boolean {
  return QUICK_ACTION_APP_KEY_SET.has(mobileKey);
}

/** Choose-your-apps rows: every registry app, same keys as web. No Upload, no Bookmarks. */
export function buildMobileAppChoices(
  registry: AppFeatureFromApi[],
): VisibleAppChoice[] {
  const source = registry.length ? registry : FALLBACK_REGISTRY;
  const choices: VisibleAppChoice[] = source.map((app) => {
    const alwaysOn = Boolean(app.system);
    return {
      key: REGISTRY_TO_MOBILE[app.key] ?? app.key,
      title: app.name,
      description: app.description,
      webKey: app.key,
      alwaysOn,
      section: alwaysOn ? 'always-on' : 'apps',
      sortOrder: app.sortOrder ?? 0,
    };
  });

  return choices.sort((a, b) => {
    if (a.section !== b.section) return a.section === 'always-on' ? -1 : 1;
    return a.sortOrder - b.sortOrder;
  });
}

export function systemWebKeysFromRegistry(registry: AppFeatureFromApi[]): Set<string> {
  const source = registry.length ? registry : FALLBACK_REGISTRY;
  return new Set(source.filter((a) => a.system).map((a) => a.key));
}

export function isAlwaysOnWebKey(
  webKey: string,
  systemWebKeys: Set<string>,
): boolean {
  return systemWebKeys.has(webKey);
}

/** Always-on product feature from registry system flag (not Upload). */
export function isAlwaysOnMobileApp(
  mobileKey: string,
  systemWebKeys: Set<string> = systemWebKeysFromRegistry(FALLBACK_REGISTRY),
): boolean {
  if (isHomeUtility(mobileKey)) return false;
  const webKey = webKeyForMobileApp(mobileKey);
  if (!webKey) return false;
  return systemWebKeys.has(webKey);
}

/** Bookmarks is a shortcut, not a registry app. */
export function isBookmarkShortcut(mobileKey: string): boolean {
  return mobileKey === 'bookmarks';
}

/** Registry visibility. Same hidden_apps keys as web. Ignores Home shortcuts. */
export function isRegistryAppVisible(
  webKey: string,
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
  systemWebKeys: Set<string> = systemWebKeysFromRegistry(FALLBACK_REGISTRY),
): boolean {
  if (systemWebKeys.has(webKey)) return true;
  if (disabledApps[webKey]) return false;
  if (hiddenApps[webKey]) return false;
  return true;
}

export function isMobileHomeAppVisible(
  mobileKey: string,
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
  systemWebKeys: Set<string> = systemWebKeysFromRegistry(FALLBACK_REGISTRY),
): boolean {
  if (isHomeUtility(mobileKey) || isBookmarkShortcut(mobileKey)) return true;
  const webKey = webKeyForMobileApp(mobileKey) ?? mobileKey;
  return isRegistryAppVisible(webKey, hiddenApps, disabledApps, systemWebKeys);
}

export function isMobileAppToggleLocked(
  mobileKey: string,
  disabledApps: Record<string, boolean> = {},
  systemWebKeys: Set<string> = systemWebKeysFromRegistry(FALLBACK_REGISTRY),
): boolean {
  if (isAlwaysOnMobileApp(mobileKey, systemWebKeys)) return true;
  const webKey = webKeyForMobileApp(mobileKey) ?? mobileKey;
  return Boolean(disabledApps[webKey]);
}

/** True when no hideable (non-always-on) app is visible — show the More Apps tile. */
export function hasOnlyDefaultAppsOn(
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
  choices: readonly VisibleAppChoice[] = MOBILE_APP_CHOICES,
  systemWebKeys: Set<string> = systemWebKeysFromRegistry(FALLBACK_REGISTRY),
): boolean {
  return choices
    .filter((app) => !app.alwaysOn)
    .every((app) => !isRegistryAppVisible(app.webKey, hiddenApps, disabledApps, systemWebKeys));
}

export function visibleAppsSummary(
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
  choices: readonly VisibleAppChoice[] = MOBILE_APP_CHOICES,
  systemWebKeys: Set<string> = systemWebKeysFromRegistry(FALLBACK_REGISTRY),
): { visible: number; total: number; label: string } {
  const total = choices.length;
  const visible = choices.filter((app) =>
    isRegistryAppVisible(app.webKey, hiddenApps, disabledApps, systemWebKeys),
  ).length;
  return { visible, total, label: `${visible} of ${total} apps visible` };
}

export function hiddenPatchForToggle(webKey: string, visible: boolean): Record<string, boolean> {
  return { [webKey]: visible ? false : true };
}

export function showAllHiddenPatch(
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
  choices: readonly VisibleAppChoice[] = MOBILE_APP_CHOICES,
): Record<string, boolean> {
  const patch: Record<string, boolean> = {};
  for (const app of choices) {
    if (app.alwaysOn) continue;
    if (disabledApps[app.webKey]) continue;
    if (hiddenApps[app.webKey]) patch[app.webKey] = false;
  }
  return patch;
}

/** Hide every optional app. Always-on apps and company-disabled apps are left unchanged. */
export function hideAllHiddenPatch(
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
  choices: readonly VisibleAppChoice[] = MOBILE_APP_CHOICES,
): Record<string, boolean> {
  const patch: Record<string, boolean> = {};
  for (const app of choices) {
    if (app.alwaysOn) continue;
    if (disabledApps[app.webKey]) continue;
    if (!hiddenApps[app.webKey]) patch[app.webKey] = true;
  }
  return patch;
}

export type AppPreferencesPayload = {
  hiddenApps?: Record<string, boolean>;
  hidden_apps?: Record<string, boolean>;
  companyPolicy?: { disabledApps?: Record<string, boolean>; disabled_apps?: Record<string, boolean> };
  appFeatures?: AppFeatureFromApi[];
  apps?: AppFeatureFromApi[];
  /** Feature-flag gate for Assist (same as web `grabdocsAssistEnabled`). */
  grabdocsAssistEnabled?: boolean;
};

/** Accept top-level or nested `{ data: ... }` mobile API envelopes. */
export function extractAppPreferencesPayload(raw: unknown): AppPreferencesPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as AppPreferencesPayload & { data?: AppPreferencesPayload };
  const nested = root.data && typeof root.data === 'object' ? root.data : null;
  const candidate = nested ?? root;
  if (
    'hiddenApps' in candidate ||
    'hidden_apps' in candidate ||
    'companyPolicy' in candidate ||
    'appFeatures' in candidate ||
    'apps' in candidate ||
    'grabdocsAssistEnabled' in candidate
  ) {
    return candidate;
  }
  return null;
}

export function extractRegistryFromPayload(payload: AppPreferencesPayload | null): AppFeatureFromApi[] {
  if (!payload) return [];
  return normalizeAppRegistry(payload.appFeatures ?? payload.apps);
}
