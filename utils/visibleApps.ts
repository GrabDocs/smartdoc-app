/**
 * Mobile Home app visibility — registry (`APP_REGISTRY`) is the source of truth.
 *
 * Always-on = registry `system: true` (web + mobile).
 * Quick actions ⊆ always-on features, plus Upload as a mobile-only utility.
 * Bookmarks = mobile-only extra (not in registry; hideable).
 *
 * Message workspace seeds hide only non-system registry apps (+ bookmarks).
 */

export type MobileHomeAppKey =
  | 'upload'
  | 'chatgd'
  | 'intake'
  | 'email-sync'
  | 'clients'
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
  key: MobileHomeAppKey;
  title: string;
  /** Canonical registry key stored in User.hidden_apps. */
  webKey: string;
  alwaysOn: boolean;
  /** Choose-your-apps grouping. Upload is omitted from this catalog. */
  section: 'always-on' | 'apps';
  sortOrder: number;
};

/** Mobile-only utility shortcut on Home Quick actions — not a feature / not choosable. */
export const UPLOAD_UTILITY_KEY = 'upload' as const;

/** Mobile-only feature not in APP_REGISTRY. */
export const BOOKMARKS_MOBILE_KEY = 'bookmarks' as const;
export const BOOKMARKS_WEB_KEY = 'bookmarks' as const;

/**
 * Registry key → mobile Home key for apps that exist on mobile.
 * Web-only apps (files, trends, categories) are omitted from Choose your apps.
 */
export const REGISTRY_TO_MOBILE: Record<string, MobileHomeAppKey> = {
  chatgd: 'chatgd',
  reach: 'meeting-call',
  notes: 'notes',
  calendar: 'calendar',
  email_replies: 'email-sync',
  clients: 'clients',
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
  [BOOKMARKS_MOBILE_KEY]: BOOKMARKS_WEB_KEY,
  ...Object.fromEntries(
    Object.entries(REGISTRY_TO_MOBILE).map(([webKey, mobileKey]) => [mobileKey, webKey]),
  ),
};

/**
 * Quick action *feature* tiles (must be always-on / system in registry).
 * Upload is added separately as a utility — not from this list.
 */
export const QUICK_ACTION_FEATURE_WEB_KEYS = ['chatgd', 'intake', 'email_replies'] as const;

export const QUICK_ACTION_APP_KEYS: readonly MobileHomeAppKey[] = [
  UPLOAD_UTILITY_KEY,
  'chatgd',
  'intake',
  'email-sync',
];

export const QUICK_ACTION_APP_KEY_SET = new Set<string>(QUICK_ACTION_APP_KEYS);

const BOOKMARKS_CHOICE: VisibleAppChoice = {
  key: BOOKMARKS_MOBILE_KEY,
  title: 'Bookmarks',
  webKey: BOOKMARKS_WEB_KEY,
  alwaysOn: false,
  section: 'apps',
  sortOrder: 10_000,
};

/**
 * Offline / pre-registry fallback matching current backend system flags.
 * Used until auth-check / app-preferences delivers `appFeatures`.
 */
export const FALLBACK_REGISTRY: AppFeatureFromApi[] = [
  { key: 'chatgd', name: 'ChatGD', system: true, sortOrder: 10 },
  { key: 'reach', name: 'Reach', system: true, sortOrder: 20 },
  { key: 'files', name: 'Files + AI', system: true, sortOrder: 30 },
  { key: 'notes', name: 'Notes', system: false, sortOrder: 40 },
  { key: 'calendar', name: 'Calendar', system: false, sortOrder: 50 },
  { key: 'email_replies', name: 'Email Replies', system: true, sortOrder: 55 },
  { key: 'clients', name: 'My Clients', system: false, sortOrder: 58 },
  { key: 'file_request', name: 'File Request', system: true, sortOrder: 60 },
  { key: 'intake', name: 'Intake', system: true, sortOrder: 65 },
  { key: 'forms', name: 'Forms', system: true, sortOrder: 70 },
  { key: 'signatures', name: 'Signatures', system: false, sortOrder: 80 },
  { key: 'chat', name: 'Secure Messaging', system: false, sortOrder: 90 },
  { key: 'workspace', name: 'Workspace', description: 'Collaborate with a team', system: true, sortOrder: 100 },
  { key: 'financials', name: 'Financials', system: false, sortOrder: 110 },
  { key: 'trends', name: 'Trends', system: false, sortOrder: 120 },
  { key: 'categories', name: 'Categories', system: false, sortOrder: 130 },
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

export function isQuickActionApp(mobileKey: string): boolean {
  return QUICK_ACTION_APP_KEY_SET.has(mobileKey);
}

/** Build Choose-your-apps rows from registry + Bookmarks exception (no Upload). */
export function buildMobileAppChoices(
  registry: AppFeatureFromApi[],
): VisibleAppChoice[] {
  const source = registry.length ? registry : FALLBACK_REGISTRY;
  const choices: VisibleAppChoice[] = [];

  for (const app of source) {
    const mobileKey = REGISTRY_TO_MOBILE[app.key];
    if (!mobileKey) continue; // web-only (files, trends, categories, …)
    const alwaysOn = Boolean(app.system);
    choices.push({
      key: mobileKey,
      title: app.name,
      webKey: app.key,
      alwaysOn,
      section: alwaysOn ? 'always-on' : 'apps',
      sortOrder: app.sortOrder ?? 0,
    });
  }

  choices.push(BOOKMARKS_CHOICE);
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
  if (isUploadUtility(mobileKey)) return false;
  const webKey = webKeyForMobileApp(mobileKey);
  if (!webKey) return false;
  return systemWebKeys.has(webKey);
}

export function isMobileHomeAppVisible(
  mobileKey: string,
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
  systemWebKeys: Set<string> = systemWebKeysFromRegistry(FALLBACK_REGISTRY),
): boolean {
  if (isUploadUtility(mobileKey)) return true;
  const webKey = webKeyForMobileApp(mobileKey) ?? mobileKey;
  if (systemWebKeys.has(webKey)) return true;
  if (disabledApps[webKey]) return false;
  if (hiddenApps[webKey]) return false;
  return true;
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

export function visibleAppsSummary(
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
  choices: readonly VisibleAppChoice[] = MOBILE_APP_CHOICES,
  systemWebKeys: Set<string> = systemWebKeysFromRegistry(FALLBACK_REGISTRY),
): { visible: number; total: number; label: string } {
  const total = choices.length;
  const visible = choices.filter((app) =>
    isMobileHomeAppVisible(app.key, hiddenApps, disabledApps, systemWebKeys),
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

export type AppPreferencesPayload = {
  hiddenApps?: Record<string, boolean>;
  hidden_apps?: Record<string, boolean>;
  companyPolicy?: { disabledApps?: Record<string, boolean>; disabled_apps?: Record<string, boolean> };
  appFeatures?: AppFeatureFromApi[];
  apps?: AppFeatureFromApi[];
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
    'apps' in candidate
  ) {
    return candidate;
  }
  return null;
}

export function extractRegistryFromPayload(payload: AppPreferencesPayload | null): AppFeatureFromApi[] {
  if (!payload) return [];
  return normalizeAppRegistry(payload.appFeatures ?? payload.apps);
}
