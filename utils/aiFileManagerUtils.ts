import type { AiFmPlanPayload, GateType, PlanFileLinkRow, PlanResponse } from '../types/aiFileManager';
import { formatUserFacingPlanMessage } from './formatPlanPreview';

export function formatPlanPreview(plan?: AiFmPlanPayload | null): string {
  if (!plan) return 'No plan details available.';
  return formatUserFacingPlanMessage(plan as Record<string, unknown>);
}

/** Backend file_links use `original_filename`; PlanFileLinks expects `name`. */
export function normalizePlanFileLinks(raw: unknown): PlanFileLinkRow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PlanFileLinkRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = Number(r.file_id);
    if (!Number.isFinite(id)) continue;
    const name =
      String(r.name || r.original_filename || r.filename || '').trim() || `File ${id}`;
    out.push({
      file_id: id,
      name,
      original_filename: name,
      view_path: typeof r.view_path === 'string' ? r.view_path : undefined,
      download_path: typeof r.download_path === 'string' ? r.download_path : undefined,
    });
  }
  return out.length ? out : undefined;
}

/** Rebuild gate queue from latest /plan response — replace only, never merge. */
export function buildGateQueue(response: PlanResponse): GateType[] {
  const queue: GateType[] = [];
  if (response.folder_scope_suggestion_required) queue.push('folder_scope');
  if (response.scope_confirmation_required) queue.push('scope');
  if (response.rename_clarification_required) queue.push('rename');
  if (response.schedule_required) queue.push('schedule');
  // high_risk is execute-only — not in plan round-trip queue
  return queue;
}

export function planToHistoryTurns(message: string): Array<{ role: string; content: string }> {
  return [{ role: 'user', content: message }];
}

export function isPendingHistoryStatus(status?: string): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === 'pending' || s === 'awaiting_execution' || s === 'planned';
}

export function isCompletedHistoryStatus(status?: string): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === 'completed' || s === 'executed' || s === 'success';
}

export function parseAiFmTelemetry(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw) as unknown;
      return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}
