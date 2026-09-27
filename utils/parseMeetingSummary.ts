export type MeetingSummaryKind =
  | 'overview'
  | 'action_items'
  | 'key_points'
  | 'agenda'
  | 'speakers'
  | 'decisions'
  | 'questions'
  | 'generic';

export type MeetingSummarySection = {
  title: string;
  kind: MeetingSummaryKind;
  format: 'bullets' | 'paragraph';
  bullets: string[];
  paragraph: string;
};

export type ParsedMeetingSummary = {
  sections: MeetingSummarySection[];
};

const TITLE_KIND: Array<{ kind: MeetingSummaryKind; aliases: string[] }> = [
  { kind: 'overview', aliases: ['short summary', 'summary', 'overview', 'meeting summary'] },
  { kind: 'action_items', aliases: ['action items', 'action item', 'todo', 'to-do', 'todos', 'next steps'] },
  { kind: 'key_points', aliases: ['key points', 'key point', 'highlights', 'highlight'] },
  { kind: 'agenda', aliases: ['agenda'] },
  { kind: 'speakers', aliases: ['speakers', 'speaker', 'participants', 'attendees'] },
  { kind: 'decisions', aliases: ['decisions', 'decision', 'key decisions'] },
  { kind: 'questions', aliases: ['questions', 'open questions', 'unresolved'] },
];

function normalizeTitle(title: string): string {
  return title.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function classifySummaryTitle(title: string): MeetingSummaryKind {
  const key = normalizeTitle(title);
  for (const row of TITLE_KIND) {
    if (row.aliases.includes(key)) return row.kind;
  }
  return 'generic';
}

function asString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asBulletList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          return asString(obj.text || obj.content || obj.item || obj.value || obj.description || obj.name);
        }
        return asString(item);
      })
      .filter(Boolean);
  }
  const text = asString(value);
  return text ? [text] : [];
}

function firstContent(section: Record<string, unknown>): { bullets: string[]; paragraph: string } {
  const bulletKeys = ['bullets', 'items', 'points', 'list'];
  const paragraphKeys = ['paragraph', 'content', 'text', 'body', 'summary', 'description', 'details'];
  for (const key of bulletKeys) {
    if (section[key] != null) {
      const bullets = asBulletList(section[key]);
      if (bullets.length) return { bullets, paragraph: '' };
    }
  }
  for (const key of paragraphKeys) {
    if (section[key] != null) {
      if (Array.isArray(section[key])) {
        const bullets = asBulletList(section[key]);
        if (bullets.length) return { bullets, paragraph: '' };
      }
      const paragraph = asString(section[key]);
      if (paragraph) return { bullets: [], paragraph };
    }
  }
  return { bullets: [], paragraph: '' };
}

function sectionFromUnknown(raw: unknown, fallbackTitle: string): MeetingSummarySection | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    return {
      title: fallbackTitle,
      kind: classifySummaryTitle(fallbackTitle),
      format: 'paragraph',
      bullets: [],
      paragraph: text,
    };
  }
  if (Array.isArray(raw)) {
    const bullets = asBulletList(raw);
    if (!bullets.length) return null;
    return {
      title: fallbackTitle,
      kind: classifySummaryTitle(fallbackTitle),
      format: 'bullets',
      bullets,
      paragraph: '',
    };
  }
  if (typeof raw !== 'object') return null;
  const section = raw as Record<string, unknown>;
  const title = asString(section.title || section.heading || section.name || section.label) || fallbackTitle;
  const declared = asString(section.format).toLowerCase();
  const extracted = firstContent(section);
  if (!extracted.bullets.length && !extracted.paragraph) return null;
  let format: 'bullets' | 'paragraph' = extracted.bullets.length ? 'bullets' : 'paragraph';
  if (declared === 'paragraph' && extracted.paragraph) format = 'paragraph';
  if (declared === 'bullets' && extracted.bullets.length) format = 'bullets';
  return {
    title,
    kind: classifySummaryTitle(title),
    format,
    bullets: extracted.bullets,
    paragraph: extracted.paragraph,
  };
}

function parseObjectSummary(parsed: Record<string, unknown>): MeetingSummarySection[] {
  const sections: MeetingSummarySection[] = [];
  const rawSections = parsed.sections;
  if (Array.isArray(rawSections)) {
    rawSections.forEach((item, index) => {
      const section = sectionFromUnknown(item, `Section ${index + 1}`);
      if (section) sections.push(section);
    });
  }

  const topLevelAliases: Array<{ key: string; title: string }> = [
    { key: 'summary', title: 'Summary' },
    { key: 'overview', title: 'Overview' },
    { key: 'key_points', title: 'Key Points' },
    { key: 'highlights', title: 'Key Points' },
    { key: 'action_items', title: 'Action Items' },
    { key: 'todo_items', title: 'Action Items' },
    { key: 'agenda', title: 'Agenda' },
    { key: 'participants', title: 'Speakers' },
    { key: 'attendees', title: 'Speakers' },
    { key: 'decisions', title: 'Decisions' },
    { key: 'questions', title: 'Questions' },
  ];
  if (!sections.length) {
    for (const alias of topLevelAliases) {
      if (parsed[alias.key] == null) continue;
      const section = sectionFromUnknown(parsed[alias.key], alias.title);
      if (section) sections.push(section);
    }
  }
  return sections;
}

export function parseMeetingSummary(content: string | null | undefined): ParsedMeetingSummary {
  const raw = (content || '').trim();
  if (!raw) return { sections: [] };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed && typeof parsed === 'object') {
    const sections = parseObjectSummary(parsed as Record<string, unknown>);
    if (sections.length) return { sections };
  }

  return {
    sections: [
      {
        title: 'Summary',
        kind: 'overview',
        format: 'paragraph',
        bullets: [],
        paragraph: raw,
      },
    ],
  };
}
