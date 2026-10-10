jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

import { resolveAppDeepLinkPath, APP_HOME_PATH } from '../resolveAppDeepLinkPath';

describe('resolveAppDeepLinkPath', () => {
  it('maps meeting App Links to join-meeting', () => {
    expect(resolveAppDeepLinkPath('https://app.grabdocs.com/meeting/48974916')).toBe(
      '/join-meeting?meeting_id=48974916',
    );
    expect(resolveAppDeepLinkPath('/meeting/48974916')).toBe('/join-meeting?meeting_id=48974916');
  });

  it('maps empty / unknown to home', () => {
    expect(resolveAppDeepLinkPath('')).toBe(APP_HOME_PATH);
    expect(resolveAppDeepLinkPath('grabdocs:///')).toBe(APP_HOME_PATH);
    expect(resolveAppDeepLinkPath('/nope/unknown')).toBe(APP_HOME_PATH);
  });

  it('rewrites web notification paths used by the backend', () => {
    expect(resolveAppDeepLinkPath('/calendar/event/42')).toBe('/calendar/42');
    expect(resolveAppDeepLinkPath('/chat?chat_id=9')).toBe('/user-chat?chatId=9');
    expect(resolveAppDeepLinkPath('/chat?secure_invite_id=3')).toBe('/user-chat');
    expect(resolveAppDeepLinkPath('/documents')).toBe('/(tabs)/documents');
    expect(resolveAppDeepLinkPath('/files?tab=email-sync&threadId=3')).toBe('/email-sync?threadId=3');
    expect(resolveAppDeepLinkPath('/video-meeting')).toBe('/quick-reach/meeting-call');
    expect(resolveAppDeepLinkPath('/agentic/1')).toBe(APP_HOME_PATH);
    expect(resolveAppDeepLinkPath('/book/foo')).toBe(APP_HOME_PATH);
    expect(resolveAppDeepLinkPath('/signatures/abc')).toBe('/signatures/abc');
    expect(resolveAppDeepLinkPath('/intake/4')).toBe('/intake/4');
  });
});
