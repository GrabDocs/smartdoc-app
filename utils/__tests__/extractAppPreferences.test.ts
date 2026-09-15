import { extractAppPreferencesPayload } from '../visibleApps';

describe('extractAppPreferencesPayload', () => {
  test('reads top-level mobile app-preferences response', () => {
    const payload = extractAppPreferencesPayload({
      success: true,
      hiddenApps: { financials: true, clients: true },
      companyPolicy: { disabledApps: {} },
    });
    expect(payload?.hiddenApps).toEqual({ financials: true, clients: true });
  });

  test('reads nested auth-check / user profile data', () => {
    const payload = extractAppPreferencesPayload({
      success: true,
      data: {
        hiddenApps: { reach: true },
        companyPolicy: { disabledApps: { notes: true } },
      },
    });
    expect(payload?.hiddenApps).toEqual({ reach: true });
    expect(payload?.companyPolicy?.disabledApps).toEqual({ notes: true });
  });

  test('returns null when prefs are absent', () => {
    expect(extractAppPreferencesPayload({ success: true, data: { id: 1 } })).toBeNull();
    expect(extractAppPreferencesPayload(null)).toBeNull();
  });
});
