import {
  buildMobileAppChoices,
  extractAppPreferencesPayload,
  FALLBACK_REGISTRY,
  isAlwaysOnMobileApp,
  isMobileAppToggleLocked,
  isMobileHomeAppVisible,
  isQuickActionApp,
  isUploadUtility,
  QUICK_ACTION_APP_KEYS,
  showAllHiddenPatch,
  systemWebKeysFromRegistry,
  visibleAppsSummary,
} from '../visibleApps';

describe('registry-aligned mobile visible apps', () => {
  const systemKeys = systemWebKeysFromRegistry(FALLBACK_REGISTRY);
  const choices = buildMobileAppChoices(FALLBACK_REGISTRY);

  test('Quick actions are Upload utility plus always-on feature tiles', () => {
    expect(QUICK_ACTION_APP_KEYS).toEqual(['upload', 'chatgd', 'intake', 'email-sync']);
    for (const key of QUICK_ACTION_APP_KEYS) {
      if (key === 'upload') {
        expect(isUploadUtility(key)).toBe(true);
        expect(isAlwaysOnMobileApp(key, systemKeys)).toBe(false);
      } else {
        expect(isAlwaysOnMobileApp(key, systemKeys)).toBe(true);
      }
      expect(isQuickActionApp(key)).toBe(true);
    }
  });

  test('Upload is not in Choose your apps; Bookmarks is the mobile-only exception', () => {
    expect(choices.some((a) => a.key === 'upload')).toBe(false);
    expect(choices.some((a) => a.key === 'bookmarks' && !a.alwaysOn)).toBe(true);
  });

  test('Reach / Forms / File Request are always-on from registry system flag', () => {
    expect(isAlwaysOnMobileApp('meeting-call', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('form', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('upload-links', systemKeys)).toBe(true);
    expect(isAlwaysOnMobileApp('workspaces', systemKeys)).toBe(true);
    expect(choices.find((a) => a.key === 'meeting-call')?.section).toBe('always-on');
  });

  test('always-on features stay visible even when in hidden_apps', () => {
    const hidden = {
      intake: true,
      email_replies: true,
      chatgd: true,
      reach: true,
      financials: true,
    };
    expect(isMobileHomeAppVisible('intake', hidden, {}, systemKeys)).toBe(true);
    expect(isMobileHomeAppVisible('email-sync', hidden, {}, systemKeys)).toBe(true);
    expect(isMobileHomeAppVisible('meeting-call', hidden, {}, systemKeys)).toBe(true);
    expect(isMobileHomeAppVisible('upload', hidden, {}, systemKeys)).toBe(true);
    expect(isMobileHomeAppVisible('analytics', hidden, {}, systemKeys)).toBe(false);
  });

  test('hideable apps honor hidden_apps and company policy', () => {
    expect(isMobileHomeAppVisible('clients', { clients: true }, {}, systemKeys)).toBe(false);
    expect(isMobileHomeAppVisible('bookmarks', { bookmarks: true }, {}, systemKeys)).toBe(false);
    expect(isMobileHomeAppVisible('analytics', {}, {}, systemKeys)).toBe(true);
  });

  test('locks always-on and company-disabled rows', () => {
    expect(isMobileAppToggleLocked('meeting-call', {}, systemKeys)).toBe(true);
    expect(isMobileAppToggleLocked('clients', { clients: true }, systemKeys)).toBe(true);
    expect(isMobileAppToggleLocked('clients', {}, systemKeys)).toBe(false);
  });

  test('show all only unhides hideable apps', () => {
    const patch = showAllHiddenPatch(
      { financials: true, intake: true, forms: true, clients: true, reach: true },
      { clients: true },
      choices,
    );
    expect(patch).toEqual({ financials: false });
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
