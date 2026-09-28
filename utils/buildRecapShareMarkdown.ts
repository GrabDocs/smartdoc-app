import { parseMeetingSummary } from './parseMeetingSummary';
import { formatTalkDuration, formatTurnClock, parseMeetingTranscript, computeTalkTime } from './parseMeetingTranscript';
import type { MeetingRecapEnrichment, MeetingRecapHero } from '../components/meeting/meetingRecapTypes';

/** Client-side markdown fallback when the stored recap pack File is not ready yet. */
export function buildRecapShareMarkdown(opts: {
  hero?: MeetingRecapHero | null;
  summaryContent?: string | null;
  transcriptContent?: string | null;
  enrichment?: MeetingRecapEnrichment | null;
  meetingDurationSeconds?: number | null;
}): string {
  const title = opts.hero?.title?.trim() || 'Meeting recap';
  const lines: string[] = [`# ${title}`, ''];
  const meta: string[] = [];
  if (opts.hero?.dateLabel) meta.push(`- Date: ${opts.hero.dateLabel}`);
  if (opts.hero?.durationLabel) meta.push(`- Duration: ${opts.hero.durationLabel}`);
  if (opts.hero?.attendees?.length) meta.push(`- Attendees: ${opts.hero.attendees.join(', ')}`);
  if (meta.length) {
    lines.push(...meta, '');
  }

  const parsed = parseMeetingSummary(opts.summaryContent);
  for (const section of parsed.sections) {
    lines.push(`## ${section.title}`);
    if (section.format === 'bullets' && section.bullets.length) {
      for (const item of section.bullets) lines.push(`- ${item}`);
    } else if (section.paragraph) {
      lines.push(section.paragraph);
    }
    lines.push('');
  }

  const chapters = opts.enrichment?.chapters || [];
  if (chapters.length) {
    lines.push('## Chapters');
    for (const chapter of chapters) {
      const clock = chapter.clock || formatTurnClock(chapter.startSeconds) || '';
      lines.push(`- ${clock ? `${clock} ` : ''}${chapter.title || ''}`.trim());
    }
    lines.push('');
  }

  const actions = opts.enrichment?.action_items || [];
  if (actions.length) {
    lines.push('## Timed action items');
    for (const item of actions) {
      const clock = item.clock || formatTurnClock(item.startSeconds) || '';
      const prefix = [clock, item.speaker].filter(Boolean).join(' ');
      lines.push(`- ${prefix ? `${prefix} — ` : ''}${item.text || ''}`.trim());
    }
    lines.push('');
  }

  const turns = parseMeetingTranscript(opts.transcriptContent).turns;
  const talk = computeTalkTime(turns, opts.meetingDurationSeconds);
  if (talk.length) {
    lines.push('## Talk time');
    for (const row of talk) {
      lines.push(`- ${row.speaker}: ${formatTalkDuration(row.seconds)} (${row.percent}%)`);
    }
    lines.push('');
  }

  if (turns.length) {
    lines.push('## Transcript', '');
    for (const turn of turns) {
      const clock = formatTurnClock(turn.startSeconds);
      lines.push(`${clock ? `[${clock}] ` : ''}${turn.speaker}: ${turn.text}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}
