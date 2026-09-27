export type MeetingTranscriptTurn = {
  speaker: string;
  startSeconds: number | null;
  text: string;
};

export type ParsedMeetingTranscript = {
  speakers: string[];
  turns: MeetingTranscriptTurn[];
};

export type SpeakerTalkSegment = {
  start: number;
  end: number;
};

export type SpeakerTalkTime = {
  speaker: string;
  seconds: number;
  percent: number;
  firstStartSeconds?: number;
  segments: SpeakerTalkSegment[];
  estimated?: boolean;
};

const WEBVTT_RE = /^\s*WEBVTT\b/i;
const SRT_INDEX_RE = /^\d+$/;
const TIMESTAMP_ARROW_RE = /-->/;
const VTT_SPEAKER_RE = /^<v\s+([^>]+)>\s*/i;
const NAME_LINE_RE = /^([A-Za-z0-9][A-Za-z0-9 .'_-]{0,79})\s*:\s+(\S.*)$/;
const CLOCK_RE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;

export function parseTimestampToSeconds(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  const match = value.match(CLOCK_RE);
  if (!match) return null;
  const hours = match[1] != null ? parseInt(match[1], 10) : 0;
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const fraction = match[4] ? parseInt(match[4].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0;
  if ([hours, minutes, seconds].some((n) => Number.isNaN(n))) return null;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

function parseCueTime(line: string): number | null {
  const left = line.split('-->')[0] || '';
  return parseTimestampToSeconds(left.replace(/[^\d:.,]/g, ' ').trim().split(/\s+/)[0]);
}

function stripVttTags(text: string): string {
  return text.replace(/<\/?[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function extractSpeakerAndText(raw: string): { speaker: string; text: string } {
  const trimmed = raw.trim();
  const vMatch = trimmed.match(VTT_SPEAKER_RE);
  if (vMatch) {
    return { speaker: vMatch[1].trim() || 'Speaker', text: stripVttTags(trimmed.slice(vMatch[0].length)) };
  }
  const nameMatch = trimmed.match(NAME_LINE_RE);
  if (nameMatch) {
    return { speaker: nameMatch[1].trim(), text: nameMatch[2].trim() };
  }
  return { speaker: 'Speaker', text: stripVttTags(trimmed) };
}

function uniqueSpeakers(turns: MeetingTranscriptTurn[]): string[] {
  const seen = new Set<string>();
  const speakers: string[] = [];
  for (const turn of turns) {
    const name = turn.speaker.trim() || 'Speaker';
    if (!seen.has(name)) {
      seen.add(name);
      speakers.push(name);
    }
  }
  return speakers;
}

function mergeCueLines(lines: string[]): string {
  return lines.map((l) => l.trim()).filter(Boolean).join(' ');
}

function parseCuedTranscript(content: string, isVtt: boolean): MeetingTranscriptTurn[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const turns: MeetingTranscriptTurn[] = [];
  let i = 0;
  if (isVtt && lines[0] && WEBVTT_RE.test(lines[0])) {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '') i += 1;
  }

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
      i += 1;
      continue;
    }
    if (SRT_INDEX_RE.test(line) && i + 1 < lines.length && TIMESTAMP_ARROW_RE.test(lines[i + 1])) {
      i += 1;
      continue;
    }
    if (TIMESTAMP_ARROW_RE.test(line)) {
      const startSeconds = parseCueTime(line);
      i += 1;
      const cueLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        cueLines.push(lines[i]);
        i += 1;
      }
      const merged = mergeCueLines(cueLines);
      if (merged) {
        const { speaker, text } = extractSpeakerAndText(merged);
        if (text) turns.push({ speaker, startSeconds, text });
      }
      continue;
    }
    i += 1;
  }
  return turns;
}

function parsePlainSpeakerLines(content: string): MeetingTranscriptTurn[] {
  const turns: MeetingTranscriptTurn[] = [];
  for (const raw of content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const nameMatch = line.match(NAME_LINE_RE);
    if (nameMatch) {
      turns.push({ speaker: nameMatch[1].trim(), startSeconds: null, text: nameMatch[2].trim() });
    } else if (turns.length) {
      turns[turns.length - 1].text = `${turns[turns.length - 1].text}\n${line}`;
    }
  }
  return turns;
}

export function parseMeetingTranscript(content: string | null | undefined): ParsedMeetingTranscript {
  const raw = (content || '').trim();
  if (!raw) {
    return { speakers: ['Transcript'], turns: [{ speaker: 'Transcript', startSeconds: null, text: '' }] };
  }

  const isVtt = WEBVTT_RE.test(raw);
  const looksCued = isVtt || TIMESTAMP_ARROW_RE.test(raw);
  let turns = looksCued ? parseCuedTranscript(raw, isVtt) : [];
  if (!turns.length) {
    turns = parsePlainSpeakerLines(raw);
  }
  if (!turns.length) {
    turns = [{ speaker: 'Transcript', startSeconds: null, text: raw }];
  }
  return { speakers: uniqueSpeakers(turns), turns };
}

function mergeTalkSegment(segments: SpeakerTalkSegment[], start: number, end: number): void {
  const last = segments[segments.length - 1];
  if (last && start <= last.end + 0.25) {
    last.end = Math.max(last.end, end);
    return;
  }
  segments.push({ start, end });
}

function allocatePercents(seconds: number[]): number[] {
  const total = seconds.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return seconds.map(() => 0);
  const raw = seconds.map((n) => (n / total) * 100);
  const floors = raw.map((n) => Math.floor(n));
  let remain = 100 - floors.reduce((sum, n) => sum + n, 0);
  const order = raw
    .map((n, i) => ({ i, frac: n - Math.floor(n) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (let k = 0; k < remain && order.length; k += 1) {
    out[order[k % order.length].i] += 1;
  }
  return out;
}

export function talkTimelineDuration(
  rows: SpeakerTalkTime[],
  meetingDurationSeconds?: number | null
): number {
  const fromRows = rows.reduce((max, row) => {
    const last = row.segments[row.segments.length - 1]?.end ?? 0;
    return Math.max(max, last);
  }, 0);
  if (meetingDurationSeconds != null && meetingDurationSeconds > 0) {
    return Math.max(meetingDurationSeconds, fromRows);
  }
  return fromRows;
}

function computeTalkTimeFromWords(
  turns: MeetingTranscriptTurn[],
  meetingDurationSeconds?: number | null
): SpeakerTalkTime[] {
  const wordsBySpeaker = new Map<string, number>();
  for (const turn of turns) {
    const speaker = (turn.speaker || '').trim();
    if (!speaker || speaker === 'Transcript' || speaker === 'Speaker') continue;
    const words = (turn.text || '').trim().split(/\s+/).filter(Boolean).length;
    if (!words) continue;
    wordsBySpeaker.set(speaker, (wordsBySpeaker.get(speaker) || 0) + words);
  }
  const entries = Array.from(wordsBySpeaker.entries()).filter(([, words]) => words > 0);
  const totalWords = entries.reduce((sum, [, words]) => sum + words, 0);
  if (totalWords <= 0) return [];
  const totalSeconds =
    meetingDurationSeconds != null && meetingDurationSeconds > 0
      ? meetingDurationSeconds
      : (totalWords / 150) * 60;
  const percents = allocatePercents(entries.map(([, words]) => words));
  return entries
    .map(([speaker, words], index) => ({
      speaker,
      seconds: (words / totalWords) * totalSeconds,
      percent: percents[index] ?? 0,
      segments: [] as SpeakerTalkSegment[],
      estimated: true,
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

export function computeTalkTime(
  turns: MeetingTranscriptTurn[],
  meetingDurationSeconds?: number | null
): SpeakerTalkTime[] {
  const timed = turns.filter((t) => t.startSeconds != null && Number.isFinite(t.startSeconds));
  if (timed.length < 2 && !(timed.length === 1 && meetingDurationSeconds && meetingDurationSeconds > timed[0].startSeconds!)) {
    return computeTalkTimeFromWords(turns, meetingDurationSeconds);
  }
  const segmentsBySpeaker = new Map<string, SpeakerTalkSegment[]>();
  for (let i = 0; i < timed.length; i += 1) {
    const start = timed[i].startSeconds as number;
    const next = timed[i + 1]?.startSeconds;
    let end: number | null = next != null && next > start ? next : null;
    if (end == null && meetingDurationSeconds != null && meetingDurationSeconds > start) {
      end = meetingDurationSeconds;
    }
    if (end == null) continue;
    const speaker = timed[i].speaker.trim() || 'Speaker';
    const segments = segmentsBySpeaker.get(speaker) || [];
    mergeTalkSegment(segments, start, end);
    segmentsBySpeaker.set(speaker, segments);
  }
  const entries = Array.from(segmentsBySpeaker.entries())
    .map(([speaker, segments]) => ({
      speaker,
      seconds: segments.reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0),
      firstStartSeconds: segments[0]?.start ?? 0,
      segments,
    }))
    .filter((row) => row.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  const percents = allocatePercents(entries.map((row) => row.seconds));
  if (!entries.length) return computeTalkTimeFromWords(turns, meetingDurationSeconds);
  return entries.map((row, index) => ({
    ...row,
    percent: percents[index] ?? 0,
  }));
}

export function formatTurnClock(startSeconds: number | null | undefined): string | null {
  if (startSeconds == null || !Number.isFinite(startSeconds) || startSeconds < 0) return null;
  const total = Math.floor(startSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatTalkDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes} min`;
  return `${rest}s`;
}
