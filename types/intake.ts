/**
 * Intake feature types — mirrors backend `Intake`/`IntakeItem`/`IntakeFile`/`IntakeTemplate`
 * to_dict() shapes (manager-francis/backend/model.py) via the same `/api/v1/web/intakes*`
 * endpoints the web app uses (manager-francis/frontend/src/pages/intake/*.tsx).
 */

export type IntakeStatus = 'draft' | 'waiting_for_client' | 'in_review' | 'completed' | 'archived';
export type IntakeItemStatus = 'pending' | 'matched' | 'confirmed' | 'not_applicable';
export type IntakeDueBadge = 'on_track' | 'due_tomorrow' | 'overdue';
export type IntakeMatchSource = 'ai' | 'filename' | 'manual';
export type IntakeFileMatchStatus = 'auto_matched' | 'needs_review' | 'unmatched' | 'manually_matched';
export type IntakeFileSource = 'file_request_link' | 'email_alias' | 'gmail_sync' | 'outlook_sync' | 'owner_upload';
export type ReminderPreset = 'gentle' | 'standard' | 'urgent' | 'custom';

export interface IntakeAuthorizedSender {
  name: string;
  email: string;
}

export interface IntakeProgress {
  received: number;
  total: number;
  percent: number;
}

export interface IntakeItem {
  id: number;
  intake_id: number;
  label: string;
  description: string | null;
  required: boolean;
  status: IntakeItemStatus;
  matched_file_id: number | null;
  matched_file_name: string | null;
  match_confidence: number | null;
  match_source: IntakeMatchSource | null;
  auto_verified: boolean;
  confirmed_by_user_id: number | null;
  sort_order: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface IntakeFileRow {
  id: number;
  intake_id: number;
  file_id: number;
  filename: string | null;
  source: IntakeFileSource;
  sender_email: string | null;
  matched_item_id: number | null;
  matched_item_label: string | null;
  match_confidence: number | null;
  match_status: IntakeFileMatchStatus;
  created_at: string | null;
}

export interface IntakeUploadLink {
  id: number;
  link_token: string;
  upload_code: string | null;
  public_url: string;
}

export interface Intake {
  id: number;
  user_id: number;
  company_id: number;
  workspace_id: number;
  title: string;
  client_name: string | null;
  client_primary_email: string | null;
  authorized_senders: IntakeAuthorizedSender[];
  status: IntakeStatus;
  due_at: string | null;
  due_badge?: IntakeDueBadge | null;
  upload_link_id: number | null;
  destination_folder_id: number | null;
  template_id: number | null;
  auto_verify_high_confidence: boolean;
  reminder_enabled: boolean;
  reminder_preset: ReminderPreset | null;
  reminder_first_after_hours: number;
  reminder_repeat_every_hours: number;
  reminder_max_count: number;
  last_reminder_sent_at: string | null;
  sent_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  progress: IntakeProgress;
  upload_link?: IntakeUploadLink;
  items?: IntakeItem[];
  needs_attention?: IntakeFileRow[];
  unmatched?: IntakeFileRow[];
  arrival_history?: IntakeFileRow[];
  last_file_received_at?: string | null;
}

export interface IntakeTemplateItem {
  id?: number;
  template_id?: number;
  label: string;
  description: string | null;
  required: boolean;
  sort_order?: number;
}

export interface IntakeTemplate {
  id: number;
  user_id: number;
  name: string;
  industry_tag: string | null;
  created_at: string | null;
  items: IntakeTemplateItem[];
}

export const INTAKE_STATUS_LABELS: Record<IntakeStatus, string> = {
  draft: 'Draft',
  waiting_for_client: 'Waiting for Client',
  in_review: 'In Review',
  completed: 'Completed',
  archived: 'Archived',
};

export const INTAKE_ITEM_STATUS_LABELS: Record<IntakeItemStatus, string> = {
  pending: 'Missing',
  matched: 'Received',
  confirmed: 'Verified',
  not_applicable: 'N/A',
};

export const INTAKE_DUE_BADGE_LABELS: Record<IntakeDueBadge, string> = {
  on_track: 'On Track',
  due_tomorrow: 'Due Tomorrow',
  overdue: 'Overdue',
};

export const INTAKE_SOURCE_LABELS: Record<string, string> = {
  file_request_link: 'Upload Link',
  email_alias: 'Email Forward',
  gmail_sync: 'Gmail Sync',
  outlook_sync: 'Outlook Sync',
  owner_upload: 'Owner Upload',
};

export const INTAKE_ACTIVE_POLL_STATUSES: IntakeStatus[] = ['draft', 'waiting_for_client', 'in_review'];

export const INTAKE_REMINDER_PRESETS: Record<'gentle' | 'standard' | 'urgent', { first: number; repeat: number; max: number }> = {
  gentle: { first: 72, repeat: 120, max: 3 },
  standard: { first: 48, repeat: 72, max: 4 },
  urgent: { first: 24, repeat: 24, max: 6 },
};

export type IntakeScheduleStatus = 'active' | 'paused' | 'completed';
export type IntakeScheduleFrequency = 'once' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
export type IntakeWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface IntakeScheduleProgress {
  received: number;
  total: number;
  percent: number;
}

export interface IntakeScheduleCurrentCollection {
  id: number;
  title: string;
  status: string;
  period_label?: string | null;
  progress?: IntakeScheduleProgress;
}

export interface IntakeScheduleCollection {
  id: number;
  title: string;
  status: string;
  period_label?: string | null;
  progress?: IntakeScheduleProgress;
  scheduled_for?: string | null;
  due_at?: string | null;
  sent_at?: string | null;
  due_badge?: string | null;
}

export interface IntakeScheduleListItem {
  id: number;
  title: string;
  status: string;
  frequency: string;
  cadence_summary?: string;
  client_name?: string | null;
  client_primary_email?: string | null;
  next_run_at?: string | null;
  collections_count?: number;
  current_collection?: IntakeScheduleCurrentCollection | null;
}

export interface IntakeScheduleDetail {
  id: number;
  user_id: number;
  company_id: number;
  workspace_id: number;
  title: string;
  client_name?: string | null;
  client_primary_email?: string | null;
  authorized_senders?: IntakeAuthorizedSender[];
  destination_folder_id?: number | null;
  template_id?: number | null;
  auto_verify_high_confidence?: boolean;
  frequency: string;
  interval_count?: number;
  by_month_day?: number | null;
  by_month?: number | null;
  by_weekday?: string | null;
  timezone?: string;
  start_at?: string | null;
  end_at?: string | null;
  max_occurrences?: number | null;
  due_after_days?: number;
  reminder_enabled?: boolean;
  reminder_preset?: string | null;
  reminder_first_after_hours?: number;
  reminder_repeat_every_hours?: number;
  reminder_max_count?: number;
  reminder_max_days?: number;
  next_run_at?: string | null;
  last_run_at?: string | null;
  occurrence_count?: number;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
  cadence_summary?: string;
  estimated_next_due_at?: string | null;
  checklist_items?: { label: string; description?: string | null; required?: boolean; sort_order?: number }[];
  collections?: IntakeScheduleCollection[];
}

/** Nested on POST /intakes when creating a schedule. */
export interface CreateIntakeSchedulePayload {
  frequency: IntakeScheduleFrequency;
  interval_count: number;
  send_now: boolean;
  due_after_days: number;
  reminder_max_days: number;
  timezone: string;
  start_at: string;
  by_weekday?: IntakeWeekday;
  by_month_day?: number;
  by_month?: number;
  end_at?: string;
  max_occurrences?: number;
}

export const INTAKE_SCHEDULE_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
};

export const INTAKE_SCHEDULE_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  active: { bg: '#CCFBF1', text: '#0F766E' },
  paused: { bg: '#FEF3C7', text: '#92400E' },
  completed: { bg: '#E5E7EB', text: '#6B7280' },
};

export const INTAKE_WEEKDAY_OPTIONS: { value: IntakeWeekday; label: string }[] = [
  { value: 'MO', label: 'Monday' },
  { value: 'TU', label: 'Tuesday' },
  { value: 'WE', label: 'Wednesday' },
  { value: 'TH', label: 'Thursday' },
  { value: 'FR', label: 'Friday' },
  { value: 'SA', label: 'Saturday' },
  { value: 'SU', label: 'Sunday' },
];

