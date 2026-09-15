import {
  ALWAYS_ON_FEATURE_KEYS,
  isAlwaysOnMobileApp,
  isMobileAppToggleLocked,
  isMobileHomeAppVisible,
  isQuickActionApp,
  isUploadUtility,
  MOBILE_APP_CHOICES,
  QUICK_ACTION_APP_KEYS,
  showAllHiddenPatch,
  visibleAppsSummary,
} from '../visibleApps';

describe('mobile visible apps', () => {
  test('Quick actions are Upload utility plus always-on features only', () => {
    expect(QUICK_ACTION_APP_KEYS).toEqual(['upload', 'chatgd', 'intake', 'email-sync']);
    for (const key of QUICK_ACTION_APP_KEYS) {
      if (key === 'upload') {
        expect(isUploadUtility(key)).toBe(true);
        expect(isAlwaysOnMobileApp(key)).toBe(false);
      } else {
        expect(ALWAYS_ON_FEATURE_KEYS).toContain(key);
        expect(isAlwaysOnMobileApp(key)).toBe(true);
      }
      expect(isQuickActionApp(key)).toBe(true);
    }
  });

  test('Upload is not in Choose your apps catalog', () => {
    expect(MOBILE_APP_CHOICES.some((a) => a.key === 'upload')).toBe(false);
  });

  test('always-on features stay visible even when in hidden_apps', () => {
    const hidden = {
      intake: true,
      email_replies: true,
      chatgd: true,
      financials: true,
    };
    expect(isMobileHomeAppVisible('intake', hidden)).toBe(true);
    expect(isMobileHomeAppVisible('email-sync', hidden)).toBe(true);
    expect(isMobileHomeAppVisible('chatgd', hidden)).toBe(true);
    expect(isMobileHomeAppVisible('upload', hidden)).toBe(true);
    expect(isMobileHomeAppVisible('analytics', hidden)).toBe(false);
  });

  test('Apps-section keys honor hidden_apps and company policy', () => {
    expect(isMobileHomeAppVisible('clients', { clients: true })).toBe(false);
    expect(isMobileHomeAppVisible('form', {}, { forms: true })).toBe(false);
    expect(isMobileHomeAppVisible('bookmarks', { bookmarks: true })).toBe(false);
    expect(isMobileHomeAppVisible('analytics', {})).toBe(true);
  });

  test('locks always-on and company-disabled rows', () => {
    expect(isAlwaysOnMobileApp('intake')).toBe(true);
    expect(isAlwaysOnMobileApp('email-sync')).toBe(true);
    expect(isMobileAppToggleLocked('intake', {})).toBe(true);
    expect(isMobileAppToggleLocked('clients', { clients: true })).toBe(true);
    expect(isMobileAppToggleLocked('clients', {})).toBe(false);
  });

  test('show all only unhides hideable apps', () => {
    const patch = showAllHiddenPatch(
      { financials: true, intake: true, forms: true, clients: true },
      { clients: true },
    );
    expect(patch).toEqual({ financials: false, forms: false });
  });

  test('summary counts always-on apps as visible (excludes Upload utility)', () => {
    const { visible, total, label } = visibleAppsSummary({ financials: true, clients: true });
    expect(total).toBe(14);
    expect(visible).toBe(12);
    expect(label).toBe('12 of 14 apps visible');
  });
});
