import { isGrabDocsReachJoinUrl } from './grabdocsJoinUrl';

export type ParsedIcsEvent = {
  uid: string;
  title: string;
  description: string;
  location: string;
  meetingUrl?: string;
  startIso: string;
  endIso: string;
  timezone: string;
  allDay: boolean;
};

function unfold(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function grabJoinUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>"]+/gi) || [];
  return match.find((url) => isGrabDocsReachJoinUrl(url.replace(/[)>.,]+$/, '')));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Convert a wall-clock time in an IANA zone to a UTC ISO string. */
function zonedWallTimeToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): string {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(utcGuess)).map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    const offset = asUtc - utcGuess;
    return new Date(utcGuess - offset).toISOString();
  } catch {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
  }
}

function parseDateValue(raw: string, paramTzid?: string): { iso: string; allDay: boolean; timezone: string } {
  const value = raw.trim();
  const timezone = paramTzid || 'UTC';
  if (/^\d{8}$/.test(value)) {
    return {
      iso: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`,
      allDay: true,
      timezone,
    };
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!match) {
    const fallback = new Date(value);
    return {
      iso: Number.isNaN(fallback.getTime()) ? new Date().toISOString() : fallback.toISOString(),
      allDay: false,
      timezone,
    };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (match[7] === 'Z' || !paramTzid) {
    return {
      iso: `${match[1]}-${match[2]}-${match[3]}T${pad(hour)}:${pad(minute)}:${pad(second)}.000Z`,
      allDay: false,
      timezone: 'UTC',
    };
  }
  return {
    iso: zonedWallTimeToUtcIso(year, month, day, hour, minute, second, paramTzid),
    allDay: false,
    timezone: paramTzid,
  };
}

function prop(block: string, name: string): { value: string; tzid?: string } | null {
  const line = block.split('\n').find((row) => row.toUpperCase().startsWith(`${name}`) && (row[name.length] === ';' || row[name.length] === ':'));
  if (!line) return null;
  const [left, ...rest] = line.split(':');
  const value = rest.join(':');
  const tzid = left.split(';').map((part) => part.trim()).find((part) => part.toUpperCase().startsWith('TZID='));
  return { value, tzid: tzid ? tzid.slice(5) : undefined };
}

export function parseIcsEvents(raw: string): ParsedIcsEvent[] {
  const text = unfold(raw);
  const blocks = text.split(/BEGIN:VEVENT/i).slice(1);
  const events: ParsedIcsEvent[] = [];
  blocks.forEach((chunk, index) => {
    const block = chunk.split(/END:VEVENT/i)[0] || '';
    const summary = prop(block, 'SUMMARY');
    const start = prop(block, 'DTSTART');
    if (!start?.value) return;
    const end = prop(block, 'DTEND');
    const uid = prop(block, 'UID')?.value?.trim() || `import-${index}-${start.value}`;
    const description = unescapeText(prop(block, 'DESCRIPTION')?.value || '');
    const location = unescapeText(prop(block, 'LOCATION')?.value || '');
    const url = prop(block, 'URL')?.value?.trim() || '';
    const startParsed = parseDateValue(start.value, start.tzid);
    let endIso = startParsed.iso;
    let allDay = startParsed.allDay;
    if (end?.value) {
      const endParsed = parseDateValue(end.value, end.tzid || start.tzid);
      endIso = endParsed.iso;
      allDay = allDay || endParsed.allDay;
    } else if (allDay) {
      const startDate = new Date(startParsed.iso);
      startDate.setUTCDate(startDate.getUTCDate() + 1);
      endIso = startDate.toISOString();
    } else {
      endIso = new Date(new Date(startParsed.iso).getTime() + 60 * 60 * 1000).toISOString();
    }
    if (new Date(endIso).getTime() <= new Date(startParsed.iso).getTime()) {
      endIso = new Date(new Date(startParsed.iso).getTime() + 60 * 60 * 1000).toISOString();
    }
    const meetingUrl = [url, location, description].map(grabJoinUrl).find(Boolean);
    events.push({
      uid: uid.slice(0, 500),
      title: unescapeText(summary?.value || 'Event').slice(0, 255) || 'Event',
      description,
      location: location.slice(0, 500),
      meetingUrl,
      startIso: startParsed.iso,
      endIso,
      timezone: startParsed.timezone || 'UTC',
      allDay,
    });
  });
  return events;
}
