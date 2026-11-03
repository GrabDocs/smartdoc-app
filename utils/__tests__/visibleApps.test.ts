import {
  buildMobileAppChoices,
  extractAppPreferencesPayload,
  FALLBACK_REGISTRY,
  FILES_UTILITY_KEY,
  hasOnlyDefaultAppsOn,
  isAlwaysOnMobileApp,
  isBookmarkShortcut,
  isFilesUtility,
  isMobileAppToggleLocked,
  isMobileHomeAppVisible,
  isQuickActionApp,
  isRegistryAppVisible,
  isUploadUtility,
  QUICK_ACTION_APP_KEYS,
  hideAllHiddenPatch,
  showAllHiddenPatch,
  systemWebKeysFromRegistry,
  visibleAppsSummary,
} from '../visibleApps';

describe('registry-aligned mobile visible apps', () => {
  const systemKeys = systemWebKeysFromRegistry(FALLBACK_REGISTRY);
  const choices = buildMobileAppChoices(FALLBACK_REGISTRY);

  test('Quick actions are Upload, ChatGD, My Files, Reach', () => {
    expect(QUICK_ACTION_APP_KEYS).toEqual(['upload', 'chatgd', 'files', 'meeting-call']);
    expect(isAlwaysOnMobileApp('upload', systemKeys)).toBe(false);
    expect(isAlwaysOnMobileApp('chatgd', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('files', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('meeting-call', systemKeys)).toBe(true);
    for (const key of QUICK_ACTION_APP_KEYS) {
      expect(isQuickActionApp(key)).toBe(true);
    }
    expect(isUploadUtility('upload')).toBe(true);
    expect(isFilesUtility(FILES_UTILITY_KEY)).toBe(true);
  });

  test('Choose your apps is mobile-only and omits Upload, Bookmarks, and web-only apps', () => {
    expect(choices.some((a) => a.key === 'upload' || a.webKey === 'upload')).toBe(false);
    expect(choices.some((a) => a.webKey === 'bookmarks')).toBe(false);
    expect(choices.some((a) => a.webKey === 'categories')).toBe(false);
    expect(choices.some((a) => a.webKey === 'trends')).toBe(false);
    expect(choices.some((a) => a.webKey === 'agentic')).toBe(false);
    expect(choices.find((a) => a.webKey === 'files')?.key).toBe('files');
    expect(choices.find((a) => a.webKey === 'files')?.title).toBe('My Files');
    expect(choices.find((a) => a.webKey === 'reach')?.key).toBe('meeting-call');
    expect(isBookmarkShortcut('bookmarks')).toBe(true);
  });

  test('ChatGD / Reach / Files + AI / Calendar are always-on; Intake and Email Replies are not', () => {
    expect(isAlwaysOnMobileApp('chatgd', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('meeting-call', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('files', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('calendar', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('intake', systemKeys)).toBe(false);
    expect(isAlwaysOnMobileApp('email-sync', systemKeys)).toBe(false);
    expect(isAlwaysOnMobileApp('form', systemKeys)).toBe(false);
    expect(isAlwaysOnMobileApp('upload-links', systemKeys)).toBe(false);
    expect(isAlwaysOnMobileApp('workspaces', systemKeys)).toBe(false);
    expect(choices.find((a) => a.key === 'meeting-call')?.section).toBe('always-on');
    expect(choices.find((a) => a.key === 'files')?.section).toBe('always-on');
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
    // Files + AI is always-on — stays visible even if listed in hidden_apps.
    expect(isRegistryAppVisible('files', hidden, {}, systemKeys)).toBe(true);
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

  test('hide all only hides optional apps that are currently shown', () => {
    const patch = hideAllHiddenPatch(
      { financials: true, reach: true },
      { clients: true },
      choices,
    );
    expect(patch.financials).toBeUndefined();
    expect(patch.reach).toBeUndefined();
    expect(patch.clients).toBeUndefined();
    expect(patch.chatgd).toBeUndefined();
    expect(patch.calendar).toBeUndefined();
    expect(patch.notes).toBe(true);
    expect(patch.intake).toBe(true);
    for (const app of choices) {
      if (app.alwaysOn || app.webKey === 'clients' || app.webKey === 'financials') {
        expect(patch[app.webKey]).toBeUndefined();
      } else {
        expect(patch[app.webKey]).toBe(true);
      }
    }
  });

  test('More Apps tile when fewer than 5 additional apps are visible', () => {
    const allOptionalHidden: Record<string, boolean> = {};
    for (const app of choices) {
      if (!app.alwaysOn) allOptionalHidden[app.webKey] = true;
    }
    expect(hasOnlyDefaultAppsOn(allOptionalHidden, {}, choices, systemKeys)).toBe(true);

    const fourVisible = { ...allOptionalHidden };
    const optional = choices.filter((app) => !app.alwaysOn);
    for (const app of optional.slice(0, 4)) {
      delete fourVisible[app.webKey];
    }
    expect(hasOnlyDefaultAppsOn(fourVisible, {}, choices, systemKeys)).toBe(true);

    const fiveVisible = { ...allOptionalHidden };
    for (const app of optional.slice(0, 5)) {
      delete fiveVisible[app.webKey];
    }
    expect(hasOnlyDefaultAppsOn(fiveVisible, {}, choices, systemKeys)).toBe(false);
    expect(hasOnlyDefaultAppsOn({}, {}, choices, systemKeys)).toBe(
      optional.length < 5,
    );
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
