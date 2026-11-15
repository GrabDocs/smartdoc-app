/**
 * GrabDocs Assist API helpers — /api/v1/assist
 */

import { apiClient } from './api';

const BASE = '/api/v1/assist';
const client = () => apiClient.client;

export type AssistBriefItem = {
  id: number;
  item_type: string;
  title: string;
  detail?: string | null;
  status: string;
  first_seen_date?: string | null;
  due_at?: string | null;
  source_refs?: { kind?: string; id?: number; filename?: string }[];
};

export const ASSIST_USAGE_LABELS: Record<string, string> = {
  archive: 'Archive indexing',
  attachments: 'Attachments / OCR / filing',
  calls: 'Calls',
  ask: 'Ask',
  explain: 'Explain',
  daily_brief: 'Daily Brief',
};

export async function getAssistStatus(ownerUserId?: number, opts?: { light?: boolean }) {
  const res = await client().get(`${BASE}/status`, {
    params: {
      ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
      ...(opts?.light ? { light: 1 } : {}),
    },
  });
  return res.data;
}

export async function completeAssistSetup(body: Record<string, unknown>) {
  const res = await client().post(`${BASE}/setup`, body);
  return res.data;
}

export async function getAssistTaxonomy() {
  const res = await client().get(`${BASE}/taxonomy`);
  return res.data;
}

export async function getSetupEstimate(lookbackMode: string, lookbackFrom?: string, timezone?: string) {
  const res = await client().get(`${BASE}/setup/estimate`, {
    params: {
      lookback_mode: lookbackMode,
      ...(lookbackFrom ? { lookback_from: lookbackFrom } : {}),
      ...(timezone ? { timezone } : {}),
    },
  });
  return res.data;
}

export async function getTodayBrief(ownerUserId?: number) {
  const res = await client().get(`${BASE}/brief/today`, {
    params: ownerUserId ? { owner_user_id: ownerUserId } : undefined,
  });
  return res.data;
}

export async function generateTodayBrief() {
  const res = await client().post(`${BASE}/brief/generate`);
  return res.data;
}

export async function patchBriefItem(
  itemId: number,
  body: Record<string, unknown>,
  ownerUserId?: number,
) {
  const res = await client().patch(`${BASE}/brief/items/${itemId}`, {
    ...body,
    owner_user_id: ownerUserId,
  });
  return res.data;
}

export async function addBriefItemToCalendar(
  itemId: number,
  ownerUserId?: number,
  when?: { start_time: string; end_time?: string; all_day?: boolean },
) {
  const res = await client().post(`${BASE}/brief/items/${itemId}/add-to-calendar`, {
    owner_user_id: ownerUserId,
    ...(when || {}),
  });
  return res.data;
}

export async function getBriefItemSource(itemId: number, ownerUserId?: number) {
  const res = await client().get(`${BASE}/brief/items/${itemId}/source`, {
    params: ownerUserId ? { owner_user_id: ownerUserId } : undefined,
  });
  return res.data;
}

export async function askAssist(question: string, ownerUserId?: number) {
  const res = await client().post(`${BASE}/ask`, {
    question,
    owner_user_id: ownerUserId,
  });
  return res.data;
}

export async function listAssistCalls(ownerUserId?: number) {
  const res = await client().get(`${BASE}/calls`, {
    params: ownerUserId ? { owner_user_id: ownerUserId } : undefined,
  });
  return res.data;
}

export async function getAssistCall(callId: number, ownerUserId?: number) {
  const res = await client().get(`${BASE}/calls/${callId}`, {
    params: ownerUserId ? { owner_user_id: ownerUserId } : undefined,
  });
  return res.data;
}

export async function getAssistScheduleSettings() {
  const res = await client().get(`${BASE}/schedule/settings`);
  return res.data;
}

export async function saveAssistScheduleSettings(body: Record<string, unknown>) {
  const res = await client().post(`${BASE}/schedule/settings`, body);
  return res.data;
}

export async function setupAssistCalls(body: Record<string, unknown>) {
  const res = await client().post(`${BASE}/calls/setup`, body);
  return res.data;
}

export async function startAssistTestCall() {
  const res = await client().post(`${BASE}/calls/test`);
  return res.data;
}

export async function startAssistOutboundCall(to: string) {
  const res = await client().post(`${BASE}/calls/outbound`, { to });
  return res.data;
}

export async function listAssistPeople() {
  const res = await client().get(`${BASE}/people`);
  return res.data;
}

export async function resumeAssistArchive() {
  const res = await client().post(`${BASE}/archive/resume`);
  return res.data;
}

export async function getAssistArchiveMessage(messageId: number, ownerUserId?: number) {
  const res = await client().get(`${BASE}/archive/${messageId}`, {
    params: ownerUserId ? { owner_user_id: ownerUserId } : undefined,
  });
  return res.data;
}

export async function explainAssistDocument(payload: { file_id?: number; text?: string }) {
  const res = await client().post(`${BASE}/explain`, payload);
  return res.data;
}

export type AssistArchiveCursor = {
  id?: number;
  connection_id?: number;
  cursor_kind?: string;
  status?: string;
  messages_imported?: number;
  mailbox_label?: string;
  platform?: string;
  account_name?: string | null;
  last_error?: string | null;
  updated_at?: string | null;
};

export function archiveCursorKindLabel(kind?: string): string {
  if (kind === 'backfill') return 'Backfill';
  if (kind === 'incremental') return 'Live sync';
  return kind || 'Sync';
}

export function archiveCursorStatusLabel(cursor: AssistArchiveCursor): string {
  const status = String(cursor?.status || '');
  if (status === 'done' || status === 'synced') return 'finished';
  if (status === 'running') return cursor?.cursor_kind === 'incremental' ? 'syncing' : 'importing';
  if (status === 'paused_credits') return 'paused (out of credits)';
  if (status === 'paused_quota') return 'paused (quota)';
  if (status === 'paused_disconnected') return 'paused (mailbox disconnected)';
  if (status === 'error_auth') return 'needs reconnect';
  if (status === 'cancelled') return 'cancelled';
  // Never surface raw snake_case codes in the UI.
  return status.replace(/_/g, ' ') || 'unknown';
}

export function formatArchiveCursorLine(cursor: AssistArchiveCursor): string {
  const mailbox = cursor?.mailbox_label || cursor?.account_name || 'Mailbox';
  const kind = archiveCursorKindLabel(cursor?.cursor_kind);
  const status = archiveCursorStatusLabel(cursor);
  const imported = Number(cursor?.messages_imported || 0);
  return `${mailbox} · ${kind}: ${status} · imported ${imported}`;
}

/** Client-side safety net: one row per mailbox + kind. */
export function dedupeArchiveCursorsForDisplay(
  cursors: AssistArchiveCursor[] | undefined | null,
): AssistArchiveCursor[] {
  const list = cursors || [];
  const best = new Map<string, AssistArchiveCursor>();
  const rank = (status?: string) => {
    const s = String(status || '');
    if (s === 'running') return 0;
    if (s.startsWith('paused') || s === 'error_auth') return 1;
    if (s === 'synced' || s === 'done') return 2;
    return 3;
  };
  for (const c of list) {
    const key = `${c.connection_id || 0}:${c.cursor_kind || ''}`;
    const prev = best.get(key);
    if (!prev || rank(c.status) < rank(prev.status) || (rank(c.status) === rank(prev.status) && Number(c.id || 0) > Number(prev.id || 0))) {
      best.set(key, c);
    }
  }
  return Array.from(best.values()).sort((a, b) => {
    const ko = (k?: string) => (k === 'backfill' ? 0 : k === 'incremental' ? 1 : 9);
    return (
      ko(a.cursor_kind) - ko(b.cursor_kind) ||
      String(a.mailbox_label || '').localeCompare(String(b.mailbox_label || '')) ||
      Number(a.id || 0) - Number(b.id || 0)
    );
  });
}

export function archiveCursorsActive(cursors: AssistArchiveCursor[] | undefined | null): boolean {
  return (cursors || []).some((c) => ['running', 'paused_quota'].includes(String(c?.status || '')));
}

/** True when archive can be resumed (credits/quota/disconnect/cancel). */
export function archiveCursorsResumable(cursors: AssistArchiveCursor[] | undefined | null): boolean {
  return (cursors || []).some((c) =>
    ['paused_credits', 'paused_quota', 'cancelled', 'paused_disconnected'].includes(
      String(c?.status || ''),
    ),
  );
}

export function summarizeArchiveSync(cursors: AssistArchiveCursor[] | undefined | null): string | null {
  const list = cursors || [];
  if (!list.length) return null;
  const backfills = list.filter((c) => c.cursor_kind === 'backfill');
  const pausedBackfill = backfills.find((c) =>
    ['paused_credits', 'paused_quota', 'paused_disconnected', 'cancelled'].includes(
      String(c?.status || ''),
    ),
  );
  if (pausedBackfill) {
    const mailbox = pausedBackfill.mailbox_label || 'Mailbox';
    const status = archiveCursorStatusLabel(pausedBackfill);
    return `${mailbox} archive is ${status} · imported ${Number(pausedBackfill.messages_imported || 0)}. Resume from Settings when ready.`;
  }
  const activeBackfill = backfills.find((c) => c.status === 'running');
  if (activeBackfill) {
    const mailbox = activeBackfill.mailbox_label || 'Mailbox';
    return `${mailbox} archive is importing (${Number(activeBackfill.messages_imported || 0)} so far). Mail becomes searchable as it lands.`;
  }
  const live = list.find((c) => c.cursor_kind === 'incremental' && c.status === 'running');
  if (live) {
    return `${live.mailbox_label || 'Mailbox'} is syncing new mail.`;
  }
  const finished = backfills.filter((c) => c.status === 'done' || c.status === 'synced');
  const syncedLive = list.find((c) => c.cursor_kind === 'incremental' && c.status === 'synced');
  if (finished.length || syncedLive) {
    const label = (syncedLive || finished[finished.length - 1])?.mailbox_label || 'Mailbox';
    return `${label} is connected. Archive import finished; new mail keeps syncing in the background.`;
  }
  return null;
}

/** Prefer readable citation dates; never leave raw ISO in the Sources list. */
export function formatAssistCitationDate(raw?: string | null): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/[A-Za-z]{3,}/.test(text) && !/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  try {
    return parsed.toLocaleString(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return text;
  }
}

export async function getArchiveProgress() {
  const res = await client().get(`${BASE}/archive/progress`);
  return res.data;
}

export async function cancelAssistArchive() {
  const res = await client().post(`${BASE}/archive/cancel`);
  return res.data;
}
