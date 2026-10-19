import type { EmailMessage, ReplyFromInfo } from '../../../services/emailSyncApi';

export type AnalysisRequest = { label: string; type: string };
export type AnalysisQuery = { query: string; type: string; confidence?: number };
export type ThreadAnalysis = {
  intent_summary: string;
  requests: AnalysisRequest[];
  thread_summary?: string;
  search_queries?: AnalysisQuery[];
  auto_suggest_eligible?: boolean;
  confidence?: number;
};

export const REPLY_TONES = [
  { value: 'professional', label: 'Professional' },
  { value: 'concise', label: 'Concise' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'firm', label: 'Firm' },
] as const;

export type ReplyTone = (typeof REPLY_TONES)[number]['value'];
export const DEFAULT_REPLY_TONE: ReplyTone = 'professional';

export function restoreTone(raw?: string | null): ReplyTone {
  const t = (raw || '').toLowerCase();
  if (t === 'formal') return 'professional';
  if ((REPLY_TONES as readonly { value: string }[]).some((x) => x.value === t)) return t as ReplyTone;
  return DEFAULT_REPLY_TONE;
}

export function requestIcon(type: string) {
  const t = (type || '').toLowerCase();
  if (t === 'document' || t === 'attachment') return '📎';
  if (t === 'calendar') return '📅';
  return '✓';
}

function normEmail(addr?: string | null) {
  const raw = (addr || '').trim().toLowerCase();
  const lt = raw.lastIndexOf('<');
  const gt = raw.lastIndexOf('>');
  if (lt >= 0 && gt > lt) return raw.slice(lt + 1, gt).trim();
  return raw;
}

function ownMailboxSet(replyFrom: ReplyFromInfo | null | undefined): Set<string> {
  const s = new Set<string>();
  if (!replyFrom) return s;
  for (const raw of [
    replyFrom.mailbox_address,
    replyFrom.from_address,
    ...(replyFrom.send_as_addresses || []),
  ]) {
    const n = normEmail(raw);
    if (n) s.add(n);
  }
  return s;
}

function latestByDirection(messages: EmailMessage[], direction: 'inbound' | 'outbound'): EmailMessage | null {
  return [...messages].reverse().find((m) => m.direction === direction) || null;
}

/** Mirrors backend resolve_reply_recipients. */
export function computeReplyRecipients(
  messages: EmailMessage[],
  replyFrom: ReplyFromInfo | null | undefined,
  mode: 'reply' | 'reply_all',
): { to: string[]; cc: string[] } {
  const own = ownMailboxSet(replyFrom);
  const inbound = latestByDirection(messages, 'inbound');
  const outbound = latestByDirection(messages, 'outbound');
  const to: string[] = [];
  const cc: string[] = [];
  const pushUnique = (list: string[], addr: string) => {
    if (addr && !own.has(addr) && !to.includes(addr) && !cc.includes(addr) && !list.includes(addr)) {
      list.push(addr);
    }
  };
  if (inbound) {
    const frm = normEmail(
      (inbound as { reply_to_address?: string }).reply_to_address || inbound.from_address,
    );
    if (frm) pushUnique(to, frm);
    if (mode === 'reply_all') {
      for (const addr of inbound.to_addresses || []) pushUnique(to, normEmail(addr));
      for (const addr of inbound.cc_addresses || []) pushUnique(cc, normEmail(addr));
    }
    return { to, cc };
  }
  if (outbound) {
    for (const addr of outbound.to_addresses || []) pushUnique(to, normEmail(addr));
    if (mode === 'reply_all') {
      for (const addr of outbound.cc_addresses || []) pushUnique(cc, normEmail(addr));
    }
  }
  return { to, cc };
}

export function canReplyAll(
  messages: EmailMessage[],
  replyFrom?: ReplyFromInfo | null,
) {
  const recips = computeReplyRecipients(messages, replyFrom || null, 'reply_all');
  return recips.to.length + recips.cc.length > 1;
}

export function prepopulateResearchQuestion(analysis: ThreadAnalysis): { text: string; aiSuggested: boolean } {
  const requestLabels = new Set(
    (analysis.requests || []).map((r) => (r.label || '').trim().toLowerCase()).filter(Boolean),
  );
  const qs = (analysis.search_queries || [])
    .map((q) => (q.query || '').trim())
    .filter((q) => q && !requestLabels.has(q.toLowerCase()));
  if (qs.length) return { text: qs.join('\n'), aiSuggested: true };
  return { text: '', aiSuggested: false };
}
