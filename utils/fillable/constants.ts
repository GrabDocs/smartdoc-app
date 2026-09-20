import type { FieldType } from '../../types/signature';

/** Minimum normalized field width (prevents invisible/untappable fields). */
export const MIN_FIELD_W = 0.05;
/** Minimum normalized field height. */
export const MIN_FIELD_H = 0.02;

/** Default zoom level on open (125% fit). */
export const DEFAULT_ZOOM = 1.25;
/** Zoom range: 50% to 300%. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3.0;
/** FitScale upper cap so huge PDFs don't overfill screen. */
export const MAX_FIT_SCALE = 1.5;

/** Max undo stack depth (operations, not snapshots). */
export const MAX_UNDO_DEPTH = 50;
/** Nudge compression window: sequential moves within this ms collapse into one undo op. */
export const NUDGE_COMPRESS_MS = 300;

/** Paste offset so pasted fields don't stack exactly on originals. */
export const PASTE_OFFSET = 0.02;

/** Affordance sizes (zoom-independent, clamped). */
export const RESIZE_HANDLE_MIN = 14;
export const RESIZE_HANDLE_MAX = 28;
export const DELETE_BUTTON_MIN = 20;
export const DELETE_BUTTON_MAX = 32;
export const FIELD_LABEL_FONT_MIN = 10;
export const FIELD_LABEL_FONT_MAX = 14;
export const HIT_SLOP = 8;

/** Tap vs drag threshold in layout pixels. */
export const DRAG_THRESHOLD_PX = 5;

/** Default field dimensions per type (normalized). */
export const FIELD_DEFAULTS: Record<FieldType, { w: number; h: number; label: string }> = {
  signature: { w: 0.28, h: 0.07, label: 'Signature' },
  initials: { w: 0.14, h: 0.06, label: 'Initials' },
  date: { w: 0.22, h: 0.05, label: 'Date' },
  text: { w: 0.30, h: 0.05, label: 'Text' },
  checkbox: { w: 0.05, h: 0.04, label: 'Checkbox' },
};

/** Brand color per field type (DocuSign-inspired). */
export const FIELD_COLORS: Record<FieldType, string> = {
  signature: '#2563EB',  // blue-600
  initials: '#7C3AED',   // violet-600
  date: '#059669',       // emerald-600
  text: '#D97706',       // amber-600
  checkbox: '#2563EB',   // blue-600 — match calendar tint visibility
};

/** Lighter fill color per field type (for non-overlay UI, e.g. tool palette). */
export const FIELD_BG_COLORS: Record<FieldType, string> = {
  signature: 'rgba(37,99,235,0.10)',
  initials: 'rgba(124,58,237,0.10)',
  date: 'rgba(5,150,105,0.10)',
  text: 'rgba(217,119,6,0.10)',
  checkbox: 'rgba(37,99,235,0.10)',
};

/** Document overlay fields — transparent so the page shows through. */
export const FIELD_OVERLAY_BACKGROUND = 'transparent';

/** Icon name per field type (Ionicons). */
export const FIELD_ICONS: Record<FieldType, string> = {
  signature: 'create-outline',
  initials: 'text-outline',
  date: 'calendar-outline',
  text: 'document-text-outline',
  checkbox: 'checkbox-outline',
};

/** Ordered list for tool palette display. */
export const FIELD_TYPES: FieldType[] = ['signature', 'initials', 'date', 'text', 'checkbox'];

/** Generate a UUID v4 (uses crypto.randomUUID when available, fallback otherwise). */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
