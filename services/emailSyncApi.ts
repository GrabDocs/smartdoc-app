import { apiClient } from './api';
import { resolveEffectiveWorkspaceId } from './folderApi';

const INBOUND = '/api/v1/web/inbound-email';
const MAILBOX = '/api/v1/web/email-mailbox';

const client = () => apiClient.client;

export async function emailSyncWorkspaceId(explicit?: number | null): Promise<number> {
  if (explicit != null && Number.isFinite(explicit)) return explicit;
  const id = await resolveEffectiveWorkspaceId(client());
  if (id == null) throw new Error('No workspace available');
  return id;
}

export type InboxConnection = {
  id: number;
  platform: string;
  account_name?: string;
  is_active?: boolean;
  last_synced_at?: string | null;
  sync_config?: Record<string, unknown>;
  needs_reconnect?: boolean;
  read_enabled?: boolean;
  send_enabled?: boolean;
  needs_reconnect_for_send?: boolean;
  workspace_id?: number | null;
  send_as_addresses?: string[];
};

export type EmailInboxAlias = {
  id: number;
  alias_address: string;
  display_name?: string;
  allowed_senders?: string[];
  target_folder_id?: number | null;
  is_active?: boolean;
};

export type EmailImportEvent = {
  id: number;
  source_type?: string;
  email_sender?: string | null;
  email_subject?: string | null;
  attachment_filename?: string | null;
  status: string;
  failure_category?: string | null;
  file_id?: number | null;
  created_at?: string | null;
};

const RETRIABLE_FAILURES = new Set(['pipeline_error', 'storage_error']);

export function importCanRetry(ev: EmailImportEvent): boolean {
  if (ev.status === 'received' || ev.status === 'processing') return true;
  if (ev.status === 'failed' || ev.status === 'rejected') {
    return RETRIABLE_FAILURES.has(ev.failure_category || '');
  }
  return false;
}

export function importCanView(ev: EmailImportEvent): boolean {
  return ev.status === 'processed' && ev.file_id != null;
}

export type EmailThread = {
  id: number;
  subject?: string | null;
  attention_status?: string;
  reply_status?: string;
  archived_at?: string | null;
  dismissed_at?: string | null;
  last_message_at?: string | null;
  participants?: string[];
  surface_reason?: string | null;
  provider_thread_id?: string | null;
  attachment_names?: string[];
  attachments?: { id: number; filename?: string | null; file_id?: number | null; import_status?: string | null }[];
  draft_preview?: {
    id: number;
    subject?: string | null;
    to?: string[];
    reply_mode?: string;
    updated_at?: string | null;
  };
};

export type EmailMessage = {
  id: number;
  direction?: string;
  from_address?: string | null;
  to_addresses?: string[];
  cc_addresses?: string[];
  body_text?: string | null;
  body_html?: string | null;
  subject?: string | null;
  provider_received_at?: string | null;
  attachments?: { id: number; filename?: string | null; file_id?: number | null; import_status?: string | null }[];
};

export type EmailDraft = {
  id: number;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string | null;
  body_text?: string | null;
  reply_mode?: string;
  tone?: string | null;
  attachments?: { id: number; filename?: string; size_bytes?: number; source_type?: string; file_id?: number | null }[];
};

export type ThreadAnalysis = {
  intent_summary: string;
  requests: { label: string; type: string }[];
  thread_summary?: string;
  search_queries?: { query: string; type: string; confidence?: number }[];
  auto_suggest_eligible?: boolean;
  confidence?: number;
};

export type GenerateDraftBody = {
  tone?: string;
  reply_mode?: 'reply' | 'reply_all';
  custom_instructions?: string;
  body_text?: string;
  source?: string;
  mention_attachments?: boolean;
};

export type ResearchGenerateBody = {
  research_text: string;
  tone?: string;
  reply_mode?: 'reply' | 'reply_all';
  custom_instructions?: string;
  body_text?: string;
};

export type ReplyFromInfo = {
  from_address?: string | null;
  mailbox_address?: string | null;
  customer_addressed?: string | null;
  send_as_addresses?: string[];
  using_send_as_alias?: boolean;
  forward_without_send_as?: boolean;
};

export type ConnectionRules = {
  connection_id: number;
  platform?: string;
  account_name?: string;
  allowed_senders: string[];
  subject_keywords: string[];
  allowed_file_types: string[];
  target_folder_id?: number | null;
  sync_start_date?: string | null;
};

export type ThreadAttention = 'pending' | 'candidates' | 'dismissed' | 'drafts' | 'closed';

function apiErrorMessage(err: any, fallback: string): string {
  return err?.response?.data?.error || err?.message || fallback;
}

export function emailApiError(err: unknown, fallback = 'Request failed'): string {
  return apiErrorMessage(err, fallback);
}

export async function listInboxConnections() {
  const { data } = await client().get(`${INBOUND}/connections`);
  return (data?.connections ?? []) as InboxConnection[];
}

export async function inboxConnectUrl(provider: 'gmail' | 'outlook', workspaceId: number): Promise<string> {
  const { data } = await client().get(`${INBOUND}/${provider}/connect`, {
    params: { mobile: '1', workspace_id: workspaceId },
  });
  const url = data?.authorization_url;
  if (!url || typeof url !== 'string') {
    throw new Error('Backend did not return an authorization URL');
  }
  return url;
}

export async function getInboxRules(connectionId: number) {
  const { data } = await client().get(`${INBOUND}/connections/${connectionId}/rules`);
  return data as ConnectionRules;
}

export async function patchInboxRules(connectionId: number, body: Record<string, unknown>) {
  const { data } = await client().patch(`${INBOUND}/connections/${connectionId}/rules`, body);
  return data;
}

export async function syncInboxConnection(connectionId: number) {
  const { data } = await client().post(`${INBOUND}/connections/${connectionId}/sync`);
  return data;
}

export async function disconnectInboxConnection(connectionId: number) {
  await client().delete(`${INBOUND}/connections/${connectionId}/disconnect`);
}

export async function deleteInboxConnection(connectionId: number) {
  await client().delete(`${INBOUND}/connections/${connectionId}`);
}

export async function listInboxAliases(workspaceId: number) {
  const { data } = await client().get(`${INBOUND}/aliases`, { params: { workspace_id: workspaceId } });
  return (data?.aliases ?? data ?? []) as EmailInboxAlias[];
}

export async function createInboxAlias(body: Record<string, unknown>) {
  const { data } = await client().post(`${INBOUND}/aliases`, body);
  return data as EmailInboxAlias;
}

export async function getInboxAlias(id: number) {
  const { data } = await client().get(`${INBOUND}/aliases/${id}`);
  return (data?.id ? data : data?.alias ?? data) as EmailInboxAlias;
}

export async function patchInboxAlias(id: number, body: Record<string, unknown>) {
  const { data } = await client().patch(`${INBOUND}/aliases/${id}`, body);
  return data as EmailInboxAlias;
}

export async function deleteInboxAlias(id: number) {
  await client().delete(`${INBOUND}/aliases/${id}`);
}

export async function listWorkspaceImports(workspaceId: number, opts?: { cursor?: string; status?: string }) {
  const { data } = await client().get(`${INBOUND}/imports`, {
    params: { workspace_id: workspaceId, cursor: opts?.cursor, status: opts?.status },
  });
  return data as { imports: EmailImportEvent[]; has_more?: boolean; next_cursor?: string | null };
}

export async function listAliasImports(aliasId: number, opts?: { cursor?: string }) {
  const { data } = await client().get(`${INBOUND}/aliases/${aliasId}/imports`, { params: opts });
  return data as { imports: EmailImportEvent[]; has_more?: boolean; next_cursor?: string | null };
}

export async function retryImport(eventId: number) {
  await client().post(`${INBOUND}/imports/${eventId}/retry`);
}

export async function hideImport(eventId: number) {
  await client().delete(`${INBOUND}/imports/${eventId}`);
}

export async function mailboxCapabilities(workspaceId: number) {
  const { data } = await client().get(`${MAILBOX}/capabilities`, { params: { workspace_id: workspaceId } });
  return data as {
    has_oauth_mailbox: boolean;
    connections?: (InboxConnection & { send_as_addresses?: string[] })[];
  };
}

export async function mailboxPendingCount(workspaceId: number) {
  const { data } = await client().get(`${MAILBOX}/pending-count`, { params: { workspace_id: workspaceId } });
  return Number(data?.count ?? 0);
}

export async function listMailboxThreads(workspaceId: number, attention: ThreadAttention) {
  const { data } = await client().get(`${MAILBOX}/threads`, {
    params: { workspace_id: workspaceId, attention },
  });
  return (data?.threads ?? []) as EmailThread[];
}

export async function nextPendingMailboxThread(workspaceId: number, after?: number) {
  const { data } = await client().get(`${MAILBOX}/threads/next-pending`, {
    params: { workspace_id: workspaceId, after },
  });
  return (data?.thread ?? null) as EmailThread | null;
}

export async function composeMailboxEmail(body: {
  workspace_id: number;
  to?: string | string[];
  subject?: string;
  client_id?: number;
}): Promise<{
  thread: EmailThread;
  draft?: EmailDraft | null;
  reply_from?: ReplyFromInfo | null;
}> {
  const { data } = await client().post(`${MAILBOX}/compose`, body);
  return data;
}

export async function getMailboxThread(threadId: number, opts?: { before?: number; limit?: number }) {
  const { data } = await client().get(`${MAILBOX}/threads/${threadId}`, { params: opts });
  return data as {
    thread: EmailThread;
    messages: EmailMessage[];
    has_more?: boolean;
    draft?: EmailDraft | null;
    pending_send?: { id: number; status?: string; undo_until?: string; error_message?: string } | null;
    reply_from?: ReplyFromInfo | null;
  };
}

export async function closeMailboxThread(threadId: number) {
  await client().post(`${MAILBOX}/threads/${threadId}/close`);
}

export async function dismissMailboxThread(threadId: number) {
  await client().post(`${MAILBOX}/threads/${threadId}/dismiss`);
}

export async function dismissMailboxThreads(threadIds: number[]) {
  if (threadIds.length === 1) {
    await dismissMailboxThread(threadIds[0]);
    return;
  }
  await client().post(`${MAILBOX}/threads/dismiss`, { thread_ids: threadIds });
}

export async function undismissMailboxThread(threadId: number) {
  await client().post(`${MAILBOX}/threads/${threadId}/undismiss`);
}

/** @deprecated Use dismissMailboxThread — archive aliases remain on the API for compatibility. */
export async function archiveMailboxThread(threadId: number) {
  return dismissMailboxThread(threadId);
}

/** @deprecated Use dismissMailboxThreads */
export async function archiveMailboxThreads(threadIds: number[]) {
  return dismissMailboxThreads(threadIds);
}

/** @deprecated Use undismissMailboxThread */
export async function unarchiveMailboxThread(threadId: number) {
  return undismissMailboxThread(threadId);
}

export async function generateMailboxDraft(threadId: number, body: GenerateDraftBody) {
  const { data } = await client().post(`${MAILBOX}/threads/${threadId}/drafts/generate`, body);
  return data as {
    draft: EmailDraft;
    thread?: EmailThread;
    reply_from?: ReplyFromInfo | null;
    error?: string;
    code?: string;
  };
}

export async function analyzeMailboxThread(threadId: number) {
  const { data } = await client().post(`${MAILBOX}/threads/${threadId}/analyze`);
  return data as { analysis: ThreadAnalysis; cached?: boolean };
}

export async function researchAndGenerateMailboxDraft(threadId: number, body: ResearchGenerateBody) {
  const { data } = await client().post(`${MAILBOX}/threads/${threadId}/research-and-generate`, body);
  return data as {
    draft: EmailDraft;
    thread?: EmailThread;
    reply_from?: ReplyFromInfo | null;
    research?: unknown[];
    overall_status?: string;
    research_note?: string;
    truncated?: boolean;
    error?: string;
    code?: string;
  };
}

export async function patchMailboxDraft(draftId: number, body: Record<string, unknown>) {
  const { data } = await client().patch(`${MAILBOX}/drafts/${draftId}`, body);
  return data;
}

export async function deleteMailboxDraft(draftId: number) {
  const { data } = await client().delete(`${MAILBOX}/drafts/${draftId}`);
  return data;
}

export async function sendMailboxDraft(draftId: number, body?: Record<string, unknown>) {
  const { data } = await client().post(`${MAILBOX}/drafts/${draftId}/send`, body ?? {});
  return data as {
    pending_send?: { id: number };
    undo_until?: string;
    undo_seconds?: number;
  };
}

export async function undoMailboxSend(pendingId: number) {
  await client().post(`${MAILBOX}/pending-sends/${pendingId}/undo`);
}

export async function reconcileMailboxSend(pendingId: number) {
  const { data } = await client().post(`${MAILBOX}/pending-sends/${pendingId}/reconcile`);
  return data;
}

export async function syncMailbox(workspaceId: number) {
  const { data } = await client().post(`${MAILBOX}/sync`, { workspace_id: workspaceId });
  return data;
}

export type NeedsReplySensitivity = 'conservative' | 'balanced' | 'aggressive';

export async function getMailboxSettings(workspaceId: number) {
  const { data } = await client().get(`${MAILBOX}/settings`, { params: { workspace_id: workspaceId } });
  return data as {
    allowed_senders?: string[];
    subject_patterns?: string[];
    needs_reply_sensitivity?: NeedsReplySensitivity;
    grabdocs_research_enabled?: boolean | null;
    workspace_search_expanded?: boolean | null;
    undo_send_seconds?: number;
    [key: string]: unknown;
  };
}

export async function patchMailboxSettings(body: Record<string, unknown>) {
  const { data } = await client().patch(`${MAILBOX}/settings`, body);
  return data;
}

export async function addDraftAttachmentFile(draftId: number, file: { uri: string; name: string; type?: string }) {
  const form = new FormData();
  form.append('file', { uri: file.uri, name: file.name, type: file.type || 'application/octet-stream' } as any);
  const { data } = await client().post(`${MAILBOX}/drafts/${draftId}/attachments`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function addDraftAttachmentFileId(draftId: number, fileId: number) {
  const form = new FormData();
  form.append('file_id', String(fileId));
  const { data } = await client().post(`${MAILBOX}/drafts/${draftId}/attachments`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

/** Download inbound message attachment bytes to a cache file for in-app preview. */
export async function downloadMessageAttachment(
  attId: number,
  filenameHint?: string
): Promise<{ uri: string; mime: string; filename: string }> {
  const FileSystem = await import('expo-file-system/legacy');
  const { API_BASE_URL, STORAGE_KEYS } = await import('../constants/Config');
  const { secureStorage } = await import('../utils/storage');

  const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
  const filename = (filenameHint || `attachment-${attId}`).replace(/[\\/:*?"<>|]/g, '_');
  const safe = filename.replace(/\s+/g, '_').slice(0, 80);
  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!dir) throw new Error('No cache directory');
  const uri = `${dir}email_att_${attId}_${Date.now()}_${safe}`;
  const url = `${API_BASE_URL}${MAILBOX}/message-attachments/${attId}/content`;
  const result = await FileSystem.downloadAsync(url, uri, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (result.status < 200 || result.status >= 300) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    throw new Error('Could not load attachment');
  }
  const mime = (result.headers?.['Content-Type'] || result.headers?.['content-type'] || 'application/octet-stream')
    .split(';')[0]
    .trim();
  if (mime.includes('application/json')) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    throw new Error('Could not load attachment');
  }
  return { uri: result.uri, mime, filename };
}

export async function deleteDraftAttachment(draftId: number, attId: number) {
  await client().delete(`${MAILBOX}/drafts/${draftId}/attachments/${attId}`);
}

export async function searchGrabDocsFiles(query: string, workspaceId?: number) {
  const res = await apiClient.getFiles(1, 20, query.trim() || undefined, undefined, workspaceId);
  const files = (res as any)?.files ?? (res as any)?.data?.files ?? (res as any)?.data ?? [];
  return (Array.isArray(files) ? files : []) as { id: number; name?: string; original_filename?: string }[];
}
