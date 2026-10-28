/** AI File Manager — minimal types for mobile (web /api/v1/web/ai-file-manager/*). */

export type FmPhase =
  | 'idle'
  | 'planning'
  | 'gate'
  | 'pending'
  | 'executing'
  | 'undoing'
  | 'unknown';

export type GateType =
  | 'folder_scope'
  | 'scope'
  | 'rename'
  | 'schedule'
  | 'high_risk';

export type ChatRole = 'user' | 'assistant';

export interface ChatTurn {
  role: ChatRole;
  content: string;
  /** Assistant-only formatted plan summary */
  planPreview?: string;
  planFileLinks?: PlanFileLinkRow[];
}

export interface PlanFileLinkRow {
  file_id?: number;
  /** Display name. Backend sends `original_filename`; mobile maps that onto `name`. */
  name?: string;
  original_filename?: string;
  filename?: string;
  view_path?: string;
  download_path?: string;
}

export interface PlanOperation {
  type?: string;
  description?: string;
  target_count?: number;
  [key: string]: unknown;
}

export interface AiFmPlanPayload {
  operations?: PlanOperation[];
  rephrased_plan?: string;
  file_links?: PlanFileLinkRow[];
  intent_type?: string;
  resolved_count?: number;
  rename_candidates?: Array<{ file_id: number; name?: string }>;
  [key: string]: unknown;
}

export interface AiFmConfig {
  immediate_max?: number;
  schedule_required?: number;
  undo_window_minutes?: number;
  protected_folder_names?: string[];
  session_op_budget?: number;
  [key: string]: unknown;
}

export interface PlanRequestBody {
  message: string;
  workspace_id: number;
  current_folder_id?: number | null;
  session_id: string;
  history?: Array<{ role: string; content: string }>;
  scope_confirmed?: boolean;
  folder_scope_confirmed?: boolean;
  suggested_folder_id?: number | null;
  rename_batch_confirmed?: boolean;
  rename_pick_file_id?: number;
  force_schedule_override?: boolean;
}

export interface PlanResponse {
  success?: boolean;
  message?: string;
  plan?: AiFmPlanPayload;
  execution_token?: string;
  plan_hash?: string;
  history_id?: number;
  scope_confirmation_required?: boolean;
  folder_scope_suggestion_required?: boolean;
  rename_clarification_required?: boolean;
  schedule_required?: boolean;
  requires_high_risk_confirm?: boolean;
  not_file_op?: boolean;
  undo_intent?: boolean;
  [key: string]: unknown;
}

export interface ExecuteRequestBody {
  execution_token: string;
  plan_hash: string;
  workspace_id: number;
  session_id: string;
  high_risk_confirm?: string;
}

export interface ExecuteResponse {
  success?: boolean;
  idempotent?: boolean;
  message?: string;
  result?: {
    summary?: string;
    operations?: unknown[];
    file_links?: PlanFileLinkRow[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface HistoryRow {
  id: number;
  query?: string;
  rephrased_plan?: string | null;
  status?: string;
  operations?: PlanOperation[];
  execution_token?: string;
  plan_hash?: string;
  telemetry?: Record<string, unknown>;
  intent_confidence?: number | null;
  resolver_confidence?: number | null;
  workspace_id?: number | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface ScheduledRow {
  id: number;
  query?: string;
  status?: string;
  next_run_at?: string;
  approved_file_count?: number;
  [key: string]: unknown;
}

export interface ScheduleRequestBody {
  workspace_id: number;
  query: string;
  schedule_mode?: string;
  approved_file_count?: number;
  resolver_query?: string;
  next_run_at: string;
}

export interface PendingPlanState {
  executionToken: string;
  planHash: string;
  historyId?: number;
  plan?: AiFmPlanPayload;
  requiresHighRiskConfirm?: boolean;
  lastUserMessage?: string;
}
