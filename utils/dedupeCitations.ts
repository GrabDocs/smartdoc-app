/**
 * Deduplicate chat References entries.
 *
 * - Normal documents (no paragraph fields): one entry per document (id, else filename).
 * - Any paragraph-chunked citation (sermons or other docs with paragraph /
 *   paragraph_start / paragraph_end): one entry per document + paragraph range
 *   so different ranges from the same file stay visible.
 *
 * Mirrors manager-francis/frontend/src/utils/dedupeCitations.ts
 */

export type DedupeableCitation =
  | string
  | {
      document_id?: string | number;
      source_id?: string | number;
      source_name?: string;
      filename?: string;
      paragraph?: string | number | null;
      paragraph_start?: number | null;
      paragraph_end?: number | null;
      metadata?: { filename?: string };
    };

function citationDocumentKey(citation: DedupeableCitation): string {
  if (typeof citation === 'string') {
    return `name:${citation.trim().toLowerCase()}`;
  }
  const id = citation.document_id ?? citation.source_id;
  if (id != null && String(id).trim() !== '' && String(id) !== '0') {
    return `id:${String(id)}`;
  }
  const name = (
    citation.source_name ||
    citation.filename ||
    citation.metadata?.filename ||
    ''
  )
    .trim()
    .toLowerCase();
  return name ? `name:${name}` : 'anon';
}

/** Paragraph label for doc+paragraph dedupe; null when the citation has no paragraph fields. */
export function citationParagraphKey(citation: DedupeableCitation): string | null {
  if (typeof citation === 'string') return null;
  const ps = citation.paragraph_start;
  const pe = citation.paragraph_end;
  if (typeof ps === 'number' && !Number.isNaN(ps)) {
    if (typeof pe === 'number' && !Number.isNaN(pe) && pe !== ps) {
      return `${ps}-${pe}`;
    }
    return String(ps);
  }
  const para = citation.paragraph;
  if (para == null || para === '') return null;
  return String(para).trim();
}

export function citationDedupeKey(citation: DedupeableCitation): string {
  const docKey = citationDocumentKey(citation);
  const paraKey = citationParagraphKey(citation);
  return paraKey ? `${docKey}::para:${paraKey}` : docKey;
}

export function dedupeCitations<T extends DedupeableCitation>(citations: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const citation of citations) {
    const key = citationDedupeKey(citation);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}
