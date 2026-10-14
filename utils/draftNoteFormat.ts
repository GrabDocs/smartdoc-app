/**
 * Note formatting conventions shared with the web editor
 * (manager-francis/frontend/src/components/drafts/documentFormat.ts) — keep values in sync
 * so a note edited on mobile renders identically on web and vice versa.
 */

export const FONT_SIZE_PRESETS_PT = [10, 11, 12, 14, 18, 24, 36] as const;
export type FontSizePresetPt = (typeof FONT_SIZE_PRESETS_PT)[number];
export const DEFAULT_FONT_SIZE_PT: FontSizePresetPt = 12;

export const LINE_HEIGHT_PRESETS = [
  { label: 'Single', value: '1' },
  { label: '1.15', value: '1.15' },
  { label: '1.5', value: '1.5' },
  { label: 'Double', value: '2' },
] as const;

export const FONT_FAMILIES: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
  { label: 'System UI', value: 'system-ui, -apple-system, Segoe UI, sans-serif' },
];

export const HEADING_OPTIONS = [
  { label: 'Normal text', value: 'P' },
  { label: 'Heading 2', value: 'H2' },
  { label: 'Heading 3', value: 'H3' },
] as const;

/** Point size → canonical CSS px string (same output as the web editor, e.g. 14pt → "18.667px"). */
export function ptToCssPx(pt: number): string {
  const px = (pt * 96) / 72;
  const rounded = Math.round(px * 1000) / 1000;
  return `${Number(rounded.toFixed(3))}px`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Printable HTML document for a note; mirrors the web print stylesheet. */
export function buildPrintableNoteHtml(title: string, bodyHtml: string): string {
  const safeTitle = escapeHtml(title || 'Note');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${safeTitle}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;line-height:1.5;font-size:16px;}
  h1.print-title{font-size:18px;margin:0 0 16px;}
  pre,p{white-space:pre-wrap;word-wrap:break-word;margin:0 0 12px;}
  table{border-collapse:collapse;margin:0 0 12px;width:100%;}
  th,td{border:1px solid #bbb;padding:4px 8px;vertical-align:top;}
  th{background:#f3f4f6;text-align:left;}
  td p,th p{margin:0;}
  blockquote{border-left:4px solid #60a5fa;margin:0 0 12px;padding-left:12px;font-style:italic;color:#374151;}
  pre{font-family:inherit;}
  pre code{font-family:'Courier New',monospace;}
  h1,h2,h3,tr{page-break-inside:avoid;}
  @media print{body{margin:12px;}}
</style></head><body>
<h1 class="print-title">${safeTitle}</h1>
${bodyHtml}
</body></html>`;
}

/** Safe file name for exported notes. */
export function noteExportFileName(title: string, ext: 'pdf' | 'html'): string {
  const base = (title || 'Note').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'Note';
  return `${base}.${ext}`;
}
