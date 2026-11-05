import { Platform } from 'react-native';
import { STORAGE_KEYS } from '../constants/Config';
import { apiClient } from '../services/api';
import { auditPdfUrl, certificatePdfUrl, getEnvelope } from '../services/envelopeApi';
import { getFillableTemplate } from '../services/fillableApi';
import type { Envelope, EnvelopeDocument } from '../types/signature';
import { secureStorage } from './storage';

function isSignerDocument(doc: EnvelopeDocument): boolean {
  return doc.source_type !== 'attachment' && doc.document_role !== 'reference';
}

async function fileFromFillableTemplate(
  templateId: number,
  fallbackName: string,
): Promise<{ id: number; name: string } | null> {
  const template = await getFillableTemplate(templateId);
  if (!template.file_id) return null;
  return { id: template.file_id, name: fallbackName || template.name || 'Original document' };
}

/**
 * Unsigned source file for an envelope.
 * Fillable documents use the template PDF. Attachments use the send-time snapshot,
 * then the library file. source_snapshot_id is a snapshot row, not a files.id.
 */
export async function resolveEnvelopeOriginalFile(
  envelope: Envelope,
): Promise<{ id: number; name: string } | null> {
  const full = envelope.documents?.length
    ? envelope
    : (await getEnvelope(envelope.public_id ?? envelope.id)).envelope;
  const docs = [...(full.documents ?? [])].sort((a, b) => a.order_index - b.order_index);
  const signerDocs = docs.filter(isSignerDocument);
  const ordered = signerDocs.length > 0 ? signerDocs : docs;

  for (const doc of ordered) {
    const name = doc.display_name || full.title || 'Original document';
    if (doc.source_type === 'attachment') {
      const fileId = doc.attachment_snapshot_file_id ?? doc.attachment_source_file_id ?? null;
      if (fileId) return { id: fileId, name };
      continue;
    }
    if (doc.fillable_template_id) {
      const file = await fileFromFillableTemplate(doc.fillable_template_id, name);
      if (file) return file;
    }
  }

  const legacyTemplateId = (full as Envelope & { fillable_template_id?: number }).fillable_template_id;
  if (legacyTemplateId) {
    return fileFromFillableTemplate(legacyTemplateId, full.title || 'Original document');
  }
  return null;
}

/** Prefer merged PDF when the envelope has multiple documents. */
export function envelopeFinalFileId(envelope: Envelope): number | null {
  const id = envelope.merged_final_file_id ?? envelope.final_file_id ?? null;
  return id != null ? id : null;
}

export function envelopeFillableTemplateId(envelope: Envelope): number | null {
  const legacy = (envelope as Envelope & { fillable_template_id?: number }).fillable_template_id;
  if (legacy) return legacy;
  for (const doc of envelope.documents ?? []) {
    if (doc.fillable_template_id) return doc.fillable_template_id;
  }
  return null;
}

/** Ensure audit PDF exists server-side and return its files.id for DocumentViewer. */
export async function resolveEnvelopeAuditFileId(
  envelopeId: string,
  knownAuditFileId?: number | null,
): Promise<number | null> {
  if (knownAuditFileId) return knownAuditFileId;

  const envelope = (await getEnvelope(envelopeId)).envelope;
  if (envelope.audit_file_id) return envelope.audit_file_id;

  const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
  await apiClient.client.get(auditPdfUrl(envelopeId), {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Platform': Platform.OS,
    },
    responseType: 'arraybuffer',
    timeout: 120000,
  });

  const refreshed = (await getEnvelope(envelopeId)).envelope;
  return refreshed.audit_file_id ?? null;
}

/** Ensure completion certificate PDF exists and return its files.id for DocumentViewer. */
export async function resolveEnvelopeCertificateFileId(
  envelopeId: string,
  knownCertificateFileId?: number | null,
): Promise<number | null> {
  if (knownCertificateFileId) return knownCertificateFileId;

  const envelope = (await getEnvelope(envelopeId)).envelope;
  if (envelope.certificate_file_id) return envelope.certificate_file_id;

  const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
  await apiClient.client.get(certificatePdfUrl(envelopeId), {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Platform': Platform.OS,
    },
    responseType: 'arraybuffer',
    timeout: 120000,
  });

  const refreshed = (await getEnvelope(envelopeId)).envelope;
  return refreshed.certificate_file_id ?? null;
}

/** Load envelope when list rows only have meta fields (no file ids). */
export async function loadEnvelopeForActions(envelope: Envelope): Promise<Envelope> {
  if (
    envelopeFinalFileId(envelope) ||
    envelope.audit_file_id ||
    envelope.certificate_file_id
  ) {
    return envelope;
  }
  return (await getEnvelope(envelope.public_id ?? envelope.id)).envelope;
}
