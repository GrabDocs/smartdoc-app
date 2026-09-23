export function importSourceLabel(sourceType?: string | null): string {
  const t = (sourceType || '').trim();
  if (t === 'inbound_alias') return 'Email forwarding';
  if (t === 'gmail_inbox') return 'Gmail';
  if (t === 'outlook_inbox') return 'Microsoft 365';
  return t || 'Unknown';
}

export function importStatusBadge(
  status: string,
  failureCategory?: string | null,
  isDark = false
): { label: string; backgroundColor: string; color: string } {
  if (status === 'processed') {
    return {
      label: 'Imported',
      backgroundColor: isDark ? 'rgba(22,163,74,0.25)' : '#DCFCE7',
      color: isDark ? '#86EFAC' : '#166534',
    };
  }
  if (status === 'rejected') {
    const label =
      failureCategory === 'duplicate'
        ? 'Duplicate'
        : failureCategory
          ? failureCategory.replace(/_/g, ' ')
          : 'Rejected';
    return {
      label: label.charAt(0).toUpperCase() + label.slice(1),
      backgroundColor: isDark ? 'rgba(202,138,4,0.25)' : '#FEF9C3',
      color: isDark ? '#FDE047' : '#854D0E',
    };
  }
  if (status === 'failed') {
    return {
      label: 'Failed',
      backgroundColor: isDark ? 'rgba(220,38,38,0.25)' : '#FEE2E2',
      color: isDark ? '#FCA5A5' : '#991B1B',
    };
  }
  if (status === 'processing') {
    return {
      label: 'Processing',
      backgroundColor: isDark ? 'rgba(37,99,235,0.25)' : '#DBEAFE',
      color: isDark ? '#93C5FD' : '#1E40AF',
    };
  }
  if (status === 'received') {
    return {
      label: 'Queued',
      backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#F3F4F6',
      color: isDark ? '#D1D5DB' : '#374151',
    };
  }
  const raw = (status || 'Unknown').replace(/_/g, ' ');
  return {
    label: raw.charAt(0).toUpperCase() + raw.slice(1),
    backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#F3F4F6',
    color: isDark ? '#D1D5DB' : '#374151',
  };
}

export function getFileTypeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif'];
  const docExts = ['doc', 'docx'];
  const xlsExts = ['xls', 'xlsx', 'csv'];
  const pptExts = ['ppt', 'pptx'];
  const textExts = ['txt', 'md', 'rtf'];
  if (ext === 'pdf') return 'application/pdf';
  if (imageExts.includes(ext)) return 'image';
  if (docExts.includes(ext)) return 'application/msword';
  if (xlsExts.includes(ext)) return 'application/vnd.ms-excel';
  if (pptExts.includes(ext)) return 'application/vnd.ms-powerpoint';
  if (textExts.includes(ext)) return 'text/plain';
  return '';
}

export function formatEmailWhen(iso?: string | null): string {
  if (!iso) return '';
  const raw = iso.trim();
  // Backend stores UTC; Python isoformat() often omits Z — treat naive as UTC.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const d = new Date(hasZone ? raw : `${raw}Z`);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return 'Yesterday';
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function senderInitial(participants?: string[] | null, fallback?: string | null): string {
  const raw = (participants && participants[0]) || fallback || '?';
  const letter = raw.replace(/[^A-Za-z]/g, '').charAt(0) || raw.charAt(0) || '?';
  return letter.toUpperCase();
}

export function senderLabel(participants?: string[] | null): string {
  if (!participants?.length) return 'Unknown';
  const first = participants[0];
  const local = first.includes('@') ? first.split('@')[0] : first;
  return local.replace(/[._]/g, ' ');
}

/** Prefer display name from `Name <email>`; fall back to local-part if only an address. */
export function senderDisplayName(raw?: string | null): string {
  const s = (raw || '').trim();
  if (!s) return '';
  const angle = s.match(/^(?:"?([^"<]+)"?\s*)?<([^>]+)>$/);
  if (angle) {
    const name = (angle[1] || '').trim();
    if (name) return name;
    const email = angle[2].trim();
    return email.includes('@') ? email.split('@')[0].replace(/[._]/g, ' ') : email;
  }
  if (s.includes('@') && !s.includes(' ')) {
    return s.split('@')[0].replace(/[._]+/g, ' ');
  }
  return s;
}

/** Extract email address for detail views. */
export function senderNameAndEmail(raw?: string | null): string {
  const s = (raw || '').trim();
  if (!s) return '';
  const angle = s.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  if (s.includes('@')) return s;
  return '';
}

export function formatWaitingAge(iso?: string | null): string {
  if (!iso) return '';
  const raw = iso.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const d = new Date(hasZone ? raw : `${raw}Z`);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  if (days <= 0) return 'waiting today';
  if (days === 1) return '1 day waiting';
  return `${days} days waiting`;
}

export function threadStatusDotColor(t: {
  attention_status?: string | null;
  reply_status?: string | null;
}): string {
  if (t.attention_status === 'needs_reply') return '#EF4444';
  if (t.attention_status === 'awaiting_reply') return '#3B82F6';
  if (t.attention_status === 'draft_ready') return '#FBBF24';
  if (t.reply_status === 'waiting_for_response') return '#10B981';
  if (t.reply_status === 'closed') return '#9CA3AF';
  return '#D1D5DB';
}

const ATTACH_PREVIEW_MAX = 3;
const ATTACH_NAME_MAX_CHARS = 22;

export function truncateAttachName(name: string, max = ATTACH_NAME_MAX_CHARS): string {
  const n = (name || '').trim();
  if (n.length <= max) return n;
  if (max <= 1) return '…';
  return `${n.slice(0, Math.max(1, max - 1))}…`;
}

export function threadAttachmentNames(t: {
  attachment_names?: string[] | null;
  attachments?: { filename?: string | null }[] | null;
}): string[] {
  const fromNames = (t.attachment_names || []).map((n) => (n || '').trim()).filter(Boolean);
  if (fromNames.length) return fromNames;
  return (t.attachments || []).map((a) => (a.filename || '').trim()).filter(Boolean);
}

export function previewAttachmentNames(
  names: string[],
  maxVisible = ATTACH_PREVIEW_MAX
): { visible: string[]; extra: number } {
  const visible = names.slice(0, maxVisible);
  return { visible, extra: Math.max(0, names.length - visible.length) };
}
