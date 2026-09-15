/**
 * Mobile Home app visibility — same User.hidden_apps map as web.
 *
 * Always-on features (registry `system: true` on web): cannot be hidden.
 * Quick actions ⊆ always-on features, plus Upload as a mobile-only utility
 * (not a choosable feature; not in Choose your apps).
 *
 * Message workspace seeds hide only non-always-on apps.
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

export type VisibleAppChoice = {
  key: MobileHomeAppKey;
  title: string;
  /** Canonical registry key stored in User.hidden_apps. */
  webKey: string;
  alwaysOn: boolean;
  /** Choose-your-apps grouping. Upload is omitted from this catalog. */
  section: 'always-on' | 'apps';
};

/** Mobile-only utility shortcut on Home Quick actions — not a feature / not choosable. */
export const UPLOAD_UTILITY_KEY = 'upload' as const;

/**
 * Always-on product features (shared with web system apps that exist on mobile Quick actions).
 * Quick action feature tiles must be a subset of this list.
 */
export const ALWAYS_ON_FEATURE_KEYS: readonly MobileHomeAppKey[] = [
  'chatgd',
  'intake',
  'email-sync',
];

export const ALWAYS_ON_FEATURE_KEY_SET = new Set<string>(ALWAYS_ON_FEATURE_KEYS);

/**
 * Home Quick actions = Upload utility + always-on feature tiles.
 * Every feature here must be in ALWAYS_ON_FEATURE_KEYS.
 */
export const QUICK_ACTION_APP_KEYS: readonly MobileHomeAppKey[] = [
  UPLOAD_UTILITY_KEY,
  ...ALWAYS_ON_FEATURE_KEYS,
];

export const QUICK_ACTION_APP_KEY_SET = new Set<string>(QUICK_ACTION_APP_KEYS);

/**
 * Choose your apps catalog. Upload is intentionally absent (utility, not a feature).
 */
export const MOBILE_APP_CHOICES: readonly VisibleAppChoice[] = [
  { key: 'chatgd', title: 'ChatGD', webKey: 'chatgd', alwaysOn: true, section: 'always-on' },
  { key: 'intake', title: 'Intake', webKey: 'intake', alwaysOn: true, section: 'always-on' },
  { key: 'email-sync', title: 'Email Replies', webKey: 'email_replies', alwaysOn: true, section: 'always-on' },
  { key: 'clients', title: 'My Clients', webKey: 'clients', alwaysOn: false, section: 'apps' },
  { key: 'calendar', title: 'Calendar', webKey: 'calendar', alwaysOn: false, section: 'apps' },
  { key: 'meeting-call', title: 'Reach', webKey: 'reach', alwaysOn: false, section: 'apps' },
  { key: 'signatures', title: 'Signatures', webKey: 'signatures', alwaysOn: false, section: 'apps' },
  { key: 'upload-links', title: 'File Request', webKey: 'file_request', alwaysOn: false, section: 'apps' },
  { key: 'form', title: 'Forms', webKey: 'forms', alwaysOn: false, section: 'apps' },
  { key: 'workspaces', title: 'Workspaces', webKey: 'workspace', alwaysOn: false, section: 'apps' },
  { key: 'notes', title: 'Notes', webKey: 'notes', alwaysOn: false, section: 'apps' },
  { key: 'bookmarks', title: 'Bookmarks', webKey: 'bookmarks', alwaysOn: false, section: 'apps' },
  { key: 'chat', title: 'Secure Messaging', webKey: 'chat', alwaysOn: false, section: 'apps' },
  { key: 'analytics', title: 'Financials', webKey: 'financials', alwaysOn: false, section: 'apps' },
];

export const MOBILE_TO_WEB_KEY: Record<string, string> = {
  [UPLOAD_UTILITY_KEY]: 'upload',
  ...Object.fromEntries(MOBILE_APP_CHOICES.map((app) => [app.key, app.webKey])),
};

export function normalizePreferenceMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === 'string' && value === true) out[key] = true;
  }
  return out;
}

export function webKeyForMobileApp(mobileKey: string): string | undefined {
  return MOBILE_TO_WEB_KEY[mobileKey];
}

export function isUploadUtility(mobileKey: string): boolean {
  return mobileKey === UPLOAD_UTILITY_KEY;
}

/** Always-on product feature (not Upload). */
export function isAlwaysOnMobileApp(mobileKey: string): boolean {
  return ALWAYS_ON_FEATURE_KEY_SET.has(mobileKey);
}

/** Stays on Home Quick actions: Upload utility or always-on feature. */
export function isQuickActionApp(mobileKey: string): boolean {
  return QUICK_ACTION_APP_KEY_SET.has(mobileKey);
}

export function isMobileHomeAppVisible(
  mobileKey: string,
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
): boolean {
  // Utility + always-on features ignore hidden_apps (Message seed / web hide must not remove them).
  if (isUploadUtility(mobileKey) || isAlwaysOnMobileApp(mobileKey)) return true;
  const webKey = webKeyForMobileApp(mobileKey) ?? mobileKey;
  if (disabledApps[webKey]) return false;
  if (hiddenApps[webKey]) return false;
  return true;
}

export function isMobileAppToggleLocked(
  mobileKey: string,
  disabledApps: Record<string, boolean> = {},
): boolean {
  if (isAlwaysOnMobileApp(mobileKey)) return true;
  const webKey = webKeyForMobileApp(mobileKey) ?? mobileKey;
  return Boolean(disabledApps[webKey]);
}

export function visibleAppsSummary(
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
): { visible: number; total: number; label: string } {
  const total = MOBILE_APP_CHOICES.length;
  const visible = MOBILE_APP_CHOICES.filter((app) =>
    isMobileHomeAppVisible(app.key, hiddenApps, disabledApps),
  ).length;
  return { visible, total, label: `${visible} of ${total} apps visible` };
}

export function hiddenPatchForToggle(webKey: string, visible: boolean): Record<string, boolean> {
  return { [webKey]: visible ? false : true };
}

export function showAllHiddenPatch(
  hiddenApps: Record<string, boolean>,
  disabledApps: Record<string, boolean> = {},
): Record<string, boolean> {
  const patch: Record<string, boolean> = {};
  for (const app of MOBILE_APP_CHOICES) {
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
    'companyPolicy' in candidate
  ) {
    return candidate;
  }
  return null;
}
