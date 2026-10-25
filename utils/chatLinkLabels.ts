/**
 * File-view chat links should show the document name, not "Open" / "Open Document".
 * Models still sometimes emit those generic labels; normalize them here.
 */

const GENERIC_DOCUMENT_LINK_LABELS = new Set([
  'open',
  'open document',
  'open file',
  'open pdf',
  'view',
  'view document',
  'view file',
  'view pdf',
  'document',
  'file',
  'pdf',
  'link',
  'here',
  'click here',
  'read more',
  'view here',
  'see here',
]);

type CitationLike =
  | string
  | {
      document_id?: string | number;
      source_id?: string | number;
      source_name?: string;
      filename?: string;
      metadata?: { filename?: string };
    };

function isFileViewLink(url: string): boolean {
  const u = (url || '').trim();
  if (!u) return false;
  const isApiFile =
    u.includes('/api/v1/web/files/') || u.includes('/api/v1/mobile/files/');
  return isApiFile && (u.includes('/view') || /\/files\/\d+\/v\//.test(u));
}

function extractFileIdFromViewUrl(url: string): number | null {
  const m = (url || '').match(/\/files\/(\d+)\/(?:view|v\/)/);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  return Number.isFinite(id) ? id : null;
}

function citationDisplayName(c: CitationLike): string | undefined {
  if (typeof c === 'string') {
    const n = c.trim();
    if (!n || GENERIC_DOCUMENT_LINK_LABELS.has(n.toLowerCase())) return undefined;
    return n;
  }
  if (!c || typeof c !== 'object') return undefined;
  const n = String(c.source_name || c.filename || c.metadata?.filename || '').trim();
  if (!n) return undefined;
  if (GENERIC_DOCUMENT_LINK_LABELS.has(n.toLowerCase())) return undefined;
  if (n.toLowerCase() === 'untitled' || n.toLowerCase() === 'unknown') return undefined;
  return n;
}

/** Strip "Open" / "Open Document:" wrappers so only the document name remains. */
export function stripGenericDocumentLinkPrefix(linkText: string): string {
  let s = (linkText || '').trim();
  if (!s) return '';
  s = s.replace(/^(open document|open file|view document|view file)\s*:\s*/i, '').trim();
  if (GENERIC_DOCUMENT_LINK_LABELS.has(s.toLowerCase())) return '';
  s = s.replace(/^(open|view)\s+/i, '').trim();
  if (GENERIC_DOCUMENT_LINK_LABELS.has(s.toLowerCase())) return '';
  return s;
}

export function documentNameFromCitations(
  linkUrl: string,
  citations?: CitationLike[] | null
): string | undefined {
  if (!citations?.length) return undefined;
  const fileId = extractFileIdFromViewUrl(linkUrl);

  if (fileId != null) {
    for (const c of citations) {
      if (!c || typeof c === 'string') continue;
      const id = c.document_id ?? c.source_id;
      if (id == null) continue;
      const numId = typeof id === 'string' ? parseInt(id, 10) : Number(id);
      if (numId !== fileId) continue;
      const name = citationDisplayName(c);
      if (name) return name;
    }
  }

  const names = citations
    .map(citationDisplayName)
    .filter((n): n is string => !!n);
  const unique = Array.from(new Set(names));
  if (unique.length === 1) return unique[0];
  return undefined;
}

export function formatDocumentOpenLinkLabel(
  linkText: string,
  linkUrl: string,
  documentName?: string | null
): string {
  if (!isFileViewLink(linkUrl)) return linkText;
  const fromText = stripGenericDocumentLinkPrefix(linkText);
  if (fromText) return fromText;
  const fromName = (documentName || '').trim();
  if (fromName && !GENERIC_DOCUMENT_LINK_LABELS.has(fromName.toLowerCase())) {
    return fromName;
  }
  return fromText || fromName || linkText;
}
