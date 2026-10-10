import { extractMeetingIdFromJoinUrl } from './grabdocsJoinUrl';

export const APP_HOME_PATH = '/(tabs)';

function billingPathFromDeepLink(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let pathname = trimmed;
  let tab: string | null = null;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      const host = url.hostname.replace(/^www\./, '');
      if (host !== 'grabdocs.com' && host !== 'app.grabdocs.com') return null;
      pathname = url.pathname;
      tab = url.searchParams.get('tab');
    } else {
      const q = trimmed.indexOf('?');
      pathname = q >= 0 ? trimmed.slice(0, q) : trimmed;
      if (q >= 0) tab = new URLSearchParams(trimmed.slice(q + 1)).get('tab');
    }
  } catch {
    return null;
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname === '/settings' && tab === 'billing') return '/billing';
  if (pathname === '/pricing' || pathname === '/payment') return '/billing';
  return null;
}

/** In-app route prefixes that Expo Router can open. Anything else falls back to home. */
const KNOWN_APP_PREFIXES = [
  '/(tabs)',
  '/(auth)',
  '/login-success',
  '/login-error',
  '/analytics',
  '/bookmarks',
  '/drafts',
  '/forms',
  '/calendar',
  '/quick-reach',
  '/join-meeting',
  '/upload-links',
  '/intake',
  '/clients',
  '/email-sync',
  '/email-oauth',
  '/signatures',
  '/workspaces',
  '/billing',
  '/scanner',
  '/public-upload',
  '/notifications',
  '/verify-email-change',
  '/secure-message-invite',
  '/workspace-invite',
  '/user-chat',
  '/upload-by-link',
  '/upload-by-link-code',
  '/documents',
  '/calendar-oauth',
] as const;

function isKnownAppPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '') return false;
  return KNOWN_APP_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}?`),
  );
}

function splitPathAndSearch(raw: string): { pathname: string; search: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { pathname: '/', search: '' };

  try {
    if (/^grabdocs:\/\//i.test(trimmed)) {
      const rest = trimmed.replace(/^grabdocs:\/\//i, '').replace(/^\/+/, '');
      if (!rest) return { pathname: '/', search: '' };
      const q = rest.indexOf('?');
      const pathPart = q >= 0 ? rest.slice(0, q) : rest;
      const search = q >= 0 ? rest.slice(q) : '';
      return { pathname: `/${pathPart.replace(/^\/+/, '')}`, search };
    }

    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      return { pathname: url.pathname || '/', search: url.search || '' };
    }
  } catch {
    return { pathname: '/', search: '' };
  }

  const q = trimmed.indexOf('?');
  let pathname = q >= 0 ? trimmed.slice(0, q) : trimmed;
  const search = q >= 0 ? trimmed.slice(q) : '';
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  return { pathname, search };
}

function normalizePathname(pathname: string): string {
  if (!pathname) return '/';
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/**
 * Map incoming App Links / custom-scheme / notification paths to a real Expo route.
 * Unknown or empty paths become home so the Unmatched Route screen never appears.
 */
export function resolveAppDeepLinkPath(raw: string | null | undefined): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed || trimmed === '/' || /^grabdocs:\/+$/i.test(trimmed)) {
    return APP_HOME_PATH;
  }

  const meetingId = extractMeetingIdFromJoinUrl(trimmed);
  if (meetingId) {
    let join = `/join-meeting?meeting_id=${encodeURIComponent(meetingId)}`;
    try {
      const href = trimmed.includes('://') ? trimmed : `https://app.grabdocs.com${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
      const token = new URL(href).searchParams.get('passcode_token')?.trim();
      if (token) join += `&passcode_token=${encodeURIComponent(token)}`;
    } catch {
      const m = trimmed.match(/[?&#]passcode_token=([^&#]+)/i);
      if (m?.[1]) {
        try {
          join += `&passcode_token=${encodeURIComponent(decodeURIComponent(m[1]).trim())}`;
        } catch {
          join += `&passcode_token=${encodeURIComponent(m[1].trim())}`;
        }
      }
    }
    return join;
  }

  const billing = billingPathFromDeepLink(trimmed);
  if (billing) return billing;

  const { pathname: rawPath, search } = splitPathAndSearch(trimmed);
  let pathname = normalizePathname(rawPath);
  let params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);

  // Public booking is website-only; never open an unmatched in-app /book route.
  if (pathname === '/book' || pathname.startsWith('/book/')) {
    return APP_HOME_PATH;
  }

  // Web /meeting without a parseable id (defensive).
  if (pathname === '/meeting' || pathname === '/meet' || pathname.startsWith('/meeting/') || pathname.startsWith('/meet/')) {
    return '/quick-reach/meeting-call';
  }

  // Web → mobile route aliases (backend notification_path / website links).
  if (pathname.startsWith('/calendar/event/')) {
    pathname = pathname.replace('/calendar/event/', '/calendar/');
  }
  if (pathname === '/chat' || pathname.startsWith('/chat/')) {
    const chatId = params.get('chat_id') || params.get('chatId');
    const next = new URLSearchParams();
    if (chatId) next.set('chatId', chatId);
    const workspaceId = params.get('workspace_id') || params.get('workspaceId');
    if (workspaceId) next.set('workspaceId', workspaceId);
    // secure_invite_id is web-only; user-chat loads pending invites on open.
    const qs = next.toString();
    return qs ? `/user-chat?${qs}` : '/user-chat';
  }
  if (pathname === '/documents' || pathname === '/documents/') {
    return '/(tabs)/documents';
  }
  if (pathname === '/files' || pathname.startsWith('/files/')) {
    const tab = params.get('tab');
    if (tab === 'email-sync' || params.has('threadId') || params.has('emailSubTab')) {
      const next = new URLSearchParams();
      const threadId = params.get('threadId') || params.get('thread_id');
      const workspaceId = params.get('workspaceId') || params.get('workspace_id');
      if (threadId) next.set('threadId', threadId);
      if (workspaceId) next.set('workspaceId', workspaceId);
      if (params.get('compose') === '1') next.set('compose', '1');
      const qs = next.toString();
      return qs ? `/email-sync?${qs}` : '/email-sync';
    }
    return '/(tabs)/documents';
  }
  if (pathname === '/video-meeting' || pathname.startsWith('/video-meeting/')) {
    return '/quick-reach/meeting-call';
  }
  if (pathname === '/agentic' || pathname.startsWith('/agentic/')) {
    return APP_HOME_PATH;
  }
  if (pathname === '/workspaces' || pathname === 'workspaces') {
    pathname = '/workspaces';
  }

  const qs = params.toString();
  const candidate = qs ? `${pathname}?${qs}` : pathname;
  if (isKnownAppPath(pathname)) return candidate;

  // Unknown https or relative paths → home (never Unmatched Route).
  return APP_HOME_PATH;
}

/** True when this path should open in an external browser sheet (public booking). */
export function isPublicBookingWebsitePath(raw: string | null | undefined): boolean {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return false;
  try {
    if (/^grabdocs:\/\//i.test(trimmed)) {
      const rest = trimmed.replace(/^grabdocs:\/\//i, '').replace(/^\/+/, '');
      return rest === 'book' || rest.startsWith('book/');
    }
    const href = trimmed.includes('://') ? trimmed : `https://app.grabdocs.com${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
    const url = new URL(href);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'app.grabdocs.com' && host !== 'grabdocs.com') return false;
    return url.pathname === '/book' || url.pathname.startsWith('/book/');
  } catch {
    return false;
  }
}

export function publicBookingWebsiteUrl(raw: string): string | null {
  if (!isPublicBookingWebsitePath(raw)) return null;
  try {
    if (/^grabdocs:\/\//i.test(raw)) {
      const rest = raw.replace(/^grabdocs:\/\//i, '').replace(/^\/+/, '');
      return `https://app.grabdocs.com/${rest}`;
    }
    const href = raw.includes('://') ? raw : `https://app.grabdocs.com${raw.startsWith('/') ? '' : '/'}${raw}`;
    const url = new URL(href);
    return `https://app.grabdocs.com${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
