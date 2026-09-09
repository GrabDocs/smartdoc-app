/**
 * Utility functions for formatting timestamps in mobile app
 * Converts UTC timestamps to local phone timezone
 */

/**
 * Parse a backend timestamp as a UTC instant, then format with toLocale* for phone-local display.
 * Naive ISO (no Z/offset) is UTC. Date-only `YYYY-MM-DD` stays a local calendar day so due dates
 * do not shift. Returns an Invalid Date when the value cannot be parsed.
 */
export function parseAsUTC(timestamp: string | number | Date | null | undefined): Date {
  if (timestamp == null || timestamp === '') return new Date(NaN);
  if (timestamp instanceof Date) return new Date(timestamp.getTime());
  if (typeof timestamp === 'number') {
    const n = timestamp;
    return new Date(n > 0 && n < 1e12 ? n * 1000 : n);
  }
  let s = String(timestamp).trim();
  if (!s) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  if (/^\d{4}-\d{2}-\d{2}\s+\d/.test(s)) {
    s = s.replace(/\s+/, 'T');
  }
  const hasTz = /Z|[+-]\d{2}:?\d{2}$/i.test(s);
  return new Date(hasTz ? s : `${s}Z`);
}

/** Epoch ms for a UTC backend timestamp, or NaN if unusable. */
export function parseUtcMs(timestamp: string | number | Date | null | undefined): number {
  return parseAsUTC(timestamp).getTime();
}

/** Remaining lock/undo time, e.g. `18s` or `1m 5s`. Caps so a bad parse never shows hours. */
export function formatRemainingCountdown(sec: number, maxSec = 60): string {
  const s = Math.max(0, Math.min(Math.ceil(sec), Math.max(0, Math.ceil(maxSec))));
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }
  return `${s}s`;
}

/**
 * Format a UTC timestamp string to local timezone with date and time
 * @param timestamp - ISO format timestamp string (UTC)
 * @returns Formatted date string in local timezone (e.g., "Jan 25, 2026, 10:07 PM EST")
 */
export const formatTimestampToLocal = (timestamp: string | null | undefined): string => {
  if (!timestamp) return 'No date';
  
  try {
    const date = parseAsUTC(timestamp);
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      return timestamp; // Return original if invalid
    }
    
    // Format to local timezone with date, time, and timezone
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    });
  } catch (error) {
    console.error('Error formatting timestamp:', error);
    return timestamp; // Return original on error
  }
};

/**
 * Format a UTC timestamp string to local timezone (date only)
 * @param timestamp - ISO format timestamp string (UTC)
 * @returns Formatted date string in local timezone (e.g., "Jan 25, 2026")
 */
export const formatDateToLocal = (timestamp: string | null | undefined): string => {
  if (!timestamp) return 'No date';
  
  try {
    const date = parseAsUTC(timestamp);
    
    if (isNaN(date.getTime())) {
      return timestamp;
    }
    
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch (error) {
    console.error('Error formatting date:', error);
    return timestamp;
  }
};

/**
 * Format a UTC timestamp string to local timezone (time only)
 * @param timestamp - ISO format timestamp string (UTC)
 * @returns Formatted time string in local timezone (e.g., "10:07 PM")
 */
export const formatTimeToLocal = (timestamp: string | null | undefined): string => {
  if (!timestamp) return 'No time';
  
  try {
    const date = parseAsUTC(timestamp);
    
    if (isNaN(date.getTime())) {
      return timestamp;
    }
    
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch (error) {
    console.error('Error formatting time:', error);
    return timestamp;
  }
};

/**
 * Format a UTC timestamp for meeting display (short: month, day, time in local timezone)
 * @param timestamp - ISO format timestamp string (UTC)
 * @returns Formatted string in local timezone (e.g., "Feb 22, 3:00 PM")
 */
export const formatMeetingTimeToLocal = (timestamp: string | null | undefined): string => {
  if (!timestamp) return '—';
  try {
    const date = parseAsUTC(timestamp);
    if (isNaN(date.getTime())) return timestamp;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch (error) {
    console.error('Error formatting meeting time:', error);
    return timestamp;
  }
};
