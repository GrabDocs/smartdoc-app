/**
 * My Clients API helpers — typed wrappers around /api/v1/clients (web backend).
 */

import type { Href } from 'expo-router';
import { apiClient } from './api';

const BASE = '/api/v1/clients';
const client = () => apiClient.client;

export type ClientStatus = 'active' | 'archived';
export type ClientVisibility = 'private' | 'company';
export type IdentifierType = 'email' | 'domain' | 'inbox_alias_token' | 'tag';
export type AttentionStatus = 'needs_attention' | 'waiting' | 'on_track';
export type WaitingOnFilter = 'all' | 'client' | 'us';

export interface ClientIdentifier {
  id: number;
  client_id: number;
  identifier_type: IdentifierType;
  identifier_value: string;
  match_mode: string;
  is_learned: boolean;
  created_at: string | null;
  created_by_user_id: number | null;
}

export interface ClientItemLink {
  id: number;
  client_id: number;
  item_type: string;
  item_id: number;
  link_kind: string;
  confidence: number | null;
  match_reason: string | null;
  linked_at: string | null;
  unlinked_at: string | null;
  created_by_user_id: number | null;
  source_type?: string | null;
  source_id?: number | null;
  label?: string | null;
  file_kind?: string | null;
}

export interface AttentionItem {
  item_type?: string;
  item_id?: number;
  parent_type?: string;
  parent_id?: number;
  source_type?: string | null;
  source_id?: number | null;
  label?: string;
  action?: string;
  overdue?: boolean;
  waiting_on?: 'client' | 'us';
  attention_status?: string;
  reply_status?: string;
}

export interface OpenCounts {
  waiting_on_client: number;
  waiting_on_us: number;
  intakes_pending: number;
  file_requests_open: number;
  signatures_pending: number;
  emails_needs_reply: number;
}

export interface ClientAttention {
  status: AttentionStatus;
  waiting_on_client: AttentionItem[];
  waiting_on_us: AttentionItem[];
  next_step: AttentionItem | null;
  open_counts: OpenCounts;
}

export interface Client {
  id: number;
  user_id: number;
  company_id: number;
  workspace_id: number | null;
  display_name: string;
  status: ClientStatus;
  visibility: ClientVisibility;
  created_at: string | null;
  updated_at: string | null;
  archived_at: string | null;
  identifiers?: ClientIdentifier[];
  warnings?: string[];
  attention?: {
    status: AttentionStatus;
    next_step: AttentionItem | null;
    open_counts: OpenCounts;
  };
  link?: ClientItemLink;
}

export interface AttentionQueueItem {
  client: Client;
  attention: ClientAttention;
}

export interface TimelineEntry {
  source: string;
  at: string | null;
  action?: string;
  item_type?: string | null;
  item_id?: number | null;
  link_kind?: string | null;
  match_reason?: string | null;
  reason_code?: string | null;
  performed_by_user_id?: number | null;
  label?: string | null;
  source_type?: string | null;
  source_id?: number | null;
}

export interface ClientCollectionSchedule {
  id: number;
  title: string;
  status: string;
  frequency: string;
  cadence_summary?: string;
  next_run_at?: string | null;
  due_after_days?: number;
  estimated_next_due_at?: string | null;
  current_collection?: {
    id: number;
    title: string;
    status: string;
    progress?: { received: number; total: number; percent: number };
    period_label?: string | null;
  } | null;
  collections?: Array<{
    id: number;
    title: string;
    period_label?: string | null;
    status: string;
    progress?: { received: number; total: number; percent: number };
    scheduled_for?: string | null;
    due_at?: string | null;
    sent_at?: string | null;
  }>;
}

export interface ClientOverview {
  client: Client;
  attention: ClientAttention;
  next_step: AttentionItem | null;
  waiting_on_client: AttentionItem[];
  waiting_on_us: AttentionItem[];
  last_activity?: TimelineEntry | null;
  workflows: {
    link_counts: Record<string, number>;
    open_counts: OpenCounts;
  };
  collections?: ClientCollectionSchedule[];
}

export interface DossierBucket {
  count: number;
  links: ClientItemLink[];
}

export interface ClientDossier {
  client: Client;
  by_type: Record<string, DossierBucket>;
  total_links: number;
  scoped_count?: number;
  count?: number;
  total_count?: number;
  limit?: number;
  offset?: number;
  has_more?: boolean;
  item_types?: string[] | null;
}

export interface PaginatedClients {
  clients: Client[];
  count: number;
  total_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface PaginatedAttention {
  items: AttentionQueueItem[];
  count: number;
  total_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface PaginatedTimeline {
  timeline: TimelineEntry[];
  count: number;
  total_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ClientFinancialItem {
  file_id: number;
  file_kind: string;
  filename: string;
  label: string;
  party?: string | null;
  amount: number | null;
  amount_known: boolean;
  currency: string;
  date?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  link_id?: number | null;
  link_kind?: string | null;
}

export interface ClientFinancials {
  client?: Client;
  items: ClientFinancialItem[];
  count: number;
  total_count?: number;
  limit?: number;
  offset?: number;
  has_more?: boolean;
  counted_in_total: number;
  unknown_amount_count: number;
  totals_by_currency: Record<string, number>;
  totals_by_kind?: Record<string, Record<string, number>>;
  receipts_total?: number;
  invoices_total?: number;
  total_amount: number;
  primary_currency: string;
  multi_currency: boolean;
}

export type ClientsPickerData = {
  count: number;
  recent: Client[];
  clients: Client[];
};

let pickerPrefetch: Promise<ClientsPickerData> | null = null;
let pickerPrefetchAt = 0;
const PICKER_PREFETCH_TTL_MS = 30_000;

export function invalidateClientsPickerCache(): void {
  pickerPrefetch = null;
  pickerPrefetchAt = 0;
}

export async function getClientsCount(): Promise<number> {
  const res = await client().get<{ count: number }>(`${BASE}/count`);
  return res.data.count ?? 0;
}

export async function listClients(params?: {
  q?: string;
  status?: 'active' | 'archived' | 'all';
  attention_only?: boolean;
  include_attention?: boolean;
  limit?: number;
  offset?: number;
}): Promise<PaginatedClients> {
  const res = await client().get<PaginatedClients>(BASE, {
    params: {
      q: params?.q || undefined,
      status: params?.status || 'active',
      attention_only: params?.attention_only ? '1' : undefined,
      include_attention: params?.include_attention ? '1' : undefined,
      limit: params?.limit,
      offset: params?.offset,
    },
  });
  return {
    clients: res.data.clients || [],
    count: res.data.count ?? (res.data.clients || []).length,
    total_count: res.data.total_count ?? (res.data.clients || []).length,
    limit: res.data.limit ?? params?.limit ?? 40,
    offset: res.data.offset ?? params?.offset ?? 0,
    has_more: Boolean(res.data.has_more),
  };
}

export async function getRecentClients(): Promise<Client[]> {
  const res = await client().get<{ clients: Client[] }>(`${BASE}/recent`);
  return res.data.clients || [];
}

export async function prefetchClientsPicker(opts?: {
  force?: boolean;
}): Promise<ClientsPickerData> {
  const now = Date.now();
  if (
    !opts?.force &&
    pickerPrefetch &&
    now - pickerPrefetchAt < PICKER_PREFETCH_TTL_MS
  ) {
    return pickerPrefetch;
  }
  pickerPrefetchAt = now;
  pickerPrefetch = (async () => {
    const [count, recent, listRes] = await Promise.all([
      getClientsCount(),
      getRecentClients().catch(() => [] as Client[]),
      listClients({ status: 'active', limit: 100 }),
    ]);
    return {
      count: count ?? listRes.count ?? listRes.clients?.length ?? 0,
      recent: recent || [],
      clients: listRes.clients || [],
    };
  })();
  try {
    return await pickerPrefetch;
  } catch (err) {
    pickerPrefetch = null;
    pickerPrefetchAt = 0;
    throw err;
  }
}

export async function getAttentionQueue(
  waitingOn: WaitingOnFilter = 'all',
  params?: { limit?: number; offset?: number }
): Promise<PaginatedAttention> {
  const res = await client().get<PaginatedAttention>(`${BASE}/attention`, {
    params: {
      waiting_on: waitingOn,
      limit: params?.limit,
      offset: params?.offset,
    },
  });
  return {
    items: res.data.items || [],
    count: res.data.count ?? (res.data.items || []).length,
    total_count: res.data.total_count ?? (res.data.items || []).length,
    limit: res.data.limit ?? params?.limit ?? 20,
    offset: res.data.offset ?? params?.offset ?? 0,
    has_more: Boolean(res.data.has_more),
  };
}

export async function createClient(data: {
  display_name: string;
  email?: string;
  emails?: string[];
  tags?: string[];
  visibility?: ClientVisibility;
  workspace_id?: number;
}): Promise<Client> {
  const emails =
    data.emails || (data.email?.trim() ? [data.email.trim()] : undefined);
  const res = await client().post<Client>(BASE, {
    display_name: data.display_name,
    emails,
    tags: data.tags,
    visibility: data.visibility,
    workspace_id: data.workspace_id,
  });
  invalidateClientsPickerCache();
  return res.data;
}

export async function getClient(clientId: number): Promise<Client> {
  const res = await client().get<Client>(`${BASE}/${clientId}`);
  return res.data;
}

export async function updateClient(
  clientId: number,
  data: Partial<{
    display_name: string;
    visibility: ClientVisibility;
    status: ClientStatus;
    workspace_id: number | null;
  }>
): Promise<Client> {
  const res = await client().put<Client>(`${BASE}/${clientId}`, data);
  return res.data;
}

export async function archiveClient(clientId: number): Promise<Client> {
  const res = await client().post<Client>(`${BASE}/${clientId}/archive`);
  invalidateClientsPickerCache();
  return res.data;
}

export async function restoreClient(clientId: number): Promise<Client> {
  const res = await client().post<Client>(`${BASE}/${clientId}/restore`);
  invalidateClientsPickerCache();
  return res.data;
}

export async function setItemClients(data: {
  client_ids: number[];
  item_type: string;
  item_id: number;
}): Promise<{ links: ClientItemLink[]; count: number }> {
  const res = await client().post<{ links: ClientItemLink[]; count: number }>(
    `${BASE}/links`,
    data
  );
  return res.data;
}

export async function unlinkItemClient(data: {
  link_id?: number;
  client_id?: number;
  item_type?: string;
  item_id?: number;
}): Promise<{ ok: boolean; link: ClientItemLink }> {
  const res = await client().post<{ ok: boolean; link: ClientItemLink }>(
    `${BASE}/links/unlink`,
    data
  );
  return res.data;
}

export async function getClientsForItem(
  itemType: string,
  itemId: number
): Promise<Client[]> {
  const res = await client().get<{ clients: Client[]; count: number }>(
    `${BASE}/item/${itemType}/${itemId}/clients`
  );
  return res.data.clients || [];
}

export async function listIdentifiers(
  clientId: number
): Promise<ClientIdentifier[]> {
  const res = await client().get<{ identifiers: ClientIdentifier[] }>(
    `${BASE}/${clientId}/identifiers`
  );
  return res.data.identifiers || [];
}

export async function addIdentifier(
  clientId: number,
  data: {
    identifier_type: IdentifierType;
    identifier_value: string;
    match_mode?: string;
  }
): Promise<ClientIdentifier> {
  const res = await client().post<ClientIdentifier>(
    `${BASE}/${clientId}/identifiers`,
    data
  );
  return res.data;
}

export async function deleteIdentifier(identifierId: number): Promise<void> {
  await client().delete(`${BASE}/identifiers/${identifierId}`);
}

export async function acceptSuggestedIdentifier(
  identifierId: number
): Promise<ClientIdentifier> {
  const res = await client().post<ClientIdentifier>(
    `${BASE}/identifiers/${identifierId}/accept`
  );
  return res.data;
}

export async function rejectSuggestedIdentifier(
  identifierId: number
): Promise<void> {
  await client().post(`${BASE}/identifiers/${identifierId}/reject`);
}

export async function getClientOverview(
  clientId: number
): Promise<ClientOverview> {
  const res = await client().get<ClientOverview>(`${BASE}/${clientId}/overview`);
  return res.data;
}

export async function getClientTimeline(
  clientId: number,
  params?: { limit?: number; offset?: number }
): Promise<PaginatedTimeline> {
  const res = await client().get<PaginatedTimeline>(
    `${BASE}/${clientId}/timeline`,
    {
      params: {
        limit: params?.limit ?? 30,
        offset: params?.offset ?? 0,
      },
    }
  );
  return {
    timeline: res.data.timeline || [],
    count: res.data.count ?? (res.data.timeline || []).length,
    total_count: res.data.total_count ?? (res.data.timeline || []).length,
    limit: res.data.limit ?? params?.limit ?? 30,
    offset: res.data.offset ?? params?.offset ?? 0,
    has_more: Boolean(res.data.has_more),
  };
}

export async function getClientDossier(
  clientId: number,
  params?: { limit?: number; offset?: number; item_types?: string[] }
): Promise<ClientDossier> {
  const res = await client().get<ClientDossier>(`${BASE}/${clientId}/dossier`, {
    params: {
      limit: params?.limit ?? 30,
      offset: params?.offset ?? 0,
      item_types: params?.item_types?.length
        ? params.item_types.join(',')
        : undefined,
    },
  });
  return res.data;
}

export async function getClientFinancials(
  clientId: number,
  params?: { limit?: number; offset?: number }
): Promise<ClientFinancials> {
  const res = await client().get<ClientFinancials>(
    `${BASE}/${clientId}/financials`,
    {
      params: {
        limit: params?.limit ?? 40,
        offset: params?.offset ?? 0,
      },
    }
  );
  return res.data;
}

export function linkKindLabel(linkKind: string | null | undefined): string {
  switch ((linkKind || '').toLowerCase()) {
    case 'manual':
      return 'Linked manually';
    case 'inherited_channel':
      return 'Linked via File Request / Intake / Alias';
    case 'auto_email':
      return 'Linked via email';
    case 'auto_alias':
      return 'Linked via inbox alias';
    case 'auto_tag':
      return 'Linked via tag';
    default:
      return linkKind ? `Linked (${linkKind})` : 'Linked';
  }
}

/** Mobile deep-link for attention / dossier items. */
export function itemHref(
  itemType?: string | null,
  itemId?: number | null,
  opts?: {
    parentId?: number | null;
    sourceType?: string | null;
    sourceId?: number | null;
  }
): Href | null {
  if (!itemType || itemId == null) return null;
  const parentId = opts?.parentId;
  switch (itemType) {
    case 'intake':
      return `/intake/${itemId}` as Href;
    case 'intake_item':
      return (parentId ? `/intake/${parentId}` : '/intake') as Href;
    case 'intake_schedule':
      return `/intake/schedules/${itemId}` as Href;
    case 'file':
      return `/(tabs)/documents` as Href;
    case 'signature_envelope':
      return `/signatures/${itemId}` as Href;
    case 'email_thread':
      return `/email-sync/thread/${itemId}` as Href;
    case 'file_upload_link':
      return `/upload-links/${itemId}` as Href;
    case 'note':
      if (opts?.sourceType === 'calendar_event' && opts?.sourceId) {
        return `/calendar/${opts.sourceId}` as Href;
      }
      return '/calendar' as Href;
    case 'chat_history':
      return '/(tabs)/chats' as Href;
    case 'user_chat':
      return `/user-chat?chat_id=${itemId}` as Href;
    case 'form':
      return '/forms' as Href;
    default:
      return null;
  }
}

export function primaryEmail(c: Client | null | undefined): string | null {
  const emails = (c?.identifiers || []).filter((i) => i.identifier_type === 'email');
  return emails[0]?.identifier_value || null;
}

export function parseChatHistoryNumericId(
  chatHistoryId: string | number | null | undefined
): number | null {
  if (chatHistoryId == null || chatHistoryId === '') return null;
  const s = String(chatHistoryId);
  const m = s.match(/(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function attentionStatusLabel(status?: AttentionStatus | string | null): string {
  switch (status) {
    case 'needs_attention':
      return 'Needs attention';
    case 'waiting':
      return 'Waiting';
    case 'on_track':
    default:
      return 'On track';
  }
}

/** Open ChatGD composer scoped to a client (or unscoped Search/Ask). */
export function chatGdAskHref(opts?: {
  clientId?: number;
  clientName?: string;
}): Href {
  const q = new URLSearchParams();
  q.set('openStartNew', '1');
  if (opts?.clientId != null && Number.isFinite(opts.clientId)) {
    q.set('client_id', String(opts.clientId));
    if (opts.clientName?.trim()) q.set('client_name', opts.clientName.trim());
  }
  return (`/(tabs)/chats?${q.toString()}` as unknown) as Href;
}
