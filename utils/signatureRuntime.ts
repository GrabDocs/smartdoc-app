import type {
  Envelope,
  EnvelopeDocument,
  EnvelopeFieldAssignment,
  NormalizedSignerSession,
  ReplaceDocumentsInput,
  RuntimeDocument,
  RuntimeField,
  SignerSessionPayload,
  SignerSourcePayload,
  WizardField,
  WizardSourceDraft,
  WizardStep,
} from '../types/signature';
import { makeFieldKey, parseFieldKey } from './fieldKeys';
import { parseAsUTC } from './timeFormatting';

function resolveSignerSourceType(source: SignerSourcePayload): SignerSourcePayload['source_type'] {
  return source.source_type ?? source.type;
}

function normalizeFormFieldType(type: string | undefined | null): string {
  if (type == null || typeof type !== 'string') return 'textbox';
  const norm = type
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ');
  const known: Record<string, string> = {
    textbox: 'textbox',
    text: 'textbox',
    'multiline textbox': 'multiline textbox',
    multiline: 'multiline textbox',
    'multiline label': 'multiline label',
    dropdown: 'dropdown',
    checkbox: 'checkbox',
    datetime: 'datetime',
    date: 'date',
    signature: 'signature',
    initials: 'initials',
  };
  if (known[norm]) return known[norm];
  if (norm === 'multi select dropdown' || norm === 'multiselect') {
    return 'multi-select dropdown';
  }
  return type.trim();
}

export function isSignFieldType(type: string | undefined | null): boolean {
  const t = normalizeFormFieldType(type);
  return t === 'signature' || t === 'initials';
}

export function isDateFieldType(type: string | undefined | null): boolean {
  const t = normalizeFormFieldType(type);
  return t === 'date' || t === 'datetime';
}

/** Read display text from a date field value (string or `{ display, iso }` from Phase 6). */
export function dateFieldDisplayText(val: unknown): string {
  if (typeof val === 'string' && val.trim()) return val.trim();
  if (!val || typeof val !== 'object' || Array.isArray(val)) return '';
  const o = val as Record<string, unknown>;
  if (typeof o.display === 'string' && o.display.trim()) return o.display.trim();
  if (typeof o.iso === 'string' && o.iso.trim()) {
    const d = parseAsUTC(o.iso);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    }
  }
  return '';
}

/**
 * Client-side date autofill matching backend Phase 6 shape so the value
 * shows on the canvas and survives compositing before submit.
 */
export function buildSignerAutoFillDate(now: Date = new Date()): {
  iso: string;
  display: string;
  timezone: string;
} {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const display = now.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return {
    iso: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    display,
    timezone,
  };
}

export function isFieldEditable(editableKeys: ReadonlySet<string>, fieldKey: string): boolean {
  if (editableKeys.has(fieldKey)) return true;
  const colon = fieldKey.lastIndexOf(':');
  const bareId = colon > 0 ? fieldKey.slice(0, colon) : fieldKey;
  if (editableKeys.has(bareId)) return true;
  return editableKeys.has(makeFieldKey(bareId, 1));
}

function structuredFieldKey(sectionName: string, rowId: string, col: string): string {
  const s = (sectionName || '').replace(/\s+/g, '_').toLowerCase();
  const r = (rowId || '').replace(/\s+/g, '_').toLowerCase();
  const c = (typeof col === 'string' ? col : '').replace(/\s+/g, '_').toLowerCase();
  return `${s}_${r}_${c}`;
}

function coerceFormJsonFields(raw: unknown): WizardField[] {
  if (!raw) return [];
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'object') {
    const fields = (raw as { fields?: unknown }).fields;
    if (Array.isArray(fields)) list = fields;
  }
  return list
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && !Array.isArray(f))
    .filter((f) => {
      const id = f.id ?? f.name ?? f.key;
      return typeof id === 'string' && id.length > 0 && id !== '_structured_placeholder' && !f.deleted;
    })
    .map((f) => ({
      id: String(f.id ?? f.name ?? f.key ?? ''),
      rev: typeof f.rev === 'number' && Number.isFinite(f.rev) ? f.rev : 1,
      type: normalizeFormFieldType(String(f.type ?? 'textbox')),
      label: String(f.title ?? f.label ?? f.name ?? f.id ?? ''),
      required: Boolean(f.required),
      page: typeof f.page === 'number' ? f.page : undefined,
      x: typeof f.x === 'number' ? f.x : undefined,
      y: typeof f.y === 'number' ? f.y : undefined,
      w: typeof f.w === 'number' ? f.w : undefined,
      h: typeof f.h === 'number' ? f.h : undefined,
    }))
    .filter((f) => f.id);
}

function structuredSchemaToWizardFields(settings?: Record<string, unknown>): WizardField[] {
  const schema = settings?.structured_schema as
    | { sections?: Array<Record<string, unknown>> }
    | undefined;
  if (!Array.isArray(schema?.sections) || schema.sections.length === 0) return [];

  const out: WizardField[] = [];
  for (const section of schema.sections) {
    const sectionType = String(section.type ?? '');
    const sectionName = String(section.name ?? '');
    if (sectionType === 'grid') {
      const rows = Array.isArray(section.rows) ? section.rows : [];
      const columns = Array.isArray(section.columns) ? section.columns : [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const rowRec = row as Record<string, unknown>;
        const rowId = String(rowRec.id ?? '');
        const rowLabel = String(rowRec.label ?? rowId);
        const cellTypeOverrides =
          rowRec.cellTypeOverrides && typeof rowRec.cellTypeOverrides === 'object'
            ? (rowRec.cellTypeOverrides as Record<string, string>)
            : {};
        const rowFieldType = String(rowRec.fieldType ?? 'text');
        for (const col of columns) {
          const colName = String(col);
          const cellType = normalizeFormFieldType(cellTypeOverrides[colName] ?? rowFieldType);
          const key = structuredFieldKey(sectionName, rowId, colName);
          out.push({
            id: key,
            rev: 1,
            type: cellType,
            label: `${rowLabel} / ${colName}`,
            required: false,
          });
        }
      }
    } else {
      const fields = Array.isArray(section.fields) ? section.fields : [];
      for (const f of fields) {
        if (!f || typeof f !== 'object') continue;
        const field = f as Record<string, unknown>;
        const name = String(field.name ?? '');
        if (!name) continue;
        out.push({
          id: name,
          rev: 1,
          type: normalizeFormFieldType(String(field.type ?? 'textbox')),
          label: String(field.label ?? name),
          required: Boolean(field.required),
        });
      }
    }
  }
  return out;
}

function resolveFormTemplateFields(source: SignerSourcePayload): WizardField[] {
  const flat = coerceFormJsonFields(source.json_fields);
  const settings = source.settings;
  const useStructured = !!settings?.use_structured_schema;
  const structured = structuredSchemaToWizardFields(settings);
  if (structured.length > 0 && (useStructured || flat.length === 0)) {
    return structured;
  }
  return flat;
}

function buildEditableFieldKeys(recipientFields: EnvelopeFieldAssignment[]): Set<string> {
  const set = new Set<string>();
  for (const fa of recipientFields) {
    if (fa.signed_at) continue;
    const k = fa.field_key;
    set.add(k);
    if (typeof k === 'string' && !k.includes(':')) {
      set.add(`${k}:1`);
    }
  }
  return set;
}

function allAssignmentsFromPayload(payload: SignerSessionPayload): EnvelopeFieldAssignment[] {
  if (payload.field_assignments?.length) return payload.field_assignments;
  if (payload.envelope?.field_assignments?.length) return payload.envelope.field_assignments;
  const envelopeId = payload.envelope?.id ?? 0;
  return (payload.all_fields ?? []).map((row, index) => ({
    id: index,
    envelope_id: envelopeId,
    recipient_id: row.recipient_id,
    field_key: row.field_key,
    field_type: '',
    required: false,
  }));
}

function recipientFieldsFromPayload(payload: SignerSessionPayload): EnvelopeFieldAssignment[] {
  if (payload.fields?.length) return payload.fields;
  const recipientId = payload.recipient?.id ?? payload.envelope?.inbox_context?.recipient_id;
  if (recipientId == null) return payload.field_assignments ?? [];
  return allAssignmentsFromPayload(payload).filter((a) => a.recipient_id === recipientId);
}

function wizardFieldToRuntime(f: WizardField, assignment?: EnvelopeFieldAssignment): RuntimeField {
  return Object.freeze({
    key: makeFieldKey(f.id, f.rev ?? 1),
    type: normalizeFormFieldType(String(f.type)),
    label: f.label || f.id,
    required: assignment?.required ?? f.required ?? false,
    assignedRecipientId: assignment?.recipient_id,
    rect:
      f.page != null && f.x != null && f.y != null && f.w != null && f.h != null
        ? Object.freeze({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h })
        : undefined,
  });
}

function buildCapabilities(
  sourceType: SignerSourcePayload['source_type'],
  source: SignerSourcePayload,
  isMyTurn: boolean,
  editableKeys: ReadonlySet<string>,
  hasSignFields: boolean,
): RuntimeDocument['capabilities'] {
  const interactive = source.interactive !== false;
  return Object.freeze({
    canEdit: interactive && isMyTurn,
    canSign: interactive && isMyTurn && hasSignFields,
    canInitial: interactive && isMyTurn && hasSignFields,
    canViewAttachments: sourceType === 'attachment' || !interactive,
  });
}

function normalizeSourceDocument(
  source: SignerSourcePayload,
  assignments: EnvelopeFieldAssignment[],
  isMyTurn: boolean,
  editableKeys: ReadonlySet<string>,
): RuntimeDocument {
  const sourceType = resolveSignerSourceType(source);
  const documentId = source.document_id ?? 0;
  const assignmentMap = new Map(
    assignments.filter((a) => !a.document_id || a.document_id === documentId).map((a) => [a.field_key, a]),
  );

  let templateFields: WizardField[] = [];
  if (sourceType === 'fillable' && Array.isArray(source.template_fields)) {
    templateFields = source.template_fields.map((f) => ({
      ...f,
      type: normalizeFormFieldType(String(f.type)),
    }));
  } else if (sourceType === 'form') {
    templateFields = resolveFormTemplateFields(source);
  }

  const fields: RuntimeField[] = templateFields.map((f) => {
    const key = makeFieldKey(f.id, f.rev ?? 1);
    return wizardFieldToRuntime(f, assignmentMap.get(key) ?? assignmentMap.get(f.id));
  });

  const hasSignFields = fields.some((f) => isSignFieldType(f.type));
  const interactive = source.interactive !== false;
  const pages = (source.page_images ?? []).map((imageUrl, index) =>
    Object.freeze({ index, imageUrl }),
  );

  return Object.freeze({
    documentId,
    documentKey: source.document_key,
    sourceType: sourceType ?? 'form',
    title: source.display_name || source.document_key,
    pages: Object.freeze(pages),
    fields: Object.freeze(fields),
    interactive,
    requiresAssignment: sourceType !== 'attachment' && fields.length > 0,
    capabilities: buildCapabilities(sourceType, source, isMyTurn, editableKeys, hasSignFields),
    metadata: Object.freeze({
      templateId: undefined,
      formId: undefined,
      fileId: undefined,
    }),
  });
}

export function normalizeSignerPayload(
  envelopeId: string,
  payload: SignerSessionPayload,
): NormalizedSignerSession {
  const recipientFields = recipientFieldsFromPayload(payload);
  const editableFieldKeys =
    payload.editable_field_keys?.length
      ? new Set(payload.editable_field_keys)
      : buildEditableFieldKeys(recipientFields);
  const isMyTurn = payload.is_my_turn !== false;
  const assignments = allAssignmentsFromPayload(payload);
  const sources = payload.sources ?? [];

  const documents = Object.freeze(
    sources.map((s) => normalizeSourceDocument(s, assignments, isMyTurn, editableFieldKeys)),
  );

  return Object.freeze({
    envelopeId,
    envelopeTitle: payload.envelope?.title ?? 'Signature request',
    documents,
    isMyTurn,
    editableFieldKeys,
    sessionGeneratedAtRevision:
      payload.session_generated_at_revision ?? payload.envelope_revision ?? 1,
    envelopeRevision: payload.envelope_revision ?? payload.envelope?.envelope_revision ?? 1,
    chain: payload.chain,
    recipientId: payload.recipient?.id ?? payload.envelope?.inbox_context?.recipient_id,
    phoneVerificationRequired: Boolean(payload.phone_verification_required),
    phoneMasked: payload.phone_masked ?? null,
    phoneVerified: Boolean(payload.phone_verified),
  });
}

export function resolveWizardStepFromEnvelope(envelope: Envelope): WizardStep {
  if (envelope.status !== 'draft') return 'review';
  const docs = envelope.documents ?? [];
  if (docs.length === 0) return 'add_documents';
  const recipients = envelope.recipients?.filter((r) => r.role === 'signer') ?? [];
  if (recipients.length === 0) return 'recipients';
  const assignments = envelope.field_assignments ?? [];
  const hasInteractive = docs.some((d) => d.source_type !== 'attachment');
  if (hasInteractive && assignments.length === 0) return 'assign_fields';
  return 'review';
}

export function envelopeDisplayId(envelope: Envelope): string {
  return envelope.public_id?.trim() || String(envelope.id);
}

export function documentRequiresPrepare(doc: EnvelopeDocument): boolean {
  return doc.source_type === 'fillable';
}

export function fieldImageUri(val: unknown): string | null {
  if (!val || typeof val !== 'object') return null;
  const o = val as Record<string, unknown>;
  // Prefer in-memory data URLs for reliable RN Image rendering; fall back to cached file path.
  if (typeof o.image === 'string' && o.image.trim()) return o.image;
  if (typeof o.imageUri === 'string' && o.imageUri.trim()) return o.imageUri;
  return null;
}

export function runtimeFieldsToWizard(fields: RuntimeField[]): WizardField[] {
  return fields.map((f) => {
    const { fieldId, rev } = parseFieldKey(f.key);
    return {
      id: fieldId,
      rev,
      type: f.type,
      label: f.label,
      required: f.required,
      page: f.rect?.page,
      x: f.rect?.x,
      y: f.rect?.y,
      w: f.rect?.w,
      h: f.rect?.h,
    };
  });
}

export function fieldValueForWizardField(
  field: WizardField,
  fieldValues: Record<string, unknown>,
): unknown {
  const key = makeFieldKey(field.id, field.rev ?? 1);
  if (fieldValues[key] !== undefined) return fieldValues[key];
  return fieldValues[field.id];
}

export function hasFieldSignature(val: unknown): boolean {
  return fieldImageUri(val) != null;
}

function lookupFieldType(session: NormalizedSignerSession, fieldKey: string): string | undefined {
  const bareKey = fieldKey.includes(':') ? fieldKey.slice(0, fieldKey.lastIndexOf(':')) : fieldKey;
  for (const doc of session.documents) {
    for (const f of doc.fields) {
      if (f.key === fieldKey || f.key === bareKey) return f.type;
      const bareField = f.key.includes(':') ? f.key.slice(0, f.key.lastIndexOf(':')) : f.key;
      if (bareField === bareKey) return f.type;
    }
  }
  return undefined;
}

/** Match web ``shapeSignerFieldValueForApi`` — backend requires ``{ image: string }`` for signatures. */
export async function shapeSignerFieldValueForApi(
  raw: unknown,
  fieldType?: string | null,
): Promise<unknown> {
  const looksLikeSignature =
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (typeof (raw as Record<string, unknown>).imageUri === 'string' ||
      typeof (raw as Record<string, unknown>).image === 'string');

  if (!isSignFieldType(fieldType) && !looksLikeSignature) return raw;

  if (typeof raw === 'string' && raw.trim()) {
    return { image: raw };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;

  const o = raw as Record<string, unknown>;
  if (typeof o.image === 'string' && o.image.trim()) {
    return { image: o.image };
  }
  if (typeof o.imageUri === 'string' && o.imageUri.trim()) {
    const uri = o.imageUri;
    if (uri.startsWith('data:')) {
      return { image: uri };
    }
    const { readFileBase64 } = await import('../services/signatureSessionCache');
    const b64 = await readFileBase64(uri);
    return { image: `data:image/png;base64,${b64}` };
  }
  return raw;
}

export async function shapeSignerValuesForApi(
  session: NormalizedSignerSession,
  values: Record<string, unknown>,
  editableKeys: ReadonlySet<string> = session.editableFieldKeys,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(values)) {
    if (!isFieldEditable(editableKeys, key)) continue;
    const fieldType = lookupFieldType(session, key);
    out[key] = await shapeSignerFieldValueForApi(val, fieldType);
  }
  return out;
}

export function envelopeDocsToWizardSources(docs: EnvelopeDocument[]): WizardSourceDraft[] {
  return docs.map((d) => ({
    localId: `doc_${d.id}`,
    source_type: d.source_type,
    fillable_template_id: d.fillable_template_id ?? undefined,
    user_form_id: d.user_form_id ?? undefined,
    file_id: d.attachment_source_file_id ?? d.attachment_snapshot_file_id ?? undefined,
    display_name: d.display_name,
  }));
}

export function wizardSourcesToReplaceDocuments(
  sources: WizardSourceDraft[],
  existingDocs?: EnvelopeDocument[],
): ReplaceDocumentsInput[] {
  return sources.map((s, i) => {
    const existing = existingDocs?.[i];
    const row: ReplaceDocumentsInput = {
      order_index: i,
      source_type: s.source_type,
    };
    if (existing?.id) row.id = existing.id;
    if (s.source_type === 'fillable') row.fillable_template_id = s.fillable_template_id;
    if (s.source_type === 'form') row.user_form_id = s.user_form_id;
    if (s.source_type === 'attachment') row.file_id = s.file_id;
    return row;
  });
}
