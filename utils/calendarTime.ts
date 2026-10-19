/**
 * Calendar date helpers aligned with web calendar (naive ISO treated as UTC when no offset).
 */

/** Parse API datetime as a UTC instant, then use `toLocaleString` / format helpers for phone-local display. */
export function parseUTC(iso: string | number | null | undefined): Date {
  if (iso == null || iso === '') return new Date();
  if (typeof iso === 'number') {
    const n = iso;
    return new Date(n < 1e12 ? n * 1000 : n);
  }

  let s = String(iso).trim();

  // Plain date → midnight UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00Z`);
  }

  // SQL / Rails style "YYYY-MM-DD HH:mm:ss" or "... HH:mm:ss.ssssss"
  if (/^\d{4}-\d{2}-\d{2}\s+\d/.test(s)) {
    s = s.replace(/\s+/, 'T');
  }

  const hasOffset = /Z|[+-]\d{2}:?\d{2}$/.test(s);
  const withUtc = hasOffset ? s : `${s}Z`;
  const d = new Date(withUtc);
  if (!Number.isNaN(d.getTime())) return d;

  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
}

const START_SORT_MISSING = Number.NEGATIVE_INFINITY;
const START_SORT_MISSING_LAST_ASC = Number.POSITIVE_INFINITY;

/** Start-time ms for sorting; missing start sorts last when using descending order. */
export function calendarEventStartMs(ev: { start_time?: string | null }): number {
  const raw = ev.start_time;
  if (raw == null || String(raw).trim() === '') return START_SORT_MISSING;
  const t = parseUTC(raw).getTime();
  return Number.isNaN(t) ? START_SORT_MISSING : t;
}

/** Missing / invalid start sorts last when ordering ascending (earliest first). */
export function calendarEventStartMsAsc(ev: { start_time?: string | null }): number {
  const raw = ev.start_time;
  if (raw == null || String(raw).trim() === '') return START_SORT_MISSING_LAST_ASC;
  const t = parseUTC(raw).getTime();
  return Number.isNaN(t) ? START_SORT_MISSING_LAST_ASC : t;
}

/** Earliest start first (web list: All / Upcoming / Today). */
export function sortCalendarEventsByStartAsc<T extends { start_time?: string | null }>(events: T[]): T[] {
  return [...events].sort((a, b) => calendarEventStartMsAsc(a) - calendarEventStartMsAsc(b));
}

/** Latest start time first (reverse chronological). Events without start_time sort last. */
export function sortCalendarEventsByStartDesc<T extends { start_time?: string | null }>(events: T[]): T[] {
  return [...events].sort((a, b) => calendarEventStartMs(b) - calendarEventStartMs(a));
}

/** `Date` → device timezone using explicit IANA zone (helps RN consistency vs naive UTC strings). */
export function formatInstantInDeviceTimezone(d: Date, options?: Intl.DateTimeFormatOptions): string {
  if (Number.isNaN(d.getTime())) return '';
  const tz = getDeviceIanaTimezone();
  return d.toLocaleString(undefined, { timeZone: tz, ...options });
}

/** UTC ISO / naive UTC string from API → user-visible string on device clock. */
export function formatUtcIsoForDevice(iso: string | null | undefined, options?: Intl.DateTimeFormatOptions): string {
  if (!iso) return '';
  return formatInstantInDeviceTimezone(parseUTC(iso), options);
}

export function toLocalDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function toLocalTimeHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** e.g. "5:00 PM" for event form display */
export function formatLocalTime12h(d: Date): string {
  const h24 = d.getHours();
  const minute = d.getMinutes();
  const period = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${period}`;
}

/**
 * Parse "h:mm AM/PM" or 24-hour "HH:mm" / "H:mm" from calendar text fields.
 */
export function parseCalendarTimeToHourMinute(timeStr: string): { hour: number; minute: number } | null {
  const s = timeStr.trim().replace(/\u202f/g, ' ');
  if (!s) return null;

  const twelve = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (twelve) {
    let h = parseInt(twelve[1], 10);
    const minute = parseInt(twelve[2], 10);
    const ap = twelve[3].toUpperCase();
    if (Number.isNaN(h) || Number.isNaN(minute) || h < 1 || h > 12 || minute > 59) return null;
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return { hour: h, minute };
  }

  const twenty = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (twenty) {
    const h = parseInt(twenty[1], 10);
    const minute = parseInt(twenty[2], 10);
    if (Number.isNaN(h) || Number.isNaN(minute) || h > 23 || minute > 59) return null;
    return { hour: h, minute };
  }

  return null;
}

/** Local Date for pickers from separate date + time strings */
export function combineLocalDateAndTimeStrings(dateString: string, timeString: string): Date {
  const [year, month, day] = dateString.split('-').map(Number);
  const hm = parseCalendarTimeToHourMinute(timeString);
  if (!year || !hm) return new Date();
  return new Date(year, month - 1, day, hm.hour, hm.minute, 0, 0);
}

/**
 * Convert calendar date + wall-clock time (in IANA `timezone`) to a UTC instant.
 * Mobile picks date/time in the device timezone — when `timezone` matches the device zone,
 * use the JS local Date constructor (correct). The previous UTC+offset heuristic was wrong and
 * could send times hours off (e.g. "scheduled time must be in the future" when 7 PM was valid).
 */
export function convertLocalTimeToUTC(dateString: string, timeString: string, timezone: string): Date {
  const [year, month, day] = dateString.split('-').map(Number);
  const hm = parseCalendarTimeToHourMinute(timeString);
  if (!year || !hm) throw new Error('Invalid date or time');
  const { hour, minute } = hm;

  const deviceTz = getDeviceIanaTimezone();
  if (!timezone || timezone === deviceTz) {
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  return wallClockInTimeZoneToUtc(year, month, day, hour, minute, timezone);
}

/** When wall time is not in the device zone: find UTC ms where Intl shows that wall time in `timeZone`. */
function wallClockInTimeZoneToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });

  const read = (ms: number) => {
    const parts = fmt.formatToParts(new Date(ms));
    const g = (ty: Intl.DateTimeFormatPartTypes) =>
      parseInt(parts.find((p) => p.type === ty)?.value ?? 'NaN', 10);
    return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour'), mi: g('minute') };
  };

  const matches = (ms: number) => {
    const w = read(ms);
    return w.y === year && w.mo === month && w.d === day && w.h === hour && w.mi === minute;
  };

  const center = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let deltaMin = -96 * 60; deltaMin <= 96 * 60; deltaMin++) {
    const ms = center + deltaMin * 60 * 1000;
    if (matches(ms)) return new Date(ms);
  }

  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

export function getDeviceIanaTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Web list fetch: past 30 days through next 90 days. */
export function defaultCalendarListWindow(): { start: Date; end: Date } {
  const now = new Date();
  const past = new Date(now);
  past.setDate(past.getDate() - 30);
  const future = new Date(now);
  future.setDate(future.getDate() + 90);
  return { start: past, end: future };
}

export type ListTabFilter = 'all' | 'upcoming' | 'today' | 'past';

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Client tabs after fetch — match web `frontend/src/pages/calendar/index.tsx`:
 * upcoming: start >= now; today: local calendar day on start [today 00:00, tomorrow 00:00); past: start < now.
 */
export function filterEventsByTab<T extends { start_time?: string; end_time?: string; status?: string }>(
  events: T[],
  tab: ListTabFilter
): T[] {
  const now = new Date();
  const today = startOfLocalDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return events.filter((e) => {
    const start = e.start_time ? parseUTC(e.start_time) : new Date(0);

    switch (tab) {
      case 'all':
        return true;
      case 'upcoming':
        return start.getTime() >= now.getTime();
      case 'today':
        return start.getTime() >= today.getTime() && start.getTime() < tomorrow.getTime();
      case 'past':
        return start.getTime() < now.getTime();
      default:
        return true;
    }
  });
}

/** Stat tiles that match `filterEventsByTab` (local day), not server UTC-day stats. */
export function computeListTabStats<T extends { start_time?: string; end_time?: string }>(
  events: T[]
): {
  total_events: number;
  upcoming_events: number;
  events_today: number;
  past_events: number;
} {
  return {
    total_events: events.length,
    upcoming_events: filterEventsByTab(events, 'upcoming').length,
    events_today: filterEventsByTab(events, 'today').length,
    past_events: filterEventsByTab(events, 'past').length,
  };
}

/**
 * Lightweight client substring search for hybrid list UX (baseline window + refinement from server).
 */
export function calendarEventMatchesLocalSearch(ev: Record<string, unknown>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const chunks: string[] = [];
  for (const key of ['title', 'description', 'notes', 'location'] as const) {
    const v = ev[key];
    if (v != null && v !== '') chunks.push(String(v));
  }
  const org = ev.organizer;
  if (org && typeof org === 'object' && !Array.isArray(org)) {
    const o = org as Record<string, unknown>;
    if (o.name != null) chunks.push(String(o.name));
    if (o.email != null) chunks.push(String(o.email));
  }
  const parts = ev.participants;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      const row = p as Record<string, unknown>;
      if (row.email != null) chunks.push(String(row.email));
      if (row.name != null) chunks.push(String(row.name));
    }
  }
  return chunks.join('\n').toLowerCase().includes(q);
}

/** True when event has a GrabDocs Reach / video meeting (video_call_id, join URL, or Reach location tag). */
export function eventHasReachMeeting(ev: {
  meeting_url?: string | null;
  video_call_id?: unknown;
  location?: string | null;
}): boolean {
  const vid = ev.video_call_id;
  if (vid != null && String(vid).trim() !== '') return true;
  const url = String(ev.meeting_url ?? '').trim();
  if (/join-meeting|\/meet\//i.test(url)) return true;
  const loc = String(ev.location ?? '');
  if (loc.includes('Reach')) return true;
  return false;
}

/** YYYY-MM-DD from ISO (avoids timezone day-shift for all-day events). */
export function isoDatePart(iso: string | null | undefined): string {
  const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

export function addCalendarDays(yyyyMmDd: string, days: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  if (!y || !m || !d) return yyyyMmDd;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toLocalDateString(dt);
}

export function inclusiveToExclusiveEnd(inclusiveEnd: string): string {
  return addCalendarDays(inclusiveEnd, 1);
}

export function exclusiveToInclusiveEnd(startDate: string, exclusiveEnd: string): string {
  if (!exclusiveEnd) return startDate;
  const inclusive = addCalendarDays(exclusiveEnd, -1);
  return inclusive < startDate ? startDate : inclusive;
}

/** Display start time like list/calendar rows: medium date + short time on device clock. */
export function formatEventWhen(ev: { start_time?: string | null; end_time?: string | null; all_day?: boolean }): string {
  try {
    if (!ev.start_time) return '';
    if (ev.all_day) {
      const start = isoDatePart(ev.start_time);
      if (!start) return 'All day';
      const endInclusive = exclusiveToInclusiveEnd(start, isoDatePart(ev.end_time || ''));
      const startLabel = new Date(
        Number(start.slice(0, 4)),
        Number(start.slice(5, 7)) - 1,
        Number(start.slice(8, 10))
      ).toLocaleDateString(undefined, { dateStyle: 'medium' });
      if (endInclusive && endInclusive !== start) {
        const endLabel = new Date(
          Number(endInclusive.slice(0, 4)),
          Number(endInclusive.slice(5, 7)) - 1,
          Number(endInclusive.slice(8, 10))
        ).toLocaleDateString(undefined, { dateStyle: 'medium' });
        return `${startLabel} – ${endLabel} · All day`;
      }
      return `${startLabel} · All day`;
    }
    return formatUtcIsoForDevice(ev.start_time, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

/** Non-empty location text for UI; omit blank and Reach-only placeholders. */
export function calendarDisplayLocation(location: unknown): string | null {
  const s = String(location ?? '').trim();
  if (!s) return null;
  if (s.toLowerCase() === 'reach') return null;
  return s;
}
