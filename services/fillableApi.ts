import type { WizardField } from '../types/signature';
import { sanitizeDisplayFilename } from '../utils/displayFilename';
import { apiClient } from './api';
import { normalizeField, sortFieldsForSave, GEOMETRY_SCHEMA_VERSION } from '../utils/fillable';

const BASE = '/api/v1/web/fillable-templates';

export interface FillableTemplate {
  id: number;
  /** Opaque public id — preferred over numeric id in API paths. */
  public_id?: string;
  name: string;
  file_id?: number;
  json_fields?: { version?: number; fields?: WizardField[] };
  page_images?: string[];
  page_count?: number;
  active_envelope_id?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface FillableTemplateListItem {
  id: number;
  public_id?: string;
  name: string;
  file_id?: number;
  created_at?: string;
  updated_at?: string;
  active_envelope_id?: number | null;
  active_envelope_public_id?: string | null;
}

function fillableApiError(err: unknown, fallback: string): Error {
  if (err && typeof err === 'object' && 'response' in err) {
    const ax = err as {
      response?: { data?: { message?: string; error_code?: string }; status?: number };
    };
    const msg = ax.response?.data?.message;
    if (typeof msg === 'string' && msg.trim()) return new Error(msg.trim());
    if (ax.response?.status === 401) return new Error('Please sign in again.');
    if (ax.response?.status === 403) return new Error('You do not have access to this document.');
  }
  if (err instanceof Error && err.message && !/status code \d{3}/.test(err.message)) {
    return err;
  }
  return new Error(fallback);
}

function isNonRetryableFillableError(err: unknown): boolean {
  if (!(err && typeof err === 'object' && 'response' in err)) return false;
  const ax = err as {
    response?: { data?: { error_code?: string }; status?: number };
  };
  const status = ax.response?.status;
  const code = ax.response?.data?.error_code;
  if (code === 'FILL_SOURCE_UNSUPPORTED' || code === 'FILL_SOURCE_UNAVAILABLE') return true;
  return status === 400 || status === 422;
}

/** Find or create a fillable template for an account file. */
export async function resolveFillableTemplateForFile(
  fileId: number,
  displayName: string,
): Promise<number> {
  const name = sanitizeDisplayFilename(displayName);
  const templates = await listFillableTemplates();
  const existing = templates.find((t) => t.file_id === fileId);
  if (existing) return existing.id;
  const created = await createFillableTemplate(fileId, name);
  return created.id;
}

const FILLABLE_READY_POLL_MS = 1500;
/** Office conversion can exceed ~36s; wait up to ~2 minutes. */
const FILLABLE_READY_MAX_ATTEMPTS = 80;

/**
 * Poll until page images exist for an existing fillable template (PDF/rasterization ready).
 */
export async function waitForFillablePageImages(
  templateId: number | string,
): Promise<FillableTemplate> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < FILLABLE_READY_MAX_ATTEMPTS; attempt++) {
    try {
      const tpl = await getFillableTemplate(templateId);
      const images = tpl.page_images ?? [];
      if (images.length > 0) {
        return tpl;
      }
    } catch (e: unknown) {
      lastError = fillableApiError(e, 'Could not prepare document preview');
      // Retry while the backend rasterizes; fail fast on permanent errors.
      const status =
        e && typeof e === 'object' && 'response' in e
          ? (e as { response?: { status?: number } }).response?.status
          : undefined;
      if (status === 401 || status === 403 || status === 404 || isNonRetryableFillableError(e)) {
        throw lastError;
      }
    }
    if (attempt < FILLABLE_READY_MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, FILLABLE_READY_POLL_MS));
    }
  }
  throw lastError ?? new Error('Document preview is still converting. Large Office files can take a couple of minutes — try again shortly.');
}

/**
 * Resolve template for a file and optionally wait until page images exist.
 * Non-PDF sources are converted server-side when the template is loaded.
 *
 * Pass `waitForPages: false` to return as soon as the template exists so UI lists
 * can update immediately after upload; callers that open the editor should wait
 * (or poll in the editor) for page images separately.
 */
export async function ensureFillableTemplateReady(
  fileId: number,
  displayName: string,
  options?: { waitForPages?: boolean },
): Promise<{ templateId: number }> {
  const templateId = await resolveFillableTemplateForFile(fileId, displayName);
  if (options?.waitForPages === false) {
    return { templateId };
  }
  await waitForFillablePageImages(templateId);
  return { templateId };
}

export interface FillableTemplateFromLibrary {
  id: number;
  public_id?: string;
  name: string;
  file_id?: number;
  updated_at?: string;
}

/** Active templates cloned from a My Files library file, newest first. */
export async function listFillableTemplatesFromLibrary(fileId: number) {
  try {
    const { data } = await apiClient.client.get<{
      success?: boolean;
      templates?: FillableTemplateFromLibrary[];
    }>(`${BASE}/from-library`, { params: { file_id: fileId } });
    return data?.templates ?? [];
  } catch (e: unknown) {
    throw fillableApiError(e, 'Could not check existing fillable templates');
  }
}

export async function listFillableTemplates(search?: string) {
  try {
    const { data } = await apiClient.client.get<{
      success?: boolean;
      templates?: FillableTemplateListItem[];
    }>(BASE, { params: { list_only: 1, search: search || undefined } });
    return data?.templates ?? [];
  } catch (e: unknown) {
    throw fillableApiError(e, 'Could not load fillable templates');
  }
}

export async function getFillableTemplate(
  id: number | string,
): Promise<FillableTemplate> {
  try {
    const { data } = await apiClient.client.get<{
      success?: boolean;
      template: FillableTemplate;
      page_images?: string[];
      page_count?: number;
      message?: string;
    }>(`${BASE}/${id}`);
    if (!data?.template) {
      throw new Error(data?.message || 'Template not found');
    }
    const template = data.template;
    return {
      ...template,
      page_images: data.page_images ?? template.page_images,
      ...(data.page_count != null ? { page_count: data.page_count } : {}),
    };
  } catch (e: unknown) {
    throw fillableApiError(e, 'Could not load document for Fill');
  }
}

export async function deleteFillableTemplate(id: number | string) {
  try {
    const { data } = await apiClient.client.delete<{ success?: boolean; message?: string }>(
      `${BASE}/${id}`,
    );
    if (data?.success === false) {
      throw new Error(data.message || 'Could not delete document');
    }
    return data;
  } catch (e: unknown) {
    throw fillableApiError(e, 'Could not delete document');
  }
}

export async function createFillableTemplate(fileId: number, name: string) {
  try {
    const { data } = await apiClient.client.post<{
      success?: boolean;
      template: FillableTemplate;
      message?: string;
    }>(BASE, { file_id: fileId, name });
    if (!data?.template?.id) {
      throw new Error(data?.message || 'Could not create fillable template');
    }
    return data.template;
  } catch (e: unknown) {
    throw fillableApiError(e, 'Could not prepare document for Fill');
  }
}

/**
 * Save fillable template fields.
 *
 * Payload contract:
 * - Normalize all coords (5dp) before sending
 * - Stable-sort live fields: page → y → x → id
 * - Include deleted fields first (with deleted: true) so backend can track revision history
 * - Strip `rev` from fields (backend assigns on its own)
 * - PATCH only on explicit user save — no auto-save
 *
 * Caller must replace local state entirely from the returned template (no merge).
 */
export async function saveFillableTemplateFields(
  id: number | string,
  liveFields: WizardField[],
  deletedFields: WizardField[],
): Promise<FillableTemplate> {
  // Normalize coords and enforce bounds on all live fields
  const normalizedLive = liveFields.map(normalizeField);
  // Stable sort live fields for deterministic JSON
  const sortedLive = sortFieldsForSave(normalizedLive);
  // Normalize deleted fields too (strip lastTouchedAt, keep deleted flag)
  const normalizedDeleted = deletedFields.map((f) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { lastTouchedAt: _lta, rev: _rev, ...rest } = f;
    return { ...rest, deleted: true };
  });
  const sortedLiveClean = sortedLive.map((f) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { lastTouchedAt: _lta, rev: _rev, ...rest } = f;
    return rest;
  });

  const payload = {
    json_fields: {
      version: GEOMETRY_SCHEMA_VERSION,
      fields: [...normalizedDeleted, ...sortedLiveClean],
    },
  };

  try {
    const { data } = await apiClient.client.patch<{
      success?: boolean;
      template: FillableTemplate;
    }>(`${BASE}/${id}`, payload);
    return data.template;
  } catch (e: unknown) {
    throw fillableApiError(e, 'Could not save template fields');
  }
}

/** @deprecated Use saveFillableTemplateFields instead */
export async function patchFillableTemplateFields(id: number, fields: WizardField[]) {
  return saveFillableTemplateFields(id, fields, []);
}
