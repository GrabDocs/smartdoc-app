// User Types
export interface User {
  id: number;
  username: string;
  email: string;
  first_name?: string;
  last_name?: string;
  role: 'admin' | 'moderator' | 'user';
  is_active: boolean;
  theme?: 'light' | 'dark' | 'system';
  created_at: string;
  updated_at: string;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface SignupData {
  username: string;
  email: string;
  password: string;
  first_name?: string;
  last_name?: string;
  smsConsent?: boolean;
  dataRightsConsent?: boolean;
}

export interface AuthResponse {
  success: boolean;
  message: string;
  user?: User;
}

// File Types
export interface FileInfo {
  id: number;
  original_filename: string;
  file_type: string;
  file_size: number;
  file_path: string;
  upload_date: string;
  user_id: number;
  category?: string;
  description?: string;
  json_data?: Record<string, any>;
  is_receipt?: boolean;
  created_at: string;
  updated_at: string;
}

export interface FileUpload {
  uri: string;
  name: string;
  type: string;
  size?: number;
  /** When set, file list already shows this optimistic row (e.g. gallery pick) */
  optimisticId?: string;
}

export interface UploadProgress {
  fileId: string;
  progress: number;
  status: 'uploading' | 'completed' | 'error';
  error?: string;
}

// Chat Types
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  file_references?: number[];
}

/** Citation/source item for assistant message references */
export interface ChatCitation {
  source_type?: string;
  source_name?: string;
  filename?: string;
  excerpt?: string;
  chunk_content?: string;
  document_id?: number;
  source_id?: string;
}

export interface ChatHistory {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
  /** References keyed by message_id (string). Merged into assistant messages for display. */
  references?: Record<
    string,
    {
      citations?: ChatCitation[];
      metadata?: any;
      timestamp?: string;
      chart_file_id?: number | string;
      chart_title?: string;
    }
  >;
  persistent_context?: {
    context_file_ids?: number[];
    context_bookmark_ids?: number[];
    context_entry_ids?: number[];
    context_transcript_ids?: number[];
    selected_files?: number[];
    selected_bookmarks?: number[];
    selected_workspaces?: number[];
    selected_users?: number[];
    [key: string]: any;
  } | null;
}

export interface ChatRequest {
  message: string;
  history_id?: number;
  context_files?: number[];
}

// Form Types
export interface FormField {
  id: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'number' | 'email' | 'date';
  label: string;
  name: string;
  required: boolean;
  placeholder?: string;
  options?: string[];
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
  };
}

export interface FormTemplate {
  id: number;
  name: string;
  description?: string;
  fields: FormField[];
  share_url?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  response_count?: number;
}

export interface Form {
  id: number;
  title: string;
  description?: string;
  fields: FormField[];
  share_url: string;
  status: 'active' | 'draft' | 'archived';
  category: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  responses_count?: number;
  fields_count?: number;
}

export interface FormResponse {
  id: number;
  form_id: number;
  response_data: Record<string, any>;
  submitted_at: string;
  ip_address?: string;
}

// Document Template Types
export interface DocumentTemplate {
  id: number;
  name: string;
  description?: string;
  file_path: string;
  placeholders: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CompletedDocument {
  id: number;
  template_id: number;
  template_name: string;
  filename: string;
  file_path: string;
  placeholder_values: Record<string, string>;
  created_at: string;
}

// Notification Types
export interface Notification {
  id: number;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  is_read: boolean;
  created_at: string;
  data?: Record<string, any>;
}

// Analytics Types
export interface AnalyticsOverview {
  total_files: number;
  total_forms: number;
  total_users: number;
  total_storage: number;
  recent_files: number;
  recent_forms: number;
  recent_responses: number;
  active_users: number;
}

export interface AnalyticsFiles {
  documents: number;
  images: number;
  receipts: number;
  other: number;
  by_type: Array<{
    type: string;
    count: number;
    total_size: number;
  }>;
}

export interface AnalyticsForms {
  active: number;
  draft: number;
  total_responses: number;
  avg_response_rate: number;
  top_forms: Array<{
    id: number;
    title: string;
    responses_count: number;
    created_at: string;
  }>;
}

export interface AnalyticsUsers {
  total: number;
  active: number;
  new_users: number;
  admins: number;
  activity: Array<{
    action: string;
    count: number;
    date: string;
  }>;
}

export interface DashboardAnalytics {
  overview: AnalyticsOverview;
  files: AnalyticsFiles;
  forms: AnalyticsForms;
  users: AnalyticsUsers;
  total_files: number;
  total_users: number;
  files_today: number;
  users_active_today: number;
  storage_used: number;
  recent_activities: ActivityLog[];
}

export interface ActivityLog {
  id: number;
  user_id: number;
  username: string;
  activity_type: string;
  activity_category: string;
  description: string;
  timestamp: string;
  endpoint?: string;
  method?: string;
  response_status?: number;
  duration_ms?: number;
}

// Workspace Types
export interface Workspace {
  id: number;
  name: string;
  description?: string;
  owner_id: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  member_count?: number;
}

export interface WorkspaceMember {
  id: number;
  workspace_id: number;
  user_id: number;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
  user?: User;
}

// Upload Link Types
export interface UploadLink {
  id: number;
  name: string;
  description?: string;
  token: string;
  is_active: boolean;
  expires_at?: string;
  max_files?: number;
  allowed_file_types?: string[];
  created_at: string;
  updated_at: string;
  upload_count?: number;
}

// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    per_page: number;
    total: number;
    pages: number;
  };
}

// Error Types
export interface AppError {
  code: string;
  message: string;
  details?: any;
}

// Settings Types
export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  notifications: {
    enabled: boolean;
    email: boolean;
    push: boolean;
  };
  offline: {
    autoSync: boolean;
    maxCacheSize: number;
  };
  upload: {
    autoUpload: boolean;
    compressImages: boolean;
  };
}

// Navigation Types
export type RootStackParamList = {
  '(tabs)': undefined;
  'auth/login': undefined;
  'auth/signup': undefined;
  'auth/forgot-password': undefined;
  'auth/reset-password': { token: string };
  'file/[id]': { id: string };
  'chat/[id]': { id: string };
  'form/[shareUrl]': { shareUrl: string };
  'template/[id]': { id: string };
  'settings': undefined;
  'profile': undefined;
  'notifications': undefined;
  '+not-found': undefined;
};

export type TabsParamList = {
  index: undefined;
  files: undefined;
  chat: undefined;
  forms: undefined;
  analytics: undefined;
};

// State Types
export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface FileState {
  files: FileInfo[];
  isLoading: boolean;
  error: string | null;
  uploadProgress: Record<string, UploadProgress>;
}

export interface ChatState {
  histories: ChatHistory[];
  currentHistory: ChatHistory | null;
  isLoading: boolean;
  error: string | null;
}

export interface NotificationState {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  error: string | null;
} 