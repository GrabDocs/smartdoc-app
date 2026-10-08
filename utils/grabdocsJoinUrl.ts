import type { Router } from 'expo-router';
import { router as expoRouter } from 'expo-router';

const GRABDOCS_JOIN_HOST_RE = /(?:^|\.)grabdocs\.com$/i;

/**
 * True when the URL is a GrabDocs Reach join / meeting link (must stay in-app).
 */
export function isGrabDocsReachJoinUrl(raw: string | undefined | null): boolean {
  const url = String(raw ?? '').trim();
  if (!url) return false;
  if (/join-meeting/i.test(url)) return true;
  if (/\/meet\/[^/?#]+/i.test(url) || /\/meeting\/[^/?#]+/i.test(url)) {
    try {
      const u = new URL(url.includes('://') ? url : `https://${url}`);
      return GRABDOCS_JOIN_HOST_RE.test(u.hostname);
    } catch {
      return /grabdocs\.com/i.test(url);
    }
  }
  return false;
}

/**
 * Extract Reach meeting_id from common GrabDocs / legacy URL shapes:
 * - .../join-meeting?meeting_id=ID
 * - .../join-meeting/ID
 * - .../meet/ID
 * - .../meeting/ID
 */
export function extractMeetingIdFromJoinUrl(meetingUrl: string | undefined): string | null {
  const url = meetingUrl?.trim();
  if (!url) return null;

  const q = url.match(/[?&#]meeting_id=([^&#]+)/i);
  if (q?.[1]) {
    try {
      return decodeURIComponent(q[1]).trim() || null;
    } catch {
      return q[1].trim() || null;
    }
  }
  const q2 = url.match(/[?&#]meetingId=([^&#]+)/i);
  if (q2?.[1]) {
    try {
      return decodeURIComponent(q2[1]).trim() || null;
    } catch {
      return q2[1].trim() || null;
    }
  }

  const path =
    url.match(/\/join-meeting\/([^/?#]+)/i) ||
    url.match(/\/meet\/([^/?#]+)/i) ||
    url.match(/\/meeting\/([^/?#]+)/i);
  if (path?.[1]) {
    try {
      return decodeURIComponent(path[1]).trim() || null;
    } catch {
      return path[1].trim() || null;
    }
  }

  return null;
}

/**
 * Navigate in-app to join a GrabDocs Reach meeting. Returns true if handled.
 */
export function navigateGrabDocsJoinFromUrl(
  rawUrl: string,
  options?: { router?: Router; returnTo?: string }
): boolean {
  const mid = extractMeetingIdFromJoinUrl(rawUrl);
  if (!mid) return false;
  const r = options?.router ?? expoRouter;
  const params: Record<string, string> = { meeting_id: mid };
  const returnTo = options?.returnTo?.trim();
  if (returnTo) params.returnTo = returnTo;
  try {
    const href = rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`;
    const token = new URL(href).searchParams.get('passcode_token')?.trim();
    if (token) params.passcode_token = token;
  } catch {
    const m = rawUrl.match(/[?&#]passcode_token=([^&#]+)/i);
    if (m?.[1]) {
      try {
        params.passcode_token = decodeURIComponent(m[1]).trim();
      } catch {
        params.passcode_token = m[1].trim();
      }
    }
  }
  r.push({ pathname: '/join-meeting', params } as any);
  return true;
}
