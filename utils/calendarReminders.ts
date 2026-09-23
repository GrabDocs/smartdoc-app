export type ReminderMethod = 'notification' | 'email' | 'both';

export function parseReminderMethod(raw: unknown): ReminderMethod {
  if (raw === 'email' || raw === 'both') return raw;
  return 'notification';
}
export type ReminderUnit = 'minutes' | 'hours' | 'days' | 'weeks';

export type CalendarReminder = {
  minutes: number;
  method: ReminderMethod;
};

export const MAX_CALENDAR_REMINDERS = 5;
export const MAX_REMINDER_MINUTES = 4 * 7 * 24 * 60;

export const DEFAULT_REMINDERS: CalendarReminder[] = [
  { minutes: 15, method: 'notification' },
];

const UNIT_MINUTES: Record<ReminderUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10080,
};

export function minutesFromParts(amount: number, unit: ReminderUnit): number {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  return Math.min(n * UNIT_MINUTES[unit], MAX_REMINDER_MINUTES);
}

export function partsFromMinutes(minutes: number): { amount: number; unit: ReminderUnit } {
  const m = Math.max(0, Math.floor(minutes || 0));
  if (m === 0) return { amount: 0, unit: 'minutes' };
  if (m % 10080 === 0) return { amount: m / 10080, unit: 'weeks' };
  if (m % 1440 === 0) return { amount: m / 1440, unit: 'days' };
  if (m % 60 === 0) return { amount: m / 60, unit: 'hours' };
  return { amount: m, unit: 'minutes' };
}

export function formatReminderOffset(minutes: number): string {
  if (minutes <= 0) return 'When event starts';
  const { amount, unit } = partsFromMinutes(minutes);
  const label = amount === 1 ? unit.slice(0, -1) : unit;
  return `${amount} ${label} before`;
}

export function remindersFromEvent(event: Record<string, unknown> | null | undefined): CalendarReminder[] {
  const raw = event?.reminders;
  if (Array.isArray(raw) && raw.length) {
    return raw.slice(0, MAX_CALENDAR_REMINDERS).map((row) => {
      const item = row as { minutes?: unknown; method?: unknown };
      return {
        minutes: Number(item.minutes) || 0,
        method: parseReminderMethod(item.method),
      };
    });
  }
  const minutes = event?.reminder_minutes || event?.reminder_minutes_before;
  if (Array.isArray(minutes) && minutes.length && minutes.every((x) => typeof x === 'number')) {
    return (minutes as number[]).map((m) => ({ minutes: m, method: 'notification' as const }));
  }
  return [...DEFAULT_REMINDERS];
}
