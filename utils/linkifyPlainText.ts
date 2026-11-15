import { validateAndSanitizeUrl } from './linkSecurity';

export type PlainTextPart =
  | { type: 'text'; text: string }
  | { type: 'url'; raw: string };

/** http(s), www., and common bare domains (zoom.us, meet.google.com, etc.) */
const URL_PATTERN =
  /(https?:\/\/[^\s]+|www\.[^\s]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,})(?:\/[^\s,;)}\]'"]*)?)/gi;
const TRAILING_PUNCT = /[.,;:!?)}\]'"]+$/;

function decodeHtmlEntities(text: string): string {
  let s = text;
  for (let pass = 0; pass < 2; pass++) {
    s = s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#(\d+);/g, (_, code: string) => {
        const n = Number(code);
        return Number.isFinite(n) ? String.fromCharCode(n) : _;
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return s;
}

/** Strip Assist calendar dedupe markers from user-visible text. */
export function stripAssistBriefMarkers(text: string): string {
  return String(text || '')
    .replace(/\[assist_brief_item:\d+\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Convert HTML / markdown-ish calendar text to readable plain text. */
export function htmlToPlainText(html: string): string {
  if (!html) return '';

  let s = decodeHtmlEntities(stripAssistBriefMarkers(html.trim()));

  s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label: string, url: string) => {
    const trimmed = label.replace(/<\/?[a-z][^>]*>/gi, '').trim();
    return trimmed && trimmed !== url ? `${trimmed} ${url}` : url;
  });

  s = s.replace(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, inner: string) => {
      const url = decodeHtmlEntities(href.trim());
      const label = inner.replace(/<\/?[a-z][^>]*>/gi, '').replace(/\s+/g, ' ').trim();
      return label && label !== url ? `${label} ${url}` : url;
    },
  );

  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/div>/gi, '\n');
  s = s.replace(/<\/li>/gi, '\n');
  s = s.replace(/<\/h[1-6]>/gi, '\n');
  s = s.replace(/<\/?[a-z][^>]*>/gi, '');

  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

/** Strip HTML / markdown wrappers so bare URLs can be detected and opened. */
export function normalizeLinkifySource(text: string): string {
  return htmlToPlainText(text);
}

function isValidOpenableUrl(raw: string): boolean {
  return validateAndSanitizeUrl(raw).valid;
}

/** Split plain text into segments, detecting openable URLs. */
export function splitTextByUrls(text: string): PlainTextPart[] {
  const normalized = normalizeLinkifySource(text);
  if (!normalized) return [];

  const parts: PlainTextPart[] = [];
  let lastIndex = 0;

  for (const match of normalized.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push({ type: 'text', text: normalized.slice(lastIndex, index) });
    }

    let raw = match[0];
    const trailing = raw.match(TRAILING_PUNCT)?.[0] ?? '';
    if (trailing) raw = raw.slice(0, -trailing.length);

    if (raw && isValidOpenableUrl(raw)) {
      parts.push({ type: 'url', raw });
    } else if (raw) {
      parts.push({ type: 'text', text: raw });
    }
    if (trailing) parts.push({ type: 'text', text: trailing });

    lastIndex = index + match[0].length;
  }

  if (lastIndex < normalized.length) {
    parts.push({ type: 'text', text: normalized.slice(lastIndex) });
  }

  return parts.length ? parts : [{ type: 'text', text: normalized }];
}

export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const part of splitTextByUrls(text)) {
    if (part.type === 'url' && !seen.has(part.raw)) {
      seen.add(part.raw);
      urls.push(part.raw);
    }
  }
  return urls;
}

export function textContainsUrls(text: string): boolean {
  return extractUrls(text).length > 0;
}
