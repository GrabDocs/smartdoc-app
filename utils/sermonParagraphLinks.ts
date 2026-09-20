/**
 * Mirrors manager-francis/frontend/src/utils/sermonParagraphLinks.tsx (paragraph link resolution).
 * Used by mobile AssistantMessageBody for sermon paragraph taps.
 */

export interface SermonCitation {
  cite_index?: number;
  document_id?: string | number;
  source_id?: string | number;
  paragraph?: string;
  paragraph_start?: number;
  paragraph_end?: number;
  chunk_id?: string;
  relevance_score?: number;
  source_name?: string;
  filename?: string;
  chunk_content?: string;
  excerpt?: string;
  snippet?: string;
}

export type SermonCitationType = string | SermonCitation;

export function buildParagraphToCiteMap(raw: string): Map<number, number> {
  const map = new Map<number, number>();
  if (!raw) return map;
  const paraRe = /(?:paragraphs?\s+|para\.?\s*)(\d+)(?:\s*[-–—]\s*(\d+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(raw)) !== null) {
    const n = parseInt(m[1], 10);
    if (isNaN(n)) continue;
    const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 280);
    const citeM = after.match(/\[\[cite:\s*(\d+)\s*[^\]]*\]\]/);
    if (citeM) map.set(n, parseInt(citeM[1], 10));
  }
  return map;
}

export function stripCiteAnchors(text: string): string {
  return (text || '')
    .replace(/\[\[cite:\s*\d+\s*[^\]]*\]\]/g, '')
    // Internal polarity markers — never show to users
    .replace(/\[\[\s*claim_support\s*:\s*[^\]]+\]\]/gi, '')
    .replace(/  +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Break run-on list lines: `**A**: "x". - **B**` → newline bullets so UI can show one row per item.
 * Same idea as web sermonParagraphLinks (dense model output).
 */
export function normalizeAssistantListMarkdown(text: string): string {
  let s = text || '';
  s = s.replace(/\.\s*-\s*\*\*/g, '\n- **');
  s = s.replace(/\.\s+-\s+\*\*/g, '\n- **');
  s = s.replace(/:\s*-\s*\*\*/g, ':\n\n- **');
  s = s.replace(/(["'])\s*-\s*\*\*/g, '$1\n- **');
  return s;
}

export type AssistantBodySegment =
  | { type: 'prose'; text: string }
  | { type: 'ul'; items: string[] };

/**
 * Split normalized body into prose blocks and markdown-style bullet runs (- / * / •).
 */
export function segmentAssistantBody(text: string): AssistantBodySegment[] {
  const raw = (text || '').split(/\n/);
  const segments: AssistantBodySegment[] = [];
  let ulItems: string[] = [];
  let proseLines: string[] = [];

  const flushProse = () => {
    const t = proseLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t) segments.push({ type: 'prose', text: t });
    proseLines = [];
  };
  const flushUl = () => {
    if (ulItems.length) {
      segments.push({ type: 'ul', items: [...ulItems] });
      ulItems = [];
    }
  };

  for (const line of raw) {
    const t = line.trim();
    if (!t) {
      flushUl();
      if (proseLines.length) proseLines.push('');
      continue;
    }
    const isBullet =
      /^[-*•]\s+\S/.test(t) ||
      /^-\s*\*\*/.test(t) ||
      /^\*\s+\S/.test(t);
    if (isBullet) {
      flushProse();
      ulItems.push(t);
    } else {
      flushUl();
      proseLines.push(line);
    }
  }
  flushProse();
  flushUl();
  return segments;
}

export type ParagraphLinkOpen = (
  fileId: number,
  paragraph: number,
  title?: string,
  paragraphEnd?: number
) => void;

export interface ResolvedParagraphTap {
  fileId: number;
  openStart: number;
  openEnd?: number;
  title?: string;
}

/**
 * Resolve which file + scroll/highlight range to open for a paragraph ref in content.
 */
export function resolveParagraphTap(
  scrollTo: number,
  endParagraph: number | undefined,
  citations: SermonCitationType[] | undefined,
  paragraphToCite?: Map<number, number>
): ResolvedParagraphTap | null {
  let docId: number | null = null;
  let citationTitle: string | undefined;
  let openStart = scrollTo;
  let openEnd = endParagraph;

  const citeIdx = paragraphToCite?.get(scrollTo);
  const list = (citations || []).filter((c) => typeof c === 'object' && c) as SermonCitation[];
  if (citeIdx != null && citeIdx >= 1 && citeIdx <= list.length) {
    const cit = list[citeIdx - 1];
    const id = cit.document_id ?? cit.source_id;
    const numId = id != null ? (typeof id === 'string' ? parseInt(String(id), 10) : Number(id)) : NaN;
    if (!isNaN(numId)) {
      docId = numId;
      citationTitle = cit.source_name || cit.filename;
      const ps = cit.paragraph_start;
      const pe = cit.paragraph_end;
      if (
        typeof ps === 'number' &&
        typeof pe === 'number' &&
        !isNaN(ps) &&
        !isNaN(pe) &&
        scrollTo >= ps &&
        scrollTo <= pe &&
        pe > ps
      ) {
        openStart = ps;
        openEnd = pe;
      } else {
        openStart = scrollTo;
        openEnd = endParagraph;
      }
    }
  }

  if (docId == null && citations?.length) {
    type Cand = { docId: number; title?: string; score: number };
    const cands: Cand[] = [];
    for (const c of citations) {
      if (typeof c === 'string') continue;
      const id = c.document_id || c.source_id;
      if (id == null) continue;
      const numId = typeof id === 'string' ? parseInt(id, 10) : Number(id);
      if (isNaN(numId)) continue;
      const title = c.source_name || c.filename;
      const rel = Number(c.relevance_score);
      const relBoost = !isNaN(rel) ? rel * 50 : 0;

      let start: number | null = null;
      let end: number | null = null;
      const ps = c.paragraph_start;
      const pe = c.paragraph_end;
      if (typeof ps === 'number' && !isNaN(ps)) {
        start = ps;
        end = typeof pe === 'number' && !isNaN(pe) ? pe : ps;
      } else {
        const para = c.paragraph;
        if (para == null || para === '') continue;
        const paraStr = String(para);
        const dash = paraStr.indexOf('-');
        if (dash >= 0) {
          start = parseInt(paraStr.slice(0, dash).trim(), 10);
          end = parseInt(paraStr.slice(dash + 1).trim(), 10);
        } else {
          const n = parseInt(paraStr, 10);
          if (!isNaN(n)) start = end = n;
        }
      }
      if (start == null || isNaN(start)) continue;
      if (scrollTo < start || (end != null && !isNaN(end) && scrollTo > end)) continue;
      const width = end != null && !isNaN(end) ? Math.max(0, end - start) : 0;
      let score = 100 - width + relBoost;
      if (start === scrollTo && end === scrollTo) score += 2000;
      else if (start === scrollTo) score += 1000;
      cands.push({ docId: numId, title, score });
    }
    if (cands.length) {
      cands.sort((a, b) => b.score - a.score);
      docId = cands[0].docId;
      citationTitle = cands[0].title;
    }
    if (docId == null && citations.length > 0) {
      const first = citations[0];
      if (typeof first === 'object' && first !== null && (first.document_id || first.source_id)) {
        const id = first.document_id || first.source_id;
        docId = typeof id === 'string' ? parseInt(id, 10) : Number(id);
        if (!isNaN(docId)) citationTitle = first.source_name || first.filename;
      }
    }
  }

  if (docId == null || isNaN(docId)) return null;
  return { fileId: docId, openStart, openEnd: openEnd ?? endParagraph, title: citationTitle };
}

const PARA_REF_REGEX = /(?:paragraphs?\s+|para\.?\s*|\(|#|¶\s*)(\d+)(?:\s*[-–—]\s*(\d+))?\)?/gi;

export function segmentParagraphForLinksEnriched(
  content: string,
  citations: SermonCitationType[] | undefined,
  paragraphToCite?: Map<number, number>
): Array<
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; fileId: number; openStart: number; openEnd?: number; title?: string }
> {
  if (!content) return [];
  const out: Array<
    | { type: 'text'; text: string }
    | { type: 'link'; text: string; fileId: number; openStart: number; openEnd?: number; title?: string }
  > = [];
  let lastIndex = 0;
  PARA_REF_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PARA_REF_REGEX.exec(content)) !== null) {
    if (m.index > lastIndex) {
      out.push({ type: 'text', text: content.slice(lastIndex, m.index) });
    }
    const fullMatch = m[0];
    const firstNum = parseInt(m[1], 10);
    const secondNum = m[2] != null ? parseInt(m[2], 10) : undefined;
    const scrollTo = firstNum;
    const endParagraph =
      secondNum != null && !isNaN(secondNum) && secondNum >= firstNum ? secondNum : undefined;
    const resolved = resolveParagraphTap(scrollTo, endParagraph, citations, paragraphToCite);
    if (resolved) {
      out.push({
        type: 'link',
        text: fullMatch,
        fileId: resolved.fileId,
        openStart: resolved.openStart,
        openEnd: resolved.openEnd,
        title: resolved.title,
      });
    } else {
      out.push({ type: 'text', text: fullMatch });
    }
    lastIndex = PARA_REF_REGEX.lastIndex;
  }
  if (lastIndex < content.length) {
    out.push({ type: 'text', text: content.slice(lastIndex) });
  }
  return out.length ? out : [{ type: 'text', text: content }];
}

export function splitIntoDisplayParagraphs(
  text: string,
  minCharsToSplit = 320,
  sentencesPerParagraph = 4
): string[] {
  const t = (text || '').trim();
  if (!t) return [];
  const byNewline = t
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (byNewline.length >= 2) return byNewline;
  const single = byNewline[0] || t;
  if (single.length < minCharsToSplit) return [single];
  const sentences = single
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length <= sentencesPerParagraph) return [single];
  const result: string[] = [];
  for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
    result.push(sentences.slice(i, i + sentencesPerParagraph).join(' '));
  }
  return result.length ? result : [single];
}

/** Strip chart markdown link line from content when chart is shown separately (match web getContentForDisplay). */
export function stripChartLinkLine(content: string, hasChartFileId: boolean): string {
  if (!hasChartFileId || !content) return content;
  return content
    .replace(/\n?\[View Chart:[^\]]*\]\([^)]*\/api\/v1\/web\/files\/\d+\/view[^)]*\)\n?/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
