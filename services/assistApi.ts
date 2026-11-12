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

export async function getArchiveProgress() {
  const res = await client().get(`${BASE}/archive/progress`);
  return res.data;
}

export async function cancelAssistArchive() {
  const res = await client().post(`${BASE}/archive/cancel`);
  return res.data;
}
