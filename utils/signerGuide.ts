/**
 * DocuSign-style guide stops for the native envelope signer.
 * Walk unfinished assigned fields; Sign/Start jump here instead of only erroring.
 */

import type { NormalizedSignerSession, RuntimeField } from '../types/signature';
import {
  hasFieldSignature,
  isDateFieldType,
  isFieldEditable,
  isSignFieldType,
} from './signatureRuntime';

export type SignerGuideKind = 'signature' | 'initials' | 'text' | 'checkbox';

export interface SignerGuideStop {
  id: string;
  fieldKey: string;
  kind: SignerGuideKind;
  label: string;
  page: number;
  x: number;
  y: number;
  docIndex: number;
  required: boolean;
}

function normalizeGuideType(type: string | undefined | null): string {
  return String(type || '').trim().toLowerCase();
}

export function signerGuideActionLabel(kind: SignerGuideKind): string {
  if (kind === 'signature') return 'Sign';
  if (kind === 'initials') return 'Initial';
  if (kind === 'checkbox') return 'Check';
  return 'Fill in';
}

export function isSignerGuideKind(type: string): type is SignerGuideKind {
  const t = normalizeGuideType(type);
  return t === 'signature' || t === 'initials' || t === 'text' || t === 'checkbox';
}

/** True when this signer still has to act on the field. Dates are server-filled. */
export function isSignerGuideValueFilled(kind: SignerGuideKind, value: unknown): boolean {
  if (kind === 'signature' || kind === 'initials') return hasFieldSignature(value);
  if (kind === 'text') {
    if (typeof value === 'string') return value.trim().length > 0;
    if (value && typeof value === 'object' && 'text' in (value as object)) {
      const text = (value as { text?: unknown }).text;
      return typeof text === 'string' && text.trim().length > 0;
    }
    return false;
  }
  if (kind === 'checkbox') {
    if (typeof value === 'object' && value != null && 'checked' in value) {
      return (value as { checked?: unknown }).checked === true;
    }
    return value === true;
  }
  return false;
}

export function nextSignerGuideStop(
  stops: SignerGuideStop[],
  focus: SignerGuideStop | null,
): SignerGuideStop | null {
  if (stops.length === 0) return null;
  if (!focus) return stops[0];
  const next = stops.find((s) => {
    if (s.docIndex !== focus.docIndex) return s.docIndex > focus.docIndex;
    if (s.page !== focus.page) return s.page > focus.page;
    if (Math.abs(s.y - focus.y) > 0.002) return s.y > focus.y;
    return s.x > focus.x + 0.002;
  });
  if (next) return next;
  return stops.find((s) => s.id !== focus.id) ?? null;
}

function fieldGuideKind(field: RuntimeField): SignerGuideKind | null {
  if (isDateFieldType(field.type)) return null;
  const t = normalizeGuideType(field.type);
  if (!isSignerGuideKind(t)) return null;
  return t;
}

export function buildSignerGuideStops(
  session: NormalizedSignerSession,
  fieldValues: Record<string, unknown>,
): SignerGuideStop[] {
  if (!session.isMyTurn) return [];
  const stops: SignerGuideStop[] = [];
  session.documents.forEach((doc, docIndex) => {
    if (!doc.interactive || doc.sourceType === 'attachment') return;
    for (const field of doc.fields) {
      if (!isFieldEditable(session.editableFieldKeys, field.key)) continue;
      const kind = fieldGuideKind(field);
      if (!kind) continue;
      if (kind === 'checkbox' && !field.required) continue;
      if (isSignerGuideValueFilled(kind, fieldValues[field.key])) continue;
      const page = field.rect?.page ?? 0;
      const x = field.rect?.x ?? 0;
      const y = field.rect?.y ?? 0;
      stops.push({
        id: `${docIndex}:${field.key}`,
        fieldKey: field.key,
        kind,
        label: field.label || signerGuideActionLabel(kind),
        page,
        x,
        y,
        docIndex,
        required: !!field.required || isSignFieldType(field.type),
      });
    }
  });
  stops.sort((a, b) => a.docIndex - b.docIndex || a.page - b.page || a.y - b.y || a.x - b.x);
  return stops;
}

/** Locked identity fields we hide when the signer cannot change them. */
export function isLockedIdentityField(field: {
  key: string;
  label: string;
  type?: string;
}, editable: boolean): boolean {
  if (editable) return false;
  const label = (field.label || '').trim().toLowerCase();
  const key = (field.key || '').toLowerCase();
  if (label === 'name' || label === 'your name' || label === 'full name' || label === 'email' || label === 'your email') {
    return true;
  }
  if (key.includes('filled_by') || key.includes('respondent_name') || key.includes('respondent_email')) {
    return true;
  }
  return false;
}
