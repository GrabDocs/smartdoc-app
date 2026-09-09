import type { Envelope, EnvelopeRecipient, EnvelopeStatus } from '../types/signature';
import type { EnvelopeTab } from '../services/envelopeApi';
import { parseAsUTC } from './timeFormatting';

export interface BadgeStyle {
  label: string;
  backgroundColor: string;
  color: string;
}

const STATUS_BADGES: Record<string, BadgeStyle> = {
  draft: { label: 'Draft', backgroundColor: '#F3F4F6', color: '#374151' },
  sent: { label: 'Sent', backgroundColor: '#DBEAFE', color: '#1E40AF' },
  in_progress: { label: 'In progress', backgroundColor: '#DBEAFE', color: '#1E40AF' },
  completed: { label: 'Completed', backgroundColor: '#D1FAE5', color: '#047857' },
  declined: { label: 'Declined', backgroundColor: '#FEE2E2', color: '#B91C1C' },
  voided: { label: 'Voided', backgroundColor: '#FEF3C7', color: '#B45309' },
  expired: { label: 'Expired', backgroundColor: '#FEF3C7', color: '#B45309' },
  failed: { label: 'Failed', backgroundColor: '#F3F4F6', color: '#6B7280' },
};

const SOURCE_TYPE_BADGES: Record<'fillable' | 'form', BadgeStyle> = {
  fillable: { label: 'Fillable', backgroundColor: '#EDE9FE', color: '#6D28D9' },
  form: { label: 'Form', backgroundColor: '#E0F2FE', color: '#0369A1' },
};

export function envelopeStatusBadge(status: EnvelopeStatus | string): BadgeStyle {
  return (
    STATUS_BADGES[status] ?? {
      label: status.replace(/_/g, ' '),
      backgroundColor: '#F3F4F6',
      color: '#374151',
    }
  );
}

export function envelopeSourceType(envelope: Envelope): 'fillable' | 'form' | null {
  if (envelope.source_type === 'fillable' || envelope.source_type === 'form') {
    return envelope.source_type;
  }
  const doc = envelope.documents?.[0];
  if (doc?.source_type === 'fillable' || doc?.source_type === 'form') {
    return doc.source_type;
  }
  if (doc?.fillable_template_id) return 'fillable';
  if (doc?.user_form_id) return 'form';
  return null;
}

export function envelopeSourceTypeBadge(envelope: Envelope): BadgeStyle | null {
  const kind = envelopeSourceType(envelope);
  return kind ? SOURCE_TYPE_BADGES[kind] : null;
}

export function envelopeSigners(envelope: Envelope) {
  return (envelope.recipients ?? []).filter((r) => r.role === 'signer');
}

export function envelopeSignerProgress(envelope: Envelope) {
  if (envelope.signer_progress) {
    const { signed, total } = envelope.signer_progress;
    return { signers: [] as EnvelopeRecipient[], signedCount: signed, total };
  }
  const signers = envelopeSigners(envelope);
  const signedCount = signers.filter((r) => r.status === 'signed').length;
  return { signers, signedCount, total: signers.length };
}

export function envelopeSignerSummary(envelope: Envelope, tab?: EnvelopeTab): string | null {
  const { signers, signedCount, total } = envelopeSignerProgress(envelope);
  if (total === 0) return null;
  if (tab === 'drafts') {
    return `${total} signer${total !== 1 ? 's' : ''} added`;
  }
  return `${signedCount}/${total} signers complete`;
}

/** Compact date for tight mobile layouts, e.g. "May 22, 26". */
export function formatEnvelopeShortDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = parseAsUTC(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

export function formatEnvelopeListDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = parseAsUTC(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Compact date + time for detail rows, e.g. "May 10, 26, 7:37 PM". */
export function formatEnvelopeDateTime(iso?: string | null, fallback = '—'): string {
  if (!iso) return fallback;
  const d = parseAsUTC(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}

const RECIPIENT_STATUS_BADGES: Record<string, BadgeStyle> = {
  pending: { label: 'pending', backgroundColor: '#F3F4F6', color: '#4B5563' },
  waiting: { label: 'waiting', backgroundColor: '#F3F4F6', color: '#4B5563' },
  notified: { label: 'notified', backgroundColor: '#DBEAFE', color: '#1D4ED8' },
  viewed: { label: 'viewed', backgroundColor: '#DBEAFE', color: '#1D4ED8' },
  signed: { label: 'signed', backgroundColor: '#D1FAE5', color: '#047857' },
  declined: { label: 'declined', backgroundColor: '#FEE2E2', color: '#B91C1C' },
  bounced: { label: 'bounced', backgroundColor: '#FEF3C7', color: '#B45309' },
  delivery_failed: { label: 'delivery failed', backgroundColor: '#FEF3C7', color: '#B45309' },
};

export function recipientStatusBadge(status: string): BadgeStyle {
  return (
    RECIPIENT_STATUS_BADGES[status] ?? {
      label: status.replace(/_/g, ' '),
      backgroundColor: '#F3F4F6',
      color: '#4B5563',
    }
  );
}

export function envelopeSourceLabel(envelope: Envelope): string {
  const kind = envelopeSourceType(envelope);
  if (kind === 'fillable') return 'Fillable document';
  if (kind === 'form') return 'Quick form';
  return '—';
}

export function envelopeRemindersLabel(envelope: Envelope): string {
  if (!envelope.reminder_enabled) return 'Off';
  const hours = envelope.reminder_repeat_every_hours ?? 48;
  const max = envelope.reminder_max_count ?? 3;
  return `Every ${hours}h, max ${max}`;
}

export function groupSignersByOrder(recipients: EnvelopeRecipient[]) {
  const signers = recipients
    .filter((r) => r.role === 'signer')
    .sort((a, b) => a.order_index - b.order_index);
  const groups: Array<{ order: number; signers: EnvelopeRecipient[] }> = [];
  signers.forEach((s) => {
    const last = groups[groups.length - 1];
    if (last && last.order === s.order_index) last.signers.push(s);
    else groups.push({ order: s.order_index, signers: [s] });
  });
  return {
    groups,
    ccs: recipients.filter((r) => r.role === 'cc'),
  };
}

export function sortedAuditEvents(envelope: Envelope) {
  return [...(envelope.events ?? [])].sort(
    (a, b) => (a.event_seq || a.id) - (b.event_seq || b.id),
  );
}
