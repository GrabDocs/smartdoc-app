import type { FillSubmission } from '../services/fillApi';
import type { FillableTemplateListItem } from '../services/fillableApi';
import type { Envelope } from '../types/signature';
import { formatEnvelopeListDate } from './envelopeDisplay';
import { parseUtcMs } from './timeFormatting';

export type SignatureActivityKind = 'envelope' | 'fillable' | 'submission';

export interface SignatureActivityItem {
  kind: SignatureActivityKind;
  id: string;
  lastActivityAt: number;
  envelope?: Envelope;
  template?: FillableTemplateListItem;
  submission?: FillSubmission;
}

function parseIsoMs(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = parseUtcMs(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Latest meaningful timestamp for an envelope row. */
export function envelopeLastActivityMs(envelope: Envelope): number {
  const candidates = [
    parseIsoMs(envelope.updated_at),
    parseIsoMs(envelope.completed_at),
    parseIsoMs(envelope.sent_at),
    parseIsoMs(envelope.created_at),
  ].filter((v): v is number => v != null);
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

/** Latest meaningful timestamp for a fillable template row. */
export function templateLastActivityMs(template: FillableTemplateListItem): number {
  return parseIsoMs(template.updated_at) ?? parseIsoMs(template.created_at) ?? 0;
}

export function submissionLastActivityMs(submission: FillSubmission): number {
  return parseIsoMs(submission.filled_at) ?? 0;
}

export function envelopeLastActivityIso(envelope: Envelope): string | null {
  const ms = envelopeLastActivityMs(envelope);
  if (!ms) return envelope.created_at ?? null;
  return new Date(ms).toISOString();
}

export function templateLastActivityIso(template: FillableTemplateListItem): string | null {
  const updated = parseIsoMs(template.updated_at);
  if (updated != null) return template.updated_at ?? null;
  return template.created_at ?? null;
}

export function submissionLastActivityIso(submission: FillSubmission): string | null {
  return submission.filled_at ?? null;
}

/** Human-readable last-activity line for list rows. */
export function formatSignatureActivityLabel(
  iso: string | null | undefined,
  opts?: { uploadedAt?: string | null; prefix?: string },
): string | null {
  const formatted = formatEnvelopeListDate(iso);
  if (!formatted) return null;

  if (opts?.prefix) {
    return `${opts.prefix} ${formatted}`;
  }

  const activityMs = parseIsoMs(iso);
  const uploadedMs = parseIsoMs(opts?.uploadedAt);
  if (uploadedMs != null && activityMs != null && activityMs > uploadedMs + 60_000) {
    return `Updated ${formatted}`;
  }
  if (uploadedMs != null && activityMs != null && Math.abs(activityMs - uploadedMs) <= 60_000) {
    return `Uploaded ${formatted}`;
  }
  return `Updated ${formatted}`;
}

export function mergeSignatureActivity(
  envelopes: Envelope[],
  templates: FillableTemplateListItem[],
  submissions: FillSubmission[],
): SignatureActivityItem[] {
  const linkedTemplateIds = new Set<number>();
  for (const envelope of envelopes) {
    const legacyId = (envelope as Envelope & { fillable_template_id?: number }).fillable_template_id;
    if (legacyId) linkedTemplateIds.add(legacyId);
    for (const doc of envelope.documents ?? []) {
      if (doc.fillable_template_id) linkedTemplateIds.add(doc.fillable_template_id);
    }
  }

  const templateNameById = new Map<number, string>(
    templates.map((t) => [t.id, t.name || 'Document']),
  );

  const templateIdsWithSubmissions = new Set(submissions.map((s) => s.template_id));

  const envelopeItems: SignatureActivityItem[] = envelopes.map((envelope) => ({
    kind: 'envelope',
    id: `env-${envelope.public_id ?? envelope.id}`,
    lastActivityAt: envelopeLastActivityMs(envelope),
    envelope,
  }));

  const submissionItems: SignatureActivityItem[] = submissions.map((submission) => ({
    kind: 'submission',
    id: `sub-${submission.id}`,
    lastActivityAt: submissionLastActivityMs(submission),
    submission: {
      ...submission,
      template_name:
        submission.template_name ?? templateNameById.get(submission.template_id) ?? 'Document',
    },
  }));

  const inProgressTemplates = templates.filter(
    (t) =>
      !t.active_envelope_id &&
      !linkedTemplateIds.has(t.id) &&
      !templateIdsWithSubmissions.has(t.id),
  );

  const templateItems: SignatureActivityItem[] = inProgressTemplates.map((template) => ({
    kind: 'fillable',
    id: `tpl-${template.public_id ?? template.id}`,
    lastActivityAt: templateLastActivityMs(template),
    template,
  }));

  return [...envelopeItems, ...submissionItems, ...templateItems].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt,
  );
}

export function submissionDisplayTitle(submission: FillSubmission): string {
  return submission.template_name?.trim() || 'Filled document';
}
