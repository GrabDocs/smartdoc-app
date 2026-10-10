/**
 * Rewrite App Links / custom-scheme URLs before Expo Router matches routes.
 * Meeting links → /join-meeting; public /book → browser + home; unknown → home.
 */
import * as WebBrowser from 'expo-web-browser';
import {
  APP_HOME_PATH,
  publicBookingWebsiteUrl,
  resolveAppDeepLinkPath,
} from '../utils/resolveAppDeepLinkPath';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const websiteUrl = publicBookingWebsiteUrl(path);
    if (websiteUrl) {
      void WebBrowser.openBrowserAsync(websiteUrl);
      // Never return null — on cold start that surfaces grabdocs:/// Unmatched Route.
      return APP_HOME_PATH;
    }
    return resolveAppDeepLinkPath(path);
  } catch {
    return APP_HOME_PATH;
  }
}
