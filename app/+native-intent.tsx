/**
 * Public booking cancel/reschedule are browser-only. If a /book URL reaches the
 * app (custom scheme or misrouted universal link), open it in a browser sheet
 * instead of an in-app route (avoids App Link loops from Linking.openURL).
 */
import * as WebBrowser from 'expo-web-browser';

function bookingWebsiteUrl(path: string): string | null {
  try {
    if (/^grabdocs:\/\//i.test(path)) {
      const rest = path.replace(/^grabdocs:\/\//i, '').replace(/^\/+/, '');
      if (rest !== 'book' && !rest.startsWith('book/')) return null;
      return `https://app.grabdocs.com/${rest}`;
    }

    const href = path.includes('://') ? path : `https://app.grabdocs.com${path.startsWith('/') ? '' : '/'}${path}`;
    const url = new URL(href);
    const host = url.hostname.toLowerCase();
    const isGrabDocs =
      host === 'app.grabdocs.com' || host === 'grabdocs.com' || host === 'www.grabdocs.com';
    if (!isGrabDocs) return null;
    if (url.pathname !== '/book' && !url.pathname.startsWith('/book/')) return null;
    return `https://app.grabdocs.com${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    const websiteUrl = bookingWebsiteUrl(path);
    if (!websiteUrl) return path;
    void WebBrowser.openBrowserAsync(websiteUrl);
    return null;
  } catch {
    return path;
  }
}
