import { API_BASE_URL } from '../constants/Config';
import { apiClient } from './api';

const client = () => apiClient.client;

export type CalendarParticipantInput = { email: string; name?: string; type?: string };

export type CalendarEventOrigin = 'created' | 'participant_copy' | 'external_sync';

export type CalendarEventPermissions = {
  is_organizer?: boolean;
  can_remove_from_calendar?: boolean;
};

/** Event object from list/detail/create/update (fields depend on endpoint). */
export type CalendarEvent = {
  id: number;
  title?: string;
  description?: string;
  notes?: string | null;
  start_time?: string;
  end_time?: string;
  timezone?: string;
  location?: string;
  meeting_url?: string;
  video_call_id?: number | string | null;
  status?: string;
  event_type?: string;
  /** Whose calendar copy this row is on — not organizer authority. */
  user_id?: number;
  source_event_id?: number | null;
  event_origin?: CalendarEventOrigin | string;
  organizer?: { id?: number; name?: string; email?: string };
  permissions?: CalendarEventPermissions;
  viewer_identity_emails?: string[];
  participants?: {
    id?: number;
    email?: string;
    name?: string;
    status?: string;
    is_organizer?: boolean;
    type?: string;
  }[];
  linked_category_id?: number | null;
  linked_category_record_id?: number | null;
  [key: string]: unknown;
};

function _normEmail(raw?: string | null): string {
  return (raw || '').trim().toLowerCase();
}

export function calendarIdentityEmails(
  user?: { email?: string | null } | null,
  connections?: Array<{ external_user_email?: string | null }> | null,
  extra?: Array<string | null | undefined> | null
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [user?.email, ...(connections || []).map((c) => c.external_user_email), ...(extra || [])]) {
    const email = _normEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** Prefer API `permissions: true`; stale `false` still allows mailbox-identity fallback. */
export function calendarEventIsOrganizer(
  event: CalendarEvent | null | undefined,
  user: { id?: number | null; email?: string | null } | null | undefined,
  identityEmails?: Array<string | null | undefined> | null
): boolean {
  if (!event || !user) return false;
  if (event.permissions?.is_organizer === true) return true;
  const userId = user.id != null ? Number(user.id) : null;
  if (userId != null && Number(event.organizer?.id) === userId) return true;
  const identities = new Set<string>(
    calendarIdentityEmails(user, null, [...(identityEmails || []), ...(event.viewer_identity_emails || [])])
  );
  const organizerEmail = _normEmail(event.organizer?.email);
  if (organizerEmail && identities.has(organizerEmail)) return true;
  if (!identities.size || !Array.isArray(event.participants)) return false;
  return event.participants.some(
    (p) => !!p.is_organizer && identities.has(_normEmail(p.email))
  );
}

export function calendarEventCanRemoveFromCalendar(
  event: CalendarEvent | null | undefined,
  user: { id?: number | null; email?: string | null } | null | undefined,
  opts?: { canManageEvent?: boolean }
): boolean {
  if (!event || !user) return false;
  if (opts?.canManageEvent) return false;
  if (typeof event.permissions?.can_remove_from_calendar === 'boolean') {
    return event.permissions.can_remove_from_calendar;
  }
  if (calendarEventIsOrganizer(event, user)) return false;
  const email = (user.email || '').trim().toLowerCase();
  if (!email || !Array.isArray(event.participants)) return false;
  return event.participants.some((p) => (p.email || '').trim().toLowerCase() === email);
}

export type CalendarStats = Record<string, number>;

export type CalendarProvider = 'google' | 'microsoft';

export interface CalendarConnection {
  id: number;
  provider: CalendarProvider | string;
  provider_display_name: string;
  status: string;
  sync_enabled: boolean;
  is_default?: boolean;
  last_sync_at?: string;
  external_user_email?: string | null;
}

export type CalendarSyncResult = {
  success?: boolean;
  error?: string;
  message?: string;
  results?: Array<{
    provider?: string;
    success?: boolean;
    error?: string;
    pull_result?: { created?: number; updated?: number };
  }>;
};

export interface CalendarListParams {
  start_date?: string;
  end_date?: string;
  search?: string;
  event_type?: 'personal' | 'company';
  view_user_id?: number;
  workspace_id?: number;
  status?: string;
  include_cancelled?: boolean;
}

export async function calendarListEvents(
  params: CalendarListParams,
  axiosConfig?: { signal?: AbortSignal }
): Promise<CalendarEvent[]> {
  const { data } = await client().get<{ events?: CalendarEvent[] }>('/api/v1/calendar/events', {
    params,
    ...axiosConfig,
  });
  return data?.events ?? [];
}

export async function calendarGetStats(
  params?: {
    view_user_id?: number;
    start_date?: string;
    end_date?: string;
    event_type?: 'personal' | 'company';
  },
  axiosConfig?: { signal?: AbortSignal }
): Promise<CalendarStats> {
  const { data } = await client().get<{ stats?: CalendarStats }>('/api/v1/calendar/stats', {
    params,
    ...axiosConfig,
  });
  return data?.stats ?? {};
}

export async function calendarGetEvent(id: number): Promise<CalendarEvent> {
  const { data } = await client().get<{ event: CalendarEvent }>(`/api/v1/calendar/events/${id}`);
  return data.event;
}

export async function calendarCreateEvent(body: Record<string, unknown>): Promise<CalendarEvent> {
  const { data } = await client().post<{ event: CalendarEvent; idempotent_replay?: boolean }>(
    '/api/v1/calendar/events',
    body
  );
  return data.event;
}

export async function calendarUpdateEvent(id: number, body: Record<string, unknown>): Promise<CalendarEvent> {
  const { data } = await client().put<{ event: CalendarEvent }>(`/api/v1/calendar/events/${id}`, body);
  return data.event;
}

/** Organizer cancel — soft-deletes for everyone and emails participants. */
export async function calendarDeleteEvent(id: number) {
  await client().delete(`/api/v1/calendar/events/${id}`);
}

/** Participant-only — soft-deletes this user's calendar copy; no emails. */
export async function calendarRemoveFromCalendar(id: number) {
  await client().post(`/api/v1/calendar/events/${id}/remove-from-calendar`);
}

export async function calendarRsvp(eventId: number, status: 'accepted' | 'declined' | 'tentative', response_comment?: string) {
  await client().post(`/api/v1/calendar/events/${eventId}/rsvp`, { status, response_comment: response_comment ?? '' });
}

export async function calendarRsvpFromEmail(eventId: number, token: string, status: 'accepted' | 'declined') {
  const { data } = await client().post(`/api/v1/calendar/events/${eventId}/rsvp-from-email`, { token, status });
  return data;
}

export async function calendarResendInvite(eventId: number, participantId: number) {
  await client().post(`/api/v1/calendar/events/${eventId}/participants/${participantId}/resend`);
}

export async function calendarSearchCompanyMembers(q: string, limit = 10) {
  const { data } = await client().get<{ success?: boolean; members?: any[] }>('/api/v1/calendar/company-members/search', {
    params: { q, limit },
  });
  return data?.members ?? [];
}

export async function calendarCategoriesWithRecords() {
  const { data } = await client().get<{ success?: boolean; categories?: any[] }>('/api/v1/calendar/categories-with-records');
  return data?.categories ?? [];
}

export async function calendarConnections(): Promise<CalendarConnection[]> {
  const { data } = await client().get<{
    connections?: CalendarConnection[];
    default_connection_id?: number;
  }>('/api/v1/calendar/connections');
  return data?.connections ?? [];
}

export async function calendarSetDefaultConnection(connectionId: number) {
  const { data } = await client().post<{ message?: string }>(
    `/api/v1/calendar/connections/${connectionId}/default`
  );
  return data;
}

export async function calendarDeleteConnection(connectionId: number) {
  await client().delete(`/api/v1/calendar/connections/${connectionId}`);
}

export async function calendarResetConnection(connectionId: number) {
  await client().post(`/api/v1/calendar/connections/${connectionId}/reset`);
}

/** Runs sync for active Google + Microsoft connections (same as web). */
export async function calendarSyncGoogle(): Promise<CalendarSyncResult> {
  const { data } = await client().post<CalendarSyncResult>('/api/v1/calendar/google/sync');
  return data ?? {};
}

/** Human-readable sync summary (mirrors web runExternalCalendarSync toasts). */
export function formatCalendarSyncMessage(data: CalendarSyncResult): string {
  if (data.success === false) {
    return data.error || 'Sync failed';
  }
  const results = data.results ?? [];
  const failed = results.filter((r) => r && r.success === false);
  if (failed.length) {
    return failed.map((f) => f.error || 'Unknown error').join('; ');
  }
  if (data.message && String(data.message).includes('No active calendar')) {
    return 'Connect a calendar first, then sync.';
  }
  const parts: string[] = [];
  for (const r of results) {
    const pr = r.pull_result;
    if (pr && typeof pr.created === 'number') {
      parts.push(`${pr.created} imported, ${pr.updated ?? 0} updated (${r.provider || 'calendar'})`);
    }
  }
  if (parts.length) return `Synced: ${parts.join(' · ')}`;
  return 'Calendar synced successfully';
}

/**
 * Matches web: GET connections → POST …/reset for paused rows → POST google/sync.
 * Does not run OAuth; clears DB flags so sync can retry token refresh.
 */
export async function calendarSyncGoogleWithStaleConnectionRecovery(opts?: {
  silent?: boolean;
}): Promise<CalendarSyncResult> {
  try {
    const conns = await calendarConnections();
    for (const c of conns) {
      const id = Number(c.id);
      if (!Number.isFinite(id)) continue;
      const status = String(c.status ?? '').toLowerCase();
      if (status !== 'active' || !c.sync_enabled) {
        try {
          await calendarResetConnection(id);
        } catch (resetErr: unknown) {
          const msg =
            (resetErr as { response?: { data?: { error?: string } } })?.response?.data?.error ||
            'Could not resume calendar connection';
          if (!opts?.silent) throw new Error(msg);
        }
      }
    }
  } catch (e) {
    if (!opts?.silent) throw e;
  }
  return calendarSyncGoogle();
}

async function calendarProviderConnectUrl(provider: CalendarProvider): Promise<string> {
  const { data } = await client().get<{ auth_url?: string }>(`/api/v1/calendar/${provider}/connect`, {
    params: { mobile: '1' },
    maxRedirects: 0,
    validateStatus: (s) => s < 400,
  });
  const url = data?.auth_url;
  if (!url || typeof url !== 'string') {
    const label = provider === 'google' ? 'Google' : 'Microsoft';
    throw new Error(`Backend did not return a ${label} auth URL. Restart the backend server and try again.`);
  }
  return url;
}

export async function calendarGoogleConnectUrl(): Promise<string> {
  return calendarProviderConnectUrl('google');
}

export async function calendarMicrosoftConnectUrl(): Promise<string> {
  return calendarProviderConnectUrl('microsoft');
}

export async function calendarGoogleCalendars() {
  const { data } = await client().get('/api/v1/calendar/google/calendars');
  return data;
}

export async function calendarMicrosoftCalendars() {
  const { data } = await client().get('/api/v1/calendar/microsoft/calendars');
  return data;
}

export async function calendarAvailabilityCheck(body: Record<string, unknown>) {
  const { data } = await client().post('/api/v1/calendar/availability/check', body);
  return data;
}

export async function calendarAvailabilitySuggest(body: Record<string, unknown>) {
  const { data } = await client().post('/api/v1/calendar/availability/suggest', body);
  return data;
}

export function calendarIcsUrl(token: string) {
  return `${API_BASE_URL.replace(/\/$/, '')}/api/v1/calendar/ics/${encodeURIComponent(token)}`;
}

export async function scheduleReachMeeting(body: Record<string, unknown>) {
  const { data } = await client().post('/api/v1/video/room/schedule', body);
  return data;
}

export async function calendarEventMeeting(eventId: number) {
  const { data } = await client().get(`/api/v1/calendar/events/${eventId}/meeting`);
  return data;
}

export async function calendarMeetingAssets(eventId: number) {
  const { data } = await client().get(`/api/v1/calendar/events/${eventId}/meeting/assets`);
  return data;
}

export async function calendarAssetContent(eventId: number, assetType: 'transcript' | 'summary' | 'chat', url: string) {
  const { data } = await client().get(`/api/v1/calendar/events/${eventId}/meeting/asset-content`, {
    params: { asset_type: assetType, url },
  });
  return data;
}

export async function calendarAssetsMetadata(eventIds: number[], start_date?: string, end_date?: string) {
  const params: Record<string, string> =
    eventIds.length > 0
      ? { event_ids: eventIds.join(',') }
      : {};
  if (start_date) params.start_date = start_date;
  if (end_date) params.end_date = end_date;
  const { data } = await client().get('/api/v1/calendar/events/assets-metadata', { params });
  return data;
}

// —— Notes (notebook on event) ——

export type CalendarNotebookNote = {
  id: number;
  title?: string;
  content?: string;
  user_id?: number;
  [key: string]: unknown;
};

export async function notesForCalendarEvent(eventId: number): Promise<CalendarNotebookNote[]> {
  const { data } = await client().get<{ notes?: CalendarNotebookNote[] }>(`/api/v1/notes/source/calendar_event/${eventId}`);
  return data?.notes ?? [];
}

export async function noteCreate(body: {
  source_type: 'calendar_event';
  source_id: number;
  title: string;
  content: string;
  workspace_id?: number;
}): Promise<CalendarNotebookNote | undefined> {
  const { data } = await client().post<{ note?: CalendarNotebookNote }>('/api/v1/notes', body);
  return data?.note;
}

export async function noteUpdate(
  id: number,
  body: { title?: string; content?: string }
): Promise<CalendarNotebookNote | undefined> {
  const { data } = await client().put<{ note?: CalendarNotebookNote }>(`/api/v1/notes/${id}`, body);
  return data?.note;
}

export async function noteDelete(id: number) {
  await client().delete(`/api/v1/notes/${id}`);
}
