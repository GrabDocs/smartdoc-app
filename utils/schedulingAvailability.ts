export type Interval = { start: string; end: string };
export type Hours = Record<string, Interval[]>;
export type DateHours = Record<string, Interval[]>;
export type AvailabilityMode = 'weekly' | 'specific_dates' | 'weekly_with_overrides';
export type AvailabilityConflict = {
  code: string;
  message: string;
  fields?: string[];
  dates?: string[];
  details?: string[];
  whole_days?: string[];
  booking_window_locked?: boolean;
  suggested_booking_window_days?: number;
  blocking?: boolean;
};

export type AvailabilityState = {
  mode: AvailabilityMode;
  weeklyHours: Hours;
  dateHours: DateHours;
  periodStart: string;
  periodEnd: string;
};

export function parseIsoDateParts(value: string): { y: number; m: number; d: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

export function hostTodayIso(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function daysBetweenIso(startIso: string, endIso: string): number {
  const a = parseIsoDateParts(startIso);
  const b = parseIsoDateParts(endIso);
  if (!a || !b) return 0;
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.round(ms / 86400000);
}

export function requiredBookingWindowDays(todayIso: string, targetIso: string): number {
  const delta = daysBetweenIso(todayIso, targetIso);
  if (delta < 0) return 1;
  return Math.max(1, Math.min(365, delta + 1));
}

export function openDateKeys(dateHours: DateHours): string[] {
  return Object.entries(dateHours)
    .filter(([, rows]) => Array.isArray(rows) && rows.length > 0)
    .map(([key]) => key)
    .filter((key) => !!parseIsoDateParts(key))
    .sort();
}

function scheduleBoundEndIso(
  mode: AvailabilityMode,
  dateHours: DateHours,
  periodStart: string,
  periodEnd: string,
): string | null {
  let open = openDateKeys(dateHours);
  if (periodStart) open = open.filter((d) => d >= periodStart);
  if (periodEnd) open = open.filter((d) => d <= periodEnd);
  if (mode === 'specific_dates') {
    if (!open.length) return periodEnd || null;
    return open[open.length - 1];
  }
  return periodEnd || null;
}

export function localAvailabilityConflicts(args: {
  mode: AvailabilityMode;
  dateHours: DateHours;
  periodStart: string;
  periodEnd: string;
  windowDays: number;
  timezone: string;
  today?: string;
}): AvailabilityConflict[] {
  const { mode, dateHours, periodStart, periodEnd, windowDays, timezone } = args;
  const conflicts: AvailabilityConflict[] = [];
  const today = args.today || hostTodayIso(timezone);
  const days = Math.max(1, Math.min(365, Number(windowDays) || 1));
  const windowLastParts = parseIsoDateParts(today);
  let windowLast = today;
  if (windowLastParts) {
    const last = new Date(Date.UTC(windowLastParts.y, windowLastParts.m - 1, windowLastParts.d));
    last.setUTCDate(last.getUTCDate() + (days - 1));
    windowLast = last.toISOString().slice(0, 10);
  }

  if (periodStart && periodEnd && periodEnd < periodStart) {
    conflicts.push({
      code: 'period_inverted',
      message: 'Available until must be on or after Available from.',
      fields: ['availability_start_date', 'availability_end_date'],
      blocking: true,
    });
  }

  if (periodEnd && periodEnd < today) {
    conflicts.push({
      code: 'period_ended',
      message: 'Available until is in the past, so guests will see no times.',
      fields: ['availability_end_date'],
      blocking: false,
    });
  }

  const open = openDateKeys(dateHours);
  const futureOpen = open.filter((d) => d >= today);
  if (mode === 'specific_dates' && open.length === 0) {
    conflicts.push({
      code: 'specific_dates_empty',
      message: 'Specific dates mode has no open dates configured, so guests will see no times.',
      fields: ['date_hours', 'availability_mode'],
      blocking: false,
    });
  } else if (mode === 'specific_dates' && open.length > 0 && futureOpen.length === 0) {
    conflicts.push({
      code: 'specific_dates_all_past',
      message: 'All configured specific dates are in the past, so guests will see no times.',
      fields: ['date_hours'],
      blocking: false,
    });
  }

  const outside = open.filter((d) => (periodStart && d < periodStart) || (periodEnd && d > periodEnd));
  if (outside.length && (mode === 'specific_dates' || mode === 'weekly_with_overrides')) {
    conflicts.push({
      code: 'period_excludes_dates',
      message: 'Some configured dates fall outside the availability period and will not be offered.',
      fields: ['availability_start_date', 'availability_end_date', 'date_hours'],
      dates: outside,
      blocking: false,
    });
  }

  const boundEnd = scheduleBoundEndIso(mode, dateHours, periodStart, periodEnd);
  if (boundEnd && boundEnd >= today && boundEnd > windowLast) {
    const suggested = requiredBookingWindowDays(today, boundEnd);
    conflicts.push({
      code: 'booking_window_excludes_dates',
      message: `Booking window (${days} days) ends on ${windowLast}, before configured availability through ${boundEnd}. Guests cannot book those dates until the window reaches them (or increase the window to ${suggested} days).`,
      fields: ['booking_window_days'],
      suggested_booking_window_days: suggested,
      booking_window_locked: false,
      blocking: false,
    });
  }

  return conflicts;
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const WEEKDAY_LABELS: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};
const ZERO_TIMES_CODES = new Set([
  'no_open_hours',
  'hours_fit_none',
  'notice_exceeds_window',
  'notice_hides_dates',
  'period_start_beyond_window',
]);

/** Conflicts where guests lose whole days or all times; the save flow asks the host to confirm them. */
export function losesGuestTimes(conflict: AvailabilityConflict): boolean {
  if (!ZERO_TIMES_CODES.has(conflict.code)) return false;
  if (conflict.code === 'hours_fit_none') return (conflict.whole_days?.length || 0) > 0;
  return true;
}

function fmtMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function fmtNotice(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function hhmmToMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour > 23) return null;
  return hour * 60 + Number(match[2]);
}

function windowMinutes(interval: Interval): [number, number] | null {
  const open = hhmmToMinutes(interval?.start);
  const close = hhmmToMinutes(interval?.end);
  if (open == null || close == null) return null;
  return [open, close];
}

/** Starts begin at the window open time, then every slotInterval minutes; the full meeting must fit. */
export function alignedSlotStarts(openM: number, closeM: number, slotInterval: number, duration: number): number[] {
  if (slotInterval <= 0 || duration <= 0 || closeM <= openM) return [];
  const last = closeM - duration;
  if (openM > last) return [];
  const out: number[] = [];
  for (let m = openM; m <= last; m += slotInterval) out.push(m);
  return out;
}

function fitFix(openM: number, closeM: number, slotInterval: number, duration: number): string {
  const length = closeM - openM;
  if (length < duration) {
    return `the window is ${length} min but the meeting is ${duration} min; end at ${fmtMinutes(Math.min(openM + duration, 23 * 60 + 59))} or later`;
  }
  return (
    `starts begin at ${fmtMinutes(openM)} then every ${slotInterval} min; ` +
    `the full meeting must finish by ${fmtMinutes(closeM)}`
  );
}

function intervalsValid(rows: unknown): boolean {
  if (rows == null) return true;
  if (!Array.isArray(rows)) return false;
  const parsed: [number, number][] = [];
  for (const row of rows) {
    const w = windowMinutes(row as Interval);
    if (!w || w[0] >= w[1]) return false;
    parsed.push(w);
  }
  parsed.sort((a, b) => a[0] - b[0]);
  return parsed.every((w, i) => i === 0 || w[0] >= parsed[i - 1][1]);
}

function addDaysIso(iso: string, days: number): string {
  const parts = parseIsoDateParts(iso);
  if (!parts) return iso;
  const d = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Mirrors backend detect_slot_fit_conflicts: settings that cancel out and leave guests with no times. */
export function localSlotFitConflicts(args: {
  mode: AvailabilityMode;
  weeklyHours: Hours;
  dateHours: DateHours;
  periodStart: string;
  periodEnd: string;
  windowDays: number;
  slotInterval: number;
  noticeMinutes: number;
  eventTypes: { name: string; duration_minutes: number; active?: boolean }[];
  timezone: string;
  today?: string;
}): AvailabilityConflict[] {
  const { mode, weeklyHours, dateHours, periodStart, periodEnd } = args;
  const out: AvailabilityConflict[] = [];
  const today = args.today || hostTodayIso(args.timezone);
  const windowDays = Math.max(1, Math.min(365, Number(args.windowDays) || 1));
  const windowLast = addDaysIso(today, windowDays - 1);
  const interval = Number(args.slotInterval) || 30;
  const notice = Math.max(0, Number(args.noticeMinutes) || 0);

  const invalid: string[] = [];
  if (mode !== 'specific_dates') {
    for (const day of WEEKDAYS) if (!intervalsValid(weeklyHours[day])) invalid.push(WEEKDAY_LABELS[day]);
  }
  if (mode !== 'weekly') {
    for (const [key, rows] of Object.entries(dateHours)) {
      if (key >= today && !intervalsValid(rows)) invalid.push(key);
    }
  }
  if (invalid.length) {
    out.push({
      code: 'hours_invalid',
      message: 'Some hours have a start at or after the end, or overlap another window. Guests never see those windows.',
      details: invalid,
      blocking: true,
    });
  }

  const inPeriod = (d: string) => (!periodStart || d >= periodStart) && (!periodEnd || d <= periodEnd);
  const weeklyRows: [string, Interval[]][] =
    mode === 'specific_dates'
      ? []
      : WEEKDAYS.filter((day) => Array.isArray(weeklyHours[day]) && weeklyHours[day].length > 0).map((day) => [
          WEEKDAY_LABELS[day],
          weeklyHours[day],
        ]);
  const dateRows: [string, Interval[]][] =
    mode === 'weekly'
      ? []
      : (Object.entries(dateHours) as [string, Interval[]][])
          .filter(([key, rows]) => !!parseIsoDateParts(key) && key >= today && inPeriod(key) && Array.isArray(rows) && rows.length > 0)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (mode === 'weekly' && !weeklyRows.length) {
    out.push({
      code: 'no_open_hours',
      message: 'No weekday has hours, so guests will see no times. Add hours to at least one day.',
      blocking: false,
    });
  } else if (mode === 'weekly_with_overrides' && !weeklyRows.length && !dateRows.length) {
    out.push({
      code: 'no_open_hours',
      message: 'No weekday has hours and no upcoming override date is open, so guests will see no times.',
      blocking: false,
    });
  }

  if (periodStart && periodStart > windowLast && (!periodEnd || periodEnd >= periodStart)) {
    const suggested = requiredBookingWindowDays(today, periodStart);
    out.push({
      code: 'period_start_beyond_window',
      message: `Available from (${periodStart}) is after your booking window ends (${windowLast}), so guests see no times today. Times start appearing on ${addDaysIso(periodStart, -(windowDays - 1))}, or raise the window to ${suggested} days.`,
      suggested_booking_window_days: suggested,
      booking_window_locked: false,
      blocking: false,
    });
  }

  if (notice >= windowDays * 1440) {
    out.push({
      code: 'notice_exceeds_window',
      message: `Minimum notice (${fmtNotice(notice)}) is as long as the booking window (${windowDays} days), so no time is ever both far enough ahead and inside the window. Lower the notice or raise the window.`,
      blocking: false,
    });
  } else {
    const earliest = addDaysIso(today, Math.floor(notice / 1440));
    const hidden = dateRows.map(([d]) => d).filter((d) => d < earliest);
    const bound = scheduleBoundEndIso(mode, dateHours, periodStart, periodEnd);
    if (bound && bound >= today && bound < earliest) {
      out.push({
        code: 'notice_hides_dates',
        message: `Minimum notice (${fmtNotice(notice)}) pushes the first bookable day to ${earliest}, after your schedule ends on ${bound}, so guests will see no times.`,
        dates: hidden,
        blocking: false,
      });
    } else if (hidden.length) {
      out.push({
        code: 'notice_hides_dates',
        message: `Minimum notice (${fmtNotice(notice)}) means guests cannot book before ${earliest}, so these open dates will never show times.`,
        dates: hidden,
        blocking: false,
      });
    }
  }

  const byDuration = new Map<number, string[]>();
  for (const t of args.eventTypes) {
    const dur = Number(t.duration_minutes);
    if (t.active === false || !dur || dur <= 0) continue;
    byDuration.set(dur, [...(byDuration.get(dur) || []), t.name]);
  }
  if (byDuration.size && interval > 0) {
    const details: string[] = [];
    const deadDays: string[] = [];
    const deadDates: string[] = [];
    const rows: [string, boolean, Interval[]][] = [
      ...weeklyRows.map(([label, iv]) => [label, false, iv] as [string, boolean, Interval[]]),
      ...dateRows.map(([d, iv]) => [d, true, iv] as [string, boolean, Interval[]]),
    ];
    for (const [label, isDate, intervals] of rows) {
      const windows = intervals.map(windowMinutes).filter((w): w is [number, number] => !!w && w[0] < w[1]);
      if (!windows.length) continue;
      for (const [dur, names] of [...byDuration.entries()].sort((a, b) => a[0] - b[0])) {
        const empty = windows.filter(([o, c]) => alignedSlotStarts(o, c, interval, dur).length === 0);
        for (const [o, c] of empty) {
          details.push(
            `${label} ${fmtMinutes(o)}–${fmtMinutes(c)} offers no ${dur}-min start for ${names.join(', ')}: ${fitFix(o, c, interval, dur)}.`,
          );
        }
        if (empty.length === windows.length) {
          const bucket = isDate ? deadDates : deadDays;
          if (!bucket.includes(label)) bucket.push(label);
        }
      }
    }
    if (details.length) {
      const whole = [...deadDays, ...deadDates];
      let message = 'Some open hours can never produce a bookable time with your slot interval and meeting length.';
      if (whole.length) {
        message += ` These days look open but guests will see them grayed out: ${whole.slice(0, 10).join(', ')}${whole.length > 10 ? '…' : ''}.`;
      }
      out.push({
        code: 'hours_fit_none',
        message,
        details: details.slice(0, 20),
        dates: deadDates,
        whole_days: whole,
        blocking: false,
      });
    }
  }

  return out;
}

export function availabilityStateFromProfile(profile: Record<string, unknown> | null | undefined): AvailabilityState {
  const raw = profile || {};
  const mode = raw.availability_mode;
  const weekly = raw.weekly_hours;
  const dates = raw.date_hours;
  return {
    mode: mode === 'specific_dates' || mode === 'weekly_with_overrides' ? mode : 'weekly',
    weeklyHours: weekly && typeof weekly === 'object' && !Array.isArray(weekly) ? (weekly as Hours) : {},
    dateHours: dates && typeof dates === 'object' && !Array.isArray(dates) ? (dates as DateHours) : {},
    periodStart: typeof raw.availability_start_date === 'string' ? raw.availability_start_date : '',
    periodEnd: typeof raw.availability_end_date === 'string' ? raw.availability_end_date : '',
  };
}

/** Always sends both weekly and date configs so switching modes never drops either one. */
export function availabilityPayload(state: AvailabilityState) {
  return {
    weekly_hours: state.weeklyHours,
    availability_mode: state.mode,
    date_hours: state.dateHours,
    availability_start_date: state.periodStart || null,
    availability_end_date: state.periodEnd || null,
  };
}
