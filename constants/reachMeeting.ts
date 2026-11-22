/** AsyncStorage key: set while user is connected to a Reach (HMS) call; cleared on leave/end. */
export const REACH_CURRENT_MEETING_KEY = 'reach_current_meeting_id';

/** Local sticky notification id for minimized / backgrounded Reach calls ("Tap to return"). */
export const REACH_MEETING_NOTIFICATION_ID = 'grabdocs_meeting_minimized';

/** DeviceEventEmitter: emitted by patched Room Kit ON_JOIN (user tapped Join and is in the room). */
export const HMS_ROOM_JOINED_EVENT = 'grabdocs:hms_room_joined';

/**
 * DeviceEventEmitter: list asks the mounted HMS screen to leave without returning first.
 * Payload: `{ meetingId: string }`.
 */
export const LEAVE_REACH_MEETING_EVENT = 'grabdocs:leave_reach_meeting';

/** AsyncStorage key: this device's guest id for a meeting, so a signed-out rejoin reuses its row. */
export function reachGuestIdStorageKey(meetingId: unknown): string {
  return `reach_guest_id:${canonicalizeReachMeetingId(meetingId)}`;
}

/** In-memory: HMS meeting screen is mounted and the user is in that call. */
let liveReachMeetingId = '';
let liveReachMeetingRoute = '';
let liveReachMeetingMounted = false;
let skipHmsLeaveUntil = 0;

function liveRouteForId(id: string): string {
  return liveReachMeetingRoute || `/quick-reach/hms-meeting-interface?meetingId=${encodeURIComponent(id)}`;
}

/** Call when GrabDocs presence is confirmed so a second tap can return to this screen. */
export function setLiveReachMeeting(meetingId: unknown, route: string): void {
  const id = canonicalizeReachMeetingId(meetingId);
  if (!id) return;
  liveReachMeetingId = id;
  liveReachMeetingRoute = (route || '').trim() || liveRouteForId(id);
  liveReachMeetingMounted = true;
}

export function setLiveReachMeetingMounted(mounted: boolean): void {
  liveReachMeetingMounted = mounted;
}

export function clearLiveReachMeeting(meetingId?: unknown): void {
  if (meetingId != null && canonicalizeReachMeetingId(meetingId) !== liveReachMeetingId) return;
  liveReachMeetingId = '';
  liveReachMeetingRoute = '';
  liveReachMeetingMounted = false;
  skipHmsLeaveUntil = 0;
}

/** True while the HMS screen for this meeting is actually showing. */
export function isLiveReachMeetingMounted(meetingId: unknown): boolean {
  const id = canonicalizeReachMeetingId(meetingId);
  return Boolean(id && liveReachMeetingMounted && id === liveReachMeetingId);
}

/** Current live Reach meeting id while HMS is mounted (including minimized). */
export function getLiveReachMeetingId(): string {
  return liveReachMeetingMounted ? liveReachMeetingId : '';
}

/**
 * True when this device is currently in the given meeting (HMS mounted / minimized).
 * Distinct from meeting list status === 'active' (room is live for anyone).
 */
export function isUserInReachMeeting(meetingId: unknown): boolean {
  return isLiveReachMeetingMounted(meetingId);
}

/**
 * Route to stay on the live call. Also marks the current HMS instance to skip leave if
 * Expo remounts anyway (so the shared guest row is not deleted).
 *
 * Prefer router.navigate(this) so React Navigation pops back to the mounted screen
 * instead of pushing a second HMSPrebuilt (which would leave/rejoin).
 */
export function resumeLiveReachMeetingRoute(meetingId: unknown): string | null {
  if (!isLiveReachMeetingMounted(meetingId)) return null;
  skipHmsLeaveUntil = Date.now() + 8000;
  return liveRouteForId(liveReachMeetingId);
}

/** True when any Reach HMS screen is still mounted (including minimized under the stack). */
export function hasLiveReachMeetingMounted(): boolean {
  return Boolean(liveReachMeetingMounted && liveReachMeetingId);
}

export function shouldSkipHmsLeave(): boolean {
  return Date.now() < skipHmsLeaveUntil;
}

/**
 * Normalize join links / room codes so the same meeting merges in lists and matches storage.
 * - Composite "40740018:..." uses the numeric GrabDocs meeting id.
 * - Base64 payloads that decode to that shape (common in shared links) map to the same id.
 */
export function canonicalizeReachMeetingId(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return s;

  const plainComposite = s.match(/^(\d{1,20})(?::|$)/);
  if (plainComposite) return plainComposite[1];

  if (/^[A-Za-z0-9+/=_-]+$/.test(s) && s.length >= 8) {
    try {
      const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
      const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      const decoded =
        typeof atob === 'function' ? atob(normalized + pad) : '';
      const m = decoded.match(/^(\d{1,20})(?::|$)/);
      if (m) return m[1];
    } catch {
      // ignore invalid base64
    }
  }

  return s;
}
