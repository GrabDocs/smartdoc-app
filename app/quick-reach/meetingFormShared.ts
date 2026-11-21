import { apiService } from '../../services/api';

export type MeetingWorkspaceOption = {
  id: number;
  name: string;
  is_personal?: boolean;
};

/** Reach web schedule duration options (minutes). */
export const MEETING_DURATION_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '1.5 hours' },
  { value: 120, label: '2 hours' },
  { value: 180, label: '3 hours' },
];

export const DEFAULT_MEETING_DURATION_MINUTES = 60;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar date as YYYY-MM-DD (matches web date input). */
export function formatLocalDateValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local wall time as HH:mm (matches web time input). */
export function formatLocalTimeValue(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Combine date + time into a single local Date (seconds/ms cleared). */
export function combineLocalDateAndTime(date: Date, time: Date): Date {
  const combined = new Date(date);
  combined.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return combined;
}

/** Default schedule start: ~15 minutes from now (rounded to next 5 min). */
export function defaultScheduleDateTime(): Date {
  const d = new Date(Date.now() + 15 * 60 * 1000);
  d.setSeconds(0, 0);
  const mins = d.getMinutes();
  const rounded = Math.ceil(mins / 5) * 5;
  if (rounded >= 60) {
    d.setHours(d.getHours() + 1, 0, 0, 0);
  } else {
    d.setMinutes(rounded, 0, 0);
  }
  return d;
}

export function durationLabel(minutes: number): string {
  return MEETING_DURATION_OPTIONS.find((o) => o.value === minutes)?.label ?? `${minutes} minutes`;
}

/** Prefer personal workspace, else first membership — matches backend default workspace priority. */
export function pickDefaultMeetingWorkspaceId(
  workspaces: MeetingWorkspaceOption[]
): number | null {
  if (!workspaces.length) return null;
  const personal = workspaces.find((w) => w.is_personal);
  if (personal?.id != null) return personal.id;
  return workspaces[0]?.id ?? null;
}

export async function loadMeetingWorkspaces(): Promise<MeetingWorkspaceOption[]> {
  const response = await apiService.getMobileWorkspaces(100, 0);
  const rows = Array.isArray(response.data)
    ? response.data
    : response.data?.workspaces || [];
  return (rows as Array<{ id?: number; name?: string; is_personal?: boolean }>)
    .filter((row) => typeof row.id === 'number')
    .map((row) => ({
      id: row.id as number,
      name: row.name || `Workspace ${row.id}`,
      is_personal: !!row.is_personal,
    }));
}
