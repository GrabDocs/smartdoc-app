import { AxiosError, AxiosRequestConfig } from 'axios';
import { API_BASE_URL } from '../constants/Config';
import type {
  CreateEnvelopeArgs,
  Envelope,
  FieldAssignmentInput,
  RecipientInput,
  ReplaceDocumentsInput,
  SignerSessionPayload,
} from '../types/signature';
import { apiClient } from './api';

const BASE = '/api/v1/web/signature-envelopes';

export class EnvelopeApiError extends Error {
  status?: number;
  data?: unknown;
  staleRevision?: boolean;
  errorCode?: string;

  constructor(message: string, status?: number, data?: unknown) {
    super(message);
    this.name = 'EnvelopeApiError';
    this.status = status;
    this.data = data;
    this.staleRevision = status === 409;
    const payload = data as { error_code?: string } | undefined;
    this.errorCode = payload?.error_code;
  }
}

export function isPhoneVerificationRequiredError(err: unknown): boolean {
  return err instanceof EnvelopeApiError && err.errorCode === 'PHONE_VERIFICATION_REQUIRED';
}

export function makeIdempotencyKey(): string {
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function envSeg(id: string | number): string {
  return String(id).trim();
}

interface RequestOpts extends AxiosRequestConfig {
  idempotencyKey?: string;
}

async function request<T = unknown>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (opts.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
  }
  try {
    const res = await apiClient.client.request<T>({
      url: BASE + path,
      method,
      headers,
      data: opts.data,
      params: opts.params,
      timeout: opts.timeout ?? 60000,
      signal: opts.signal,
    });
    return res.data;
  } catch (err) {
    const ax = err as AxiosError<{ message?: string; error?: string }>;
    const status = ax.response?.status;
    // Gateway errors are effectively offline — surface a clean message instead of
    // the raw Axios "Request failed with status code 5xx" string.
    const isGatewayError = (ax as any).isOfflineGatewayError === true ||
      status === 502 || status === 503 || status === 504;
    const rawMessage =
      ax.response?.data?.message ||
      ax.response?.data?.error ||
      (!isGatewayError ? ax.message : undefined) ||
      (isGatewayError ? 'Unable to reach the server. Please check your connection.' : 'Request failed');
    throw new EnvelopeApiError(rawMessage, status, ax.response?.data);
  }
}

export type EnvelopeTab = 'all' | 'inbox' | 'sent' | 'completed' | 'drafts';

export type EnvelopeListFields = 'meta' | 'full';

export interface ListEnvelopesOptions {
  tab?: EnvelopeTab;
  limit?: number;
  offset?: number;
  fields?: EnvelopeListFields;
  q?: string;
  status?: string;
  source_type?: string;
}

export interface ListEnvelopesResponse {
  success: boolean;
  envelopes: Envelope[];
  has_more?: boolean;
  offset?: number;
  limit?: number;
}

export async function listEnvelopes(opts: EnvelopeTab | ListEnvelopesOptions = 'all') {
  const params =
    typeof opts === 'string'
      ? { tab: opts, fields: 'meta' as const, limit: 20, offset: 0 }
      : {
          tab: opts.tab ?? 'all',
          fields: opts.fields ?? 'meta',
          limit: opts.limit ?? 20,
          offset: opts.offset ?? 0,
          ...(opts.q ? { q: opts.q } : {}),
          ...(opts.status ? { status: opts.status } : {}),
          ...(opts.source_type ? { source_type: opts.source_type } : {}),
        };
  return request<ListEnvelopesResponse>('GET', '/', {
    params,
    timeout: 15000,
  });
}

export async function getEnvelope(envelopeId: string | number) {
  return request<{ success: boolean; envelope: Envelope }>('GET', `/${envSeg(envelopeId)}`);
}

export async function createEnvelope(args: CreateEnvelopeArgs, idempotencyKey?: string) {
  return request<{ success: boolean; envelope: Envelope }>('POST', '/', {
    idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
    data: args,
  });
}

export async function updateEnvelopeDraft(
  envelopeId: string | number,
  patch: Partial<CreateEnvelopeArgs>,
  idempotencyKey?: string,
) {
  return request<{ success: boolean; envelope: Envelope }>('PATCH', `/${envSeg(envelopeId)}`, {
    idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
    data: patch,
  });
}

export async function deleteEnvelopeDraft(envelopeId: string | number) {
  return request<{ success: boolean; deleted: boolean }>('DELETE', `/${envSeg(envelopeId)}`);
}

export async function duplicateEnvelope(
  envelopeId: string | number,
  title?: string,
  idempotencyKey?: string,
) {
  return request<{ success: boolean; envelope: Envelope }>('POST', `/${envSeg(envelopeId)}/duplicate`, {
    idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
    data: title ? { title } : {},
  });
}

export async function putRecipients(
  envelopeId: string | number,
  recipients: RecipientInput[],
  idempotencyKey?: string,
) {
  return request<{ success: boolean; envelope: Envelope }>('PUT', `/${envSeg(envelopeId)}/recipients`, {
    idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
    data: { recipients },
  });
}

export async function replaceDocuments(
  envelopeId: string | number,
  documents: ReplaceDocumentsInput[],
  idempotencyKey?: string,
) {
  return request<{ success: boolean; envelope: Envelope }>('PUT', `/${envSeg(envelopeId)}/documents`, {
    idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
    data: { documents },
  });
}

export async function putFieldAssignments(
  envelopeId: string | number,
  fields: FieldAssignmentInput[],
  idempotencyKey?: string,
) {
  return request<{ success: boolean; envelope: Envelope }>(
    'PUT',
    `/${envSeg(envelopeId)}/field-assignments`,
    {
      idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
      data: { fields },
    },
  );
}

export async function sendEnvelope(
  envelopeId: string | number,
  opts?: { acknowledgeOnly?: boolean; idempotencyKey?: string },
) {
  return request<{ success: boolean; envelope: Envelope; notified?: unknown[] }>(
    'POST',
    `/${envSeg(envelopeId)}/send`,
    {
      idempotencyKey: opts?.idempotencyKey ?? makeIdempotencyKey(),
      data: opts?.acknowledgeOnly ? { acknowledge_only: true } : {},
    },
  );
}

export async function voidEnvelope(
  envelopeId: string | number,
  reason?: string,
  idempotencyKey?: string,
) {
  return request<{ success: boolean; envelope: Envelope }>('POST', `/${envSeg(envelopeId)}/void`, {
    idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
    data: { reason },
  });
}

export async function resendRecipientInvite(
  envelopeId: string | number,
  recipientId: number,
  idempotencyKey?: string,
) {
  return request<{ success: boolean; sent: boolean; message: string }>(
    'POST',
    `/${envSeg(envelopeId)}/recipients/${recipientId}/resend`,
    { idempotencyKey: idempotencyKey ?? makeIdempotencyKey(), data: {} },
  );
}

export function finalPdfUrl(envelopeId: string | number, documentId?: number): string {
  const base = `${API_BASE_URL}${BASE}/${envSeg(envelopeId)}/final-pdf`;
  return documentId != null ? `${base}?doc=${documentId}` : base;
}

export function auditPdfUrl(envelopeId: string | number): string {
  return `${API_BASE_URL}${BASE}/${envSeg(envelopeId)}/audit-pdf`;
}

export function certificatePdfUrl(envelopeId: string | number): string {
  return `${API_BASE_URL}${BASE}/${envSeg(envelopeId)}/certificate-pdf`;
}

// Session signer
export async function getSignSession(envelopeId: string | number) {
  return request<SignerSessionPayload>('GET', `/${envSeg(envelopeId)}/sign-session`);
}

export async function sessionAutosave(
  envelopeId: string | number,
  values: Record<string, unknown>,
  sessionRevision?: number,
  signal?: AbortSignal,
) {
  return request<{ success: boolean; saved: number }>(
    'POST',
    `/${envSeg(envelopeId)}/session-autosave`,
    {
      signal,
      data: {
        values,
        ...(sessionRevision != null ? { session_generated_at_revision: sessionRevision } : {}),
      },
    },
  );
}

export async function sessionSubmit(
  envelopeId: string | number,
  payload: {
    values: Record<string, unknown>;
    doc_pages?: Record<string, string[]>;
    page_images?: string[];
    timezone?: string;
    session_generated_at_revision?: number;
  },
  idempotencyKey?: string,
) {
  return request<{ success: boolean; completed: boolean; envelope_status: string }>(
    'POST',
    `/${envSeg(envelopeId)}/session-submit`,
    {
      idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
      data: payload,
    },
  );
}

export async function sessionDecline(
  envelopeId: string | number,
  reason?: string,
  idempotencyKey?: string,
) {
  return request<{ success: boolean; envelope_status: string }>(
    'POST',
    `/${envSeg(envelopeId)}/session-decline`,
    {
      idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
      data: { reason },
    },
  );
}

export async function sessionAttachmentViewed(envelopeId: string | number, documentKey: string) {
  return request<{ success: boolean }>(
    'POST',
    `/${envSeg(envelopeId)}/session-attachment-viewed`,
    { data: { document_key: documentKey } },
  );
}

// Token signer
export async function getSignView(token: string) {
  return request<SignerSessionPayload>('GET', `/sign/${encodeURIComponent(token)}`);
}

export async function tokenAutosave(
  token: string,
  values: Record<string, unknown>,
  sessionRevision?: number,
  signal?: AbortSignal,
) {
  return request<{ success: boolean; saved: number; envelope_revision?: number }>(
    'POST',
    `/sign/${encodeURIComponent(token)}/autosave`,
    {
      signal,
      data: {
        values,
        ...(sessionRevision != null ? { session_generated_at_revision: sessionRevision } : {}),
      },
    },
  );
}

export async function tokenSubmit(
  token: string,
  payload: {
    values: Record<string, unknown>;
    doc_pages?: Record<string, string[]>;
    page_images?: string[];
    timezone?: string;
    session_generated_at_revision?: number;
  },
  idempotencyKey?: string,
) {
  return request<{ success: boolean; completed: boolean; envelope_status: string }>(
    'POST',
    `/sign/${encodeURIComponent(token)}/submit`,
    {
      idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
      data: payload,
    },
  );
}

export async function tokenDecline(token: string, reason?: string, idempotencyKey?: string) {
  return request<{ success: boolean; envelope_status: string }>(
    'POST',
    `/sign/${encodeURIComponent(token)}/decline`,
    {
      idempotencyKey: idempotencyKey ?? makeIdempotencyKey(),
      data: { reason },
    },
  );
}

export async function tokenAttachmentViewed(token: string, documentKey: string) {
  return request<{ success: boolean }>(
    'POST',
    `/sign/${encodeURIComponent(token)}/attachment-viewed`,
    { data: { document_key: documentKey } },
  );
}

export interface SignerOtpRequestResponse {
  success: boolean;
  sent: boolean;
  phone_masked?: string;
  expires_in_minutes?: number;
}

export interface SignerOtpVerifyResponse {
  success: boolean;
  phone_verified: boolean;
}

// Signer phone OTP (envelope signing — not login OTP)
export async function sessionRequestOtp(envelopeId: string | number) {
  return request<SignerOtpRequestResponse>('POST', `/${envSeg(envelopeId)}/session-request-otp`, {
    data: {},
  });
}

export async function sessionVerifyOtp(envelopeId: string | number, code: string) {
  return request<SignerOtpVerifyResponse>('POST', `/${envSeg(envelopeId)}/session-verify-otp`, {
    data: { code },
  });
}

export async function tokenRequestOtp(token: string) {
  return request<SignerOtpRequestResponse>(
    'POST',
    `/sign/${encodeURIComponent(token)}/request-otp`,
    { data: {} },
  );
}

export async function tokenVerifyOtp(token: string, code: string) {
  return request<SignerOtpVerifyResponse>(
    'POST',
    `/sign/${encodeURIComponent(token)}/verify-otp`,
    { data: { code } },
  );
}
