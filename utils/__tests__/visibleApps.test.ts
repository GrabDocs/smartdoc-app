import {
  buildMobileAppChoices,
  extractAppPreferencesPayload,
  FALLBACK_REGISTRY,
  FILES_UTILITY_KEY,
  hasOnlyDefaultAppsOn,
  isAlwaysOnMobileApp,
  isBookmarkShortcut,
  isFilesUtility,
  isHomeUtility,
  isMobileAppToggleLocked,
  isMobileHomeAppVisible,
  isQuickActionApp,
  isRegistryAppVisible,
  isUploadUtility,
  QUICK_ACTION_APP_KEYS,
  showAllHiddenPatch,
  systemWebKeysFromRegistry,
  visibleAppsSummary,
} from '../visibleApps';

describe('registry-aligned mobile visible apps', () => {
  const systemKeys = systemWebKeysFromRegistry(FALLBACK_REGISTRY);
  const choices = buildMobileAppChoices(FALLBACK_REGISTRY);

  test('Quick actions are Upload, My Files, ChatGD, Reach', () => {
    expect(QUICK_ACTION_APP_KEYS).toEqual(['upload', 'files', 'chatgd', 'meeting-call']);
    for (const key of QUICK_ACTION_APP_KEYS) {
      if (isHomeUtility(key)) {
        expect(isAlwaysOnMobileApp(key, systemKeys)).toBe(false);
      } else {
        expect(isAlwaysOnMobileApp(key, systemKeys)).toBe(true);
      }
      expect(isQuickActionApp(key)).toBe(true);
    }
    expect(isUploadUtility('upload')).toBe(true);
    expect(isFilesUtility(FILES_UTILITY_KEY)).toBe(true);
  });

  test('Choose your apps matches the registry and omits Upload and Bookmarks', () => {
    expect(choices.some((a) => a.key === 'upload' || a.webKey === 'upload')).toBe(false);
    expect(choices.some((a) => a.webKey === 'bookmarks')).toBe(false);
    expect(choices.map((a) => a.webKey).sort()).toEqual(
      FALLBACK_REGISTRY.map((a) => a.key).sort(),
    );
    expect(choices.find((a) => a.webKey === 'files')?.key).toBe('files');
    expect(choices.find((a) => a.webKey === 'reach')?.key).toBe('meeting-call');
    expect(isBookmarkShortcut('bookmarks')).toBe(true);
  });

  test('ChatGD / Reach / Calendar are always-on; Intake and Email Replies are not', () => {
    expect(isAlwaysOnMobileApp('chatgd', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('meeting-call', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('calendar', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('intake', systemKeys)).toBe(false);
    expect(isAlwaysOnMobileApp('email-sync', systemKeys)).toBe(false);
    expect(isAlwaysOnMobileApp('form', systemKeys)).toBe(false);
    expect(isAlwaysOnMobileApp('upload-links', systemKeys)).toBe(false);
    expect(isAlwaysOnMobileApp('workspaces', systemKeys)).toBe(false);
    expect(choices.find((a) => a.key === 'meeting-call')?.section).toBe('always-on');
    expect(choices.find((a) => a.key === 'calendar')?.section).toBe('always-on');
    expect(choices.find((a) => a.key === 'intake')?.section).toBe('apps');
  });

  test('always-on features stay visible even when in hidden_apps', () => {
    const hidden = {
      intake: true,
      email_replies: true,
      chatgd: true,
      reach: true,
      calendar: true,
      financials: true,
      files: true,
    };
    expect(isMobileHomeAppVisible('chatgd', hidden, {}, systemKeys)).toBe(true);
    expect(isMobileHomeAppVisible('meeting-call', hidden, {}, systemKeys)).toBe(true);
    expect(isMobileHomeAppVisible('calendar', hidden, {}, systemKeys)).toBe(true);
    expect(isMobileHomeAppVisible('upload', hidden, {}, systemKeys)).toBe(true);
    expect(isMobileHomeAppVisible('files', hidden, {}, systemKeys)).toBe(true);
    expect(isMobileHomeAppVisible('bookmarks', { bookmarks: true }, {}, systemKeys)).toBe(true);
    expect(isRegistryAppVisible('files', hidden, {}, systemKeys)).toBe(false);
    expect(isMobileHomeAppVisible('intake', hidden, {}, systemKeys)).toBe(false);
    expect(isMobileHomeAppVisible('email-sync', hidden, {}, systemKeys)).toBe(false);
    expect(isMobileHomeAppVisible('analytics', hidden, {}, systemKeys)).toBe(false);
  });

  test('hideable apps honor hidden_apps and company policy', () => {
    expect(isMobileHomeAppVisible('clients', { clients: true }, {}, systemKeys)).toBe(false);
    expect(isRegistryAppVisible('trends', { trends: true }, {}, systemKeys)).toBe(false);
    expect(isRegistryAppVisible('agentic', {}, {}, systemKeys)).toBe(true);
    expect(isMobileHomeAppVisible('analytics', {}, {}, systemKeys)).toBe(true);
  });

  test('locks always-on and company-disabled rows', () => {
    expect(isMobileAppToggleLocked('meeting-call', {}, systemKeys)).toBe(true);
    expect(isMobileAppToggleLocked('calendar', {}, systemKeys)).toBe(true);
    expect(isMobileAppToggleLocked('clients', { clients: true }, systemKeys)).toBe(true);
    expect(isMobileAppToggleLocked('clients', {}, systemKeys)).toBe(false);
    expect(isMobileAppToggleLocked('intake', {}, systemKeys)).toBe(false);
  });

  test('show all only unhides hideable apps', () => {
    const patch = showAllHiddenPatch(
      { financials: true, intake: true, forms: true, clients: true, reach: true },
      { clients: true },
      choices,
    );
    expect(patch).toEqual({ financials: false, intake: false, forms: false });
  });

  test('More Apps tile when only default apps are on', () => {
    const allOptionalHidden: Record<string, boolean> = {};
    for (const app of choices) {
      if (!app.alwaysOn) allOptionalHidden[app.webKey] = true;
    }
    expect(hasOnlyDefaultAppsOn(allOptionalHidden, {}, choices, systemKeys)).toBe(true);
    expect(hasOnlyDefaultAppsOn({}, {}, choices, systemKeys)).toBe(false);
  });

  test('summary uses registry-built choices', () => {
    const { visible, total, label } = visibleAppsSummary(
      { financials: true, clients: true },
      {},
      choices,
      systemKeys,
    );
    expect(total).toBe(choices.length);
    expect(visible).toBe(total - 2);
    expect(label).toBe(`${visible} of ${total} apps visible`);
  });

  test('extractAppPreferencesPayload reads registry from preferences payload', () => {
    const payload = extractAppPreferencesPayload({
      success: true,
      hiddenApps: { clients: true },
      appFeatures: [{ key: 'reach', name: 'Reach', system: true, sortOrder: 20 }],
    });
    expect(payload?.appFeatures?.[0]?.key).toBe('reach');
  });
});
