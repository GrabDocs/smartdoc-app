import axios, { AxiosInstance } from 'axios';
import Constants from 'expo-constants';
import { AppState, Platform, type AppStateStatus } from 'react-native';
// @ts-ignore - react-native-fetch-api provides true ReadableStream support
import { fetch as streamingFetch } from 'react-native-fetch-api';
import { API_BASE_URL, API_ENDPOINTS, STORAGE_KEYS } from '../constants/Config';
import { secureStorage } from '../utils/storage';
import { clearMobileAuthTokens, getStoredRefreshToken, persistMobileAuthTokens } from '../utils/authTokenStorage';
import {
    getUserPreferences,
    validateFileAgainstUploadSettings,
} from '../utils/userPreferences';
import { assertUploadAllowedForCurrentNetwork } from '../utils/wifiOnlyUpload';
import { createSmoothProgressEmitter } from './uploadProgressSmooth';
import {
    isAppBackgrounded,
    waitForAppActive,
    withUploadForegroundRetry,
    type UploadRetryCallbacks,
} from './uploadResilience';

// API response structure matching backend
interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  user?: any;
  response?: string;
  chat_id?: string;
  status?: string;  // Status field for polling responses (e.g., 'not_found', 'cancelled', 'processing')
  content?: string;  // Content from chat polling responses
  cursor?: number;  // Cursor position for chat polling
  done?: boolean;  // Whether chat polling is complete
  preview_started?: boolean;  // Whether preview phase has started
  is_preview_phase?: boolean;  // Whether currently in preview phase
  /** Preview buffer was reset at first LLM token; client must not slice using old cursor over placeholder */
  preview_cursor_reset?: boolean;
  /** Refinement replaced preview (or final text landed); client must resync cursor — same as preview reset */
  refinement_cursor_reset?: boolean;
  chat_history_id?: number;  // Chat history ID from chat responses
  metadata?: any;  // Metadata object from chat responses
  error?: string;  // Error message from chat polling responses
  job_id?: string;  // Job ID from chat job start responses
  upload_id?: string;  // Upload ID from chunked upload responses
  total_chunks?: number;  // Total chunks from chunked upload responses
  chunk_size?: number;  // Chunk size from chunked upload responses
  uploaded_chunks?: number[];  // Array of uploaded chunk indices from upload status responses
  paused?: boolean;  // Whether upload is paused from upload status responses
  citations?: Array<{
    source_type: string;
    source_name: string;
    excerpt?: string;
    confidence?: number;
  }>;
  files?: any[];
  file?: any;  // single file from get-file, getFileById, etc.
  forms?: any[];
  requires_confirmation?: boolean;
  asset_count?: number;
  asset_details?: string[];
  warning?: string;
  pagination?: {
    page?: number;
    per_page?: number;
    total?: number;
    has_more?: boolean;
  };
}

interface AuthResponse {
  success: boolean;
  message: string;
  user?: any;
  token?: string;
  requires2FA?: boolean;
  preferredAuthMethod?: string;
  identifier?: string;
  session_info?: {
    user_id: number;
    session_id?: string;
    cookie_config?: any;
  };
}

/** Same JSON body as web `analysis.tsx` → POST /api/v1/web/analysis/{receipts|invoices}/download-report */
export interface WebAnalysisDownloadReportBody {
  category: string;
  days: number | null;
  date_from: string | null;
  date_to: string | null;
  search: string | null;
  amount_min: number | null;
  amount_max: number | null;
}

// Mobile API endpoints with v1/mobile prefix
const MOBILE_ENDPOINTS = {
  // Authentication
  AUTH_CHECK: '/api/v1/mobile/auth-check',
  LOGIN: '/api/v1/mobile/login',
  REFRESH: '/api/v1/mobile/refresh',
  LOGOUT: '/api/v1/mobile/logout',
  SIGNUP: '/api/v1/mobile/signup',
  FORGOT_PASSWORD: '/api/v1/mobile/forgot-password',
  
  // 2FA Authentication
  REQUEST_OTP: '/api/v1/mobile/auth/request-otp',
  VERIFY_OTP: '/api/v1/mobile/auth/verify-otp',
  REQUEST_MFA_OTP: '/api/v1/mobile/auth/request-mfa-otp',
  VERIFY_MFA_OTP: '/api/v1/mobile/auth/verify-mfa-otp',
  LOGIN_WITH_PHONE: '/api/v1/mobile/auth/login-with-phone',
  CHECK_PHONE: '/api/v1/mobile/auth/check-phone',
  REGISTER_WITH_PHONE: '/api/v1/mobile/auth/register-with-phone',
  
  // User
  USER: '/api/v1/mobile/user',
  USER_REQUEST_EMAIL_CHANGE: '/api/v1/mobile/user/request-email-change',
  USER_CANCEL_EMAIL_CHANGE: '/api/v1/mobile/user/cancel-email-change',
  USER_VERIFY_EMAIL_CHANGE: '/api/v1/mobile/user/verify-email-change',
  USER_DEFAULT_HOME_PATH: '/api/v1/mobile/user/default-home-path',
  USER_APP_PREFERENCES: '/api/v1/mobile/user/app-preferences',
  APP_FEATURES: '/api/v1/mobile/app-features',
  
  // Files (all operations go through backend encryption)
  FILES: '/api/v1/mobile/files',
  UPLOAD: '/api/v1/mobile/upload', // Backend encrypts on save
  UPLOAD_INIT: '/api/v1/mobile/upload/init',
  UPLOAD_CHUNK: '/api/v1/mobile/upload/chunk',
  UPLOAD_COMPLETE: '/api/v1/mobile/upload/complete',
  UPLOAD_STATUS: '/api/v1/mobile/upload/status',
  UPLOAD_CANCEL: '/api/v1/mobile/upload/cancel',
  UPLOAD_PAUSE: '/api/v1/mobile/upload/pause',
  UPLOAD_RESUME: '/api/v1/mobile/upload/resume',
  FILE_BY_ID: (id: number) => `/api/v1/mobile/get-file/${id}`,
  FILE_DOWNLOAD: (id: number) => `/api/v1/mobile/file/${id}/download`, // Backend decrypts on download
  FILE_VIEW: (id: number) => `/api/v1/mobile/file/${id}/view`, // Backend decrypts for viewing
  FILE_DELETE: (id: number) => `/api/v1/mobile/file/${id}`,
  FILE_CATEGORIZE: (id: number) => `/api/v1/mobile/file/${id}/categorize`,
  FILE_AUTO_CATEGORIZE: (id: number) => `/api/v1/mobile/file/${id}/auto-categorize`,
  FILE_WORKSPACE_VISIBILITY: (id: number) => `/api/v1/mobile/file/${id}/workspace-visibility`,
  
  // Chat
  CHAT_HISTORY: '/api/v1/mobile/chat/history',
  CHAT_SEND: '/api/v1/mobile/chat/send',
  CHAT_SMART_STREAM: '/api/v1/mobile/chat/smart/stream',
  CHAT_SMART_START: '/api/v1/mobile/chat/smart/start',
  CHAT_SMART_CHUNK: '/api/v1/mobile/chat/smart/chunk',
  CHAT_SMART_CANCEL: '/api/v1/mobile/chat/smart/cancel',
  /** Web chat feedback (thumbs up/down) - same as web */
  CHAT_FEEDBACK: '/api/v1/web/chat/feedback',

  // Forms
  FORMS: '/api/v1/mobile/forms',
  FORM_BY_ID: (id: number) => `/api/v1/mobile/forms/${id}`,
  FORM_PUBLISH: (id: number) => `/api/v1/mobile/forms/${id}/publish`,
  FORM_UNPUBLISH: (id: number) => `/api/v1/mobile/forms/${id}/unpublish`,
  FORM_RESPONSES: (id: number) => `/api/v1/mobile/forms/${id}/responses`,
  
  // Analysis
  DASHBOARD: '/api/v1/mobile/analysis/dashboard',
  ANALYTICS: '/api/v1/mobile/analysis/analytics',
  ACTIVITY: '/api/v1/mobile/analysis/activity',
  COMPREHENSIVE: '/api/v1/mobile/analysis/comprehensive',
  
  // Documents
  DOCUMENTS: '/api/v1/mobile/documents',
  DOCUMENT_BY_ID: (id: number) => `/api/v1/mobile/document/${id}`,
  
  // Templates
  TEMPLATES: '/api/v1/mobile/templates',
  FORM_TEMPLATES: '/api/v1/mobile/form-templates',
  
  // Chat system (AI Chat)
  CHATS: '/api/v1/mobile/chats',
  CHAT_MESSAGES: (chatId: number) => `/api/v1/mobile/chat/messages/${chatId}`,
  CHAT_SEND_MESSAGE: '/api/v1/mobile/chat/send',
  
  // User Chat (mobile endpoint for list so JWT auth works and web favorites sync via is_favorite)
  USER_CHATS: '/api/v1/mobile/user-chat/chats',
  USER_CHAT_MESSAGES: (chatId: number) => `/api/v1/web/user-chat/chats/${chatId}/messages`,
  USER_CHAT_SEND: (chatId: number) => `/api/v1/web/user-chat/chats/${chatId}/send`,
  USER_CHAT_DELIVERED: (chatId: number) => `/api/v1/web/user-chat/chats/${chatId}/delivered`,
  USER_CHAT_READ: (chatId: number) => `/api/v1/web/user-chat/chats/${chatId}/read`,
  USER_CHAT_START: '/api/v1/web/user-chat/start-chat',
  USER_CHAT_SEARCH_USERS: '/api/v1/web/user-chat/search-users',
  USER_CHAT_INVITE: '/api/v1/mobile/user-chat/invite',
  USER_CHAT_INVITE_ACCEPT: '/api/v1/mobile/user-chat/invites/accept',
  USER_CHAT_INVITE_RESOLVE: '/api/v1/mobile/user-chat/invites/resolve',
  USER_CHAT_INVITES_PENDING_FOR_ME: '/api/v1/mobile/user-chat/invites/pending-for-me',
  USER_CHAT_INVITES_OUTGOING: '/api/v1/mobile/user-chat/invites/pending',
  USER_CHAT_INVITE_RESEND: (id: number) => `/api/v1/mobile/user-chat/invites/${id}/resend`,
  USER_CHAT_INVITE_REVOKE: (id: number) => `/api/v1/mobile/user-chat/invites/${id}/revoke`,
  
  // Bookmarks
  BOOKMARKS: '/api/v1/mobile/bookmarks',
  
  // Workspaces
  WORKSPACES: '/api/v1/mobile/workspaces',
  /** Single-workspace GET/PATCH/DELETE — same as web (WorkspaceManager); mobile list/create stay on /mobile/workspaces */
  WORKSPACE_WEB_BY_ID: (id: number) => `/api/v1/web/workspaces/${id}`,
  WORKSPACE_BY_ID: (id: number) => `/api/v1/mobile/workspaces/${id}`,
  /** Same payload as web GET /workspaces/:id/files (UNION visibility + bookmarks); uses mobile JWT */
  WORKSPACE_FILES: (id: number) => `/api/v1/mobile/workspaces/${id}/files`,
  WORKSPACE_MEMBERS: (id: number) => `/api/v1/mobile/workspaces/${id}/members`,
  WORKSPACE_MEMBER_BY_ID: (workspaceId: number, memberId: number) => `/api/v1/mobile/workspaces/${workspaceId}/members/${memberId}`,
  WORKSPACE_MEMBER_ROLE: (workspaceId: number, memberId: number) => `/api/v1/mobile/workspaces/${workspaceId}/members/${memberId}/role`,
  WORKSPACE_INVITATION_RESEND: (workspaceId: number, invitationId: number) => `/api/v1/mobile/workspaces/${workspaceId}/invitations/${invitationId}/resend`,
  WORKSPACE_INVITATION_BY_ID: (workspaceId: number, invitationId: number) => `/api/v1/mobile/workspaces/${workspaceId}/invitations/${invitationId}`,
  WORKSPACE_USERS: '/api/v1/mobile/workspace-users',
  
  // Upload Links (mobile list/detail; mutations may use web routes)
  UPLOAD_LINKS: '/api/v1/mobile/upload-links',
  UPLOAD_LINK_BY_ID: (id: number) => `/api/v1/mobile/upload-links/${id}`,
  UPLOAD_LINK_FILES: (id: number) => `/api/v1/mobile/upload-links/${id}/files`,
  // Web Upload Links (create/update/delete, public upload-to, email share)
  WEB_UPLOAD_LINKS: '/api/v1/web/upload-links',
  WEB_UPLOAD_LINK_BY_ID: (id: number) => `/api/v1/web/upload-links/${id}`,
  WEB_UPLOAD_LINK_SEND_EMAIL: (id: number) => `/api/v1/web/upload-links/${id}/send-email`,
  WEB_UPLOAD_LINK_REGENERATE_CODE: (id: number) => `/api/v1/web/upload-links/${id}/regenerate-code`,
  WEB_FILES_UPLOADED_VIA_LINKS: '/api/v1/web/files/uploaded-via-links',
  WEB_UPLOAD_TO: (token: string) => `/api/v1/web/upload-to/${token}`,
  WEB_UPLOAD_TO_BY_CODE: (code: string) => `/api/v1/web/upload-to/by-code/${code}`,

  // Intake (mobile for list/detail reads; web for mutations/templates)
  INTAKES: '/api/v1/mobile/intakes',
  INTAKE_BY_ID: (id: number) => `/api/v1/mobile/intakes/${id}`,
  WEB_INTAKES: '/api/v1/web/intakes',
  WEB_INTAKE_BY_ID: (id: number) => `/api/v1/web/intakes/${id}`,
  WEB_INTAKE_SEND: (id: number) => `/api/v1/web/intakes/${id}/send`,
  WEB_INTAKE_REMIND: (id: number) => `/api/v1/web/intakes/${id}/remind`,
  WEB_INTAKE_UNARCHIVE: (id: number) => `/api/v1/web/intakes/${id}/unarchive`,
  WEB_INTAKE_ITEMS: (intakeId: number) => `/api/v1/web/intakes/${intakeId}/items`,
  WEB_INTAKE_ITEM_BY_ID: (intakeId: number, itemId: number) => `/api/v1/web/intakes/${intakeId}/items/${itemId}`,
  WEB_INTAKE_ITEM_CONFIRM: (intakeId: number, itemId: number) => `/api/v1/web/intakes/${intakeId}/items/${itemId}/confirm`,
  WEB_INTAKE_ITEM_REJECT: (intakeId: number, itemId: number) => `/api/v1/web/intakes/${intakeId}/items/${itemId}/reject`,
  WEB_INTAKE_ITEM_NOT_APPLICABLE: (intakeId: number, itemId: number) => `/api/v1/web/intakes/${intakeId}/items/${itemId}/not-applicable`,
  WEB_INTAKE_ITEM_ASSIGN: (intakeId: number, itemId: number) => `/api/v1/web/intakes/${intakeId}/items/${itemId}/assign`,
  WEB_INTAKE_ITEM_UPLOAD: (intakeId: number, itemId: number) => `/api/v1/web/intakes/${intakeId}/items/${itemId}/upload`,
  WEB_INTAKE_SCHEDULES: '/api/v1/web/intake-schedules',
  WEB_INTAKE_SCHEDULE_BY_ID: (id: number) => `/api/v1/web/intake-schedules/${id}`,
  INTAKE_TEMPLATES: '/api/v1/mobile/intake-templates',
  INTAKE_TEMPLATE_BY_ID: (id: number) => `/api/v1/mobile/intake-templates/${id}`,
  WEB_INTAKE_TEMPLATES: '/api/v1/web/intake-templates',
  WEB_INTAKE_TEMPLATE_BY_ID: (id: number) => `/api/v1/web/intake-templates/${id}`,
  
  // Meeting Assets & Webhooks (same endpoints as web)
  VIDEO_ASSET_CONTENT: '/api/v1/video/asset-content',
  WEB_FILE_VIEW: (id: number) => `/api/v1/web/files/${id}/view`,
  MEETING_ASSETS: '/api/v1/mobile/meeting-assets',
  MEETINGS: '/api/v1/mobile/meetings',
  MEETING_CREATE: '/api/v1/mobile/meetings/create',
  MEETING_JOIN: '/api/v1/mobile/meetings/join',
  MEETING_SCHEDULE: '/api/v1/mobile/meetings/schedule',
  MEETING_TRANSCRIPT: (meetingId: string) => `/api/v1/mobile/meetings/${meetingId}/transcript`,
  MEETING_SUMMARY: (meetingId: string) => `/api/v1/mobile/meetings/${meetingId}/summary`,
  MEETING_CHAT: (meetingId: string) => `/api/v1/mobile/meetings/${meetingId}/chat`,
  MEETING_REPORT: (meetingId: string) => `/api/v1/mobile/meetings/${meetingId}/report`,
  MEETING_DOWNLOAD: (meetingId: string, assetType: string) => `/api/v1/mobile/meetings/${meetingId}/download/${assetType}`,
  MEETING_DELETE_ASSETS: (meetingId: string) => `/api/v1/video/room/${meetingId}/delete-assets`,
  /** Same as web: public play page at /public/asset/{token} */
  VIDEO_RECORDING_SHARE: (recordingId: number) => `/api/v1/video/recording/${recordingId}/share`,
  
  // Error Logging
  ERROR_LOG: '/api/v1/mobile/error-log',
  ERROR_LOGS: '/api/v1/mobile/error-logs', // GET endpoint to view error logs
  
  // Notifications (same data as web)
  NOTIFICATIONS: '/api/v1/mobile/notifications',
  NOTIFICATION_MARK_READ: (id: number) => `/api/v1/mobile/notifications/${id}/read`,
  NOTIFICATION_MARK_ALL_READ: '/api/v1/mobile/notifications/mark-all-read',
  NOTIFICATION_CLEAR_ALL: '/api/v1/mobile/notifications/clear-all',
  
  // File invites (draft/file – same web endpoints, user-level)
  FILE_INVITES: '/api/v1/web/user/file-invites',
  FILE_INVITE_ACCEPT: (shareId: number) => `/api/v1/web/user/file-invites/${shareId}/accept`,
  FILE_INVITE_REJECT: (shareId: number) => `/api/v1/web/user/file-invites/${shareId}/reject`,
  // Unified file-sharing (accept/reject + shared-with-me – same as web)
  FILE_SHARING_ACCEPT: (shareId: number) => `/api/v1/web/file-sharing/accept-share/${shareId}`,
  FILE_SHARING_REJECT: (shareId: number) => `/api/v1/web/file-sharing/reject-share/${shareId}`,

  // Workspace invitations (from notification – same web endpoints)
  WORKSPACE_INVITATION_ACCEPT: (invitationId: number) => `/api/v1/web/workspaces/invitations/${invitationId}/accept`,
  WORKSPACE_INVITATION_REJECT: (invitationId: number) => `/api/v1/web/workspaces/invitations/${invitationId}/reject`,

  // Meeting join requests (host approve/reject from notification – same as web)
  JOIN_REQUEST_APPROVE: (videoCallId: number, joinRequestId: number) =>
    `/api/v1/video/room/${videoCallId}/join-requests/${joinRequestId}/approve`,
  JOIN_REQUEST_REJECT: (videoCallId: number, joinRequestId: number) =>
    `/api/v1/video/room/${videoCallId}/join-requests/${joinRequestId}/reject`,
  
  // Push notifications (for when user is not in app)
  PUSH_TOKEN: '/api/v1/mobile/push-token',
  
  // Configuration
  // CONFIG: '/api/v1/mobile/config', // Not available on backend
} as const;

// Short-lived cache for meeting assets to avoid duplicate requests and timeouts when list + details both fetch
const MEETING_ASSETS_CACHE_MS = 45000; // 45 seconds
let meetingAssetsCache: { at: number; userId: string | null; response: ApiResponse } | null = null;

export function clearMeetingAssetsCache(): void {
  meetingAssetsCache = null;
}

async function currentCachedUserId(): Promise<string | null> {
  try {
    const raw = await secureStorage.getItem('user');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: string | number };
    return parsed?.id != null ? String(parsed.id) : null;
  } catch {
    return null;
  }
}

/** Axios config flag: 401 must not clear the app login session. */
type SessionAwareAxiosConfig = { skipSessionExpiry?: boolean };

/**
 * Meeting / auth-flow 401s are often "not allowed for this room" or bad credentials —
 * not "wipe the user's GrabDocs login". Clearing session here is what surfaces
 * Meeting Call → "Authentication Required" after join/leave.
 */
function shouldSkipSessionExpiryOn401(url?: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  if (
    u.includes('/login') ||
    u.includes('/signup') ||
    u.includes('/register') ||
    u.includes('/otp') ||
    u.includes('/verify') ||
    u.includes('/oauth/exchange-token')
  ) {
    return true;
  }
  // Reach / video presence — room-scoped failures must not log the user out of the app
  if (
    u.includes('/heartbeat') ||
    u.includes('/recording-status') ||
    u.includes('/leave') ||
    u.includes('/join-by-id') ||
    u.includes('/api/v1/video/') ||
    u.includes('/api/v1/mobile/meetings/')
  ) {
    return true;
  }
  return false;
}

// Main API Service Class
class ApiService {
  public client: AxiosInstance;
  private onSessionExpired?: () => void;
  private sessionExpiryInFlight = false;
  private refreshInFlight: Promise<boolean> | null = null;

  setOnSessionExpired(callback: () => void) {
    this.onSessionExpired = callback;
  }

  constructor() {
    // Determine the actual platform for the X-Platform header
    // For Expo Go (local testing), use 'android' to bypass iOS HTTPS requirements
    // For standalone apps, use the actual platform
    const isExpoGo = Constants.appOwnership === 'expo';
    const platformHeader = isExpoGo ? 'android' : // Use android in Expo Go to avoid HTTPS issues
                          Platform.OS === 'ios' ? 'ios' : 
                          Platform.OS === 'android' ? 'android' : 
                          'mobile'; // fallback for web or other platforms
    
    // CRITICAL: Ensure baseURL is always HTTPS for production
    // iOS requires HTTPS and backend enforces it
    let validatedBaseURL = API_BASE_URL;
    if (validatedBaseURL.includes('api.grabdocs.com') && !validatedBaseURL.startsWith('https://')) {
      console.error('🚨 CRITICAL: API_BASE_URL is not HTTPS! Forcing HTTPS:', validatedBaseURL);
      validatedBaseURL = validatedBaseURL.replace(/^http:\/\//, 'https://');
    }

    // CRITICAL: Add X-Forwarded-Proto header for production HTTPS requests
    // This helps backend detect original HTTPS even if proxy forwards as HTTP
    const defaultHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Platform': platformHeader, // Send platform optimized for environment
    };
    
    // Always set X-Forwarded-Proto for production API to help backend detect HTTPS
    if (validatedBaseURL.startsWith('https://')) {
      defaultHeaders['X-Forwarded-Proto'] = 'https';
      defaultHeaders['X-Forwarded-Scheme'] = 'https';
    }
    
    this.client = axios.create({
      baseURL: validatedBaseURL,
      timeout: 30000,
      headers: defaultHeaders,
      withCredentials: true,
      // Enable cookie handling for session-based auth
      xsrfCookieName: 'XSRF-TOKEN',
      xsrfHeaderName: 'X-XSRF-TOKEN',
    });

    this.setupInterceptors();
  }

  private setupInterceptors() {
    this.client.interceptors.request.use(
      async (config) => {
        // CRITICAL: Ensure HTTPS is always used for production API
        // iOS requires HTTPS and backend enforces it
        if (config.url && config.baseURL) {
          const fullUrl = config.baseURL + config.url;
          if (fullUrl.includes('api.grabdocs.com') && !fullUrl.startsWith('https://')) {
            console.error('🚨 CRITICAL: HTTP detected for production API! Forcing HTTPS:', fullUrl);
            // Force HTTPS for production URLs
            if (config.baseURL.startsWith('http://')) {
              config.baseURL = config.baseURL.replace(/^http:\/\//, 'https://');
            }
            const correctedUrl = config.baseURL + config.url;
            console.log('✅ Corrected URL to HTTPS:', correctedUrl);
          }
        }
        
        try {
          const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
          // Never send placeholder/non-JWT tokens as Bearer auth.
          // When no JWT exists, rely on cookie-based session (withCredentials=true).
          if (token && token !== 'session_token') {
            config.headers.Authorization = `Bearer ${token}`;
          } else if (config.headers && 'Authorization' in config.headers) {
            delete (config.headers as any).Authorization;
          }
          const deviceToken = await secureStorage.getItem(STORAGE_KEYS.DEVICE_TOKEN);
          if (deviceToken) {
            config.headers['X-Device-Token'] = deviceToken;
          }
        } catch (error) {
          console.warn('Failed to get auth token:', error);
        }
        
        // CRITICAL: Ensure X-Forwarded-Proto header is set for production HTTPS requests
        // This is essential when proxy/load balancer forwards HTTP but original was HTTPS
        if (config.baseURL && config.baseURL.startsWith('https://')) {
          config.headers['X-Forwarded-Proto'] = 'https';
          config.headers['X-Forwarded-Scheme'] = 'https';
        }
        
        // CRITICAL: For FormData in React Native, remove Content-Type header if manually set
        // React Native FormData needs to set Content-Type with boundary automatically
        if (config.data instanceof FormData && config.headers['Content-Type']) {
          delete config.headers['Content-Type'];
        }

        // Log request details for debugging (uncomment if needed)
        // const fullRequestUrl = (config.baseURL || '') + (config.url || '');
        // console.log('🌐 API Request:', {
        //   method: config.method?.toUpperCase(),
        //   url: fullRequestUrl,
        // });
        // console.log('📡 API Request:', {
        //   url: config.url,
        //   method: config.method,
        //   headers: {
        //     ...config.headers,
        //     Authorization: config.headers.Authorization ? 'Bearer [REDACTED]' : 'None'
        //   }
        // });
        
        return config;
      },
      (error) => Promise.reject(error)
    );

    this.client.interceptors.response.use(
      (response) => {
        // console.log('📡 API Response:', {
        //   url: response.config.url,
        //   status: response.status,
        //   statusText: response.statusText
        // });
        return response;
      },
      async (error) => {
        // console.error('📡 API Error:', {
        //   url: error.config?.url,
        //   status: error.response?.status,
        //   statusText: error.response?.statusText,
        //   data: error.response?.data,
        //   message: error.message
        // });

        if (error.response?.status === 401) {
          const originalRequest = error.config as SessionAwareAxiosConfig & { _retriedAfterRefresh?: boolean };
          const reqUrl = String(originalRequest?.url || '');
          const skipSessionClear =
            shouldSkipSessionExpiryOn401(reqUrl) ||
            !!originalRequest?.skipSessionExpiry;
          const isRefreshCall = reqUrl.includes('/mobile/refresh');

          if (!skipSessionClear && !isRefreshCall && !originalRequest._retriedAfterRefresh) {
            originalRequest._retriedAfterRefresh = true;
            const refreshed = await this.tryRefreshAccessToken();
            if (refreshed) {
              const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
              if (token && token !== 'session_token') {
                originalRequest.headers = originalRequest.headers ?? {};
                originalRequest.headers.Authorization = `Bearer ${token}`;
              }
              return this.client(originalRequest);
            }
          }

          if (!skipSessionClear && !this.sessionExpiryInFlight) {
            // Confirm the app session is actually dead before wiping login.
            // A single flaky/unauthorized meeting API must not force Sign In.
            this.sessionExpiryInFlight = true;
            try {
              const stillAuthed = await this.probeSessionStillValid();
              if (!stillAuthed) {
                await this.clearAuthData();
                this.onSessionExpired?.();
              } else {
                console.warn(
                  '🔐 401 on',
                  reqUrl,
                  '— app session still valid; not signing user out'
                );
              }
            } finally {
              this.sessionExpiryInFlight = false;
            }
          }
        }

        // Gateway / proxy errors (502, 503, 504) mean the network path is broken.
        // Tag the error so every isNetworkError / isCalendarFetchOfflineError check
        // treats it as an offline condition instead of showing a raw HTTP alert.
        const status: number | undefined = error.response?.status;
        if (status === 502 || status === 503 || status === 504) {
          error.isOfflineGatewayError = true;
          // Replace the raw "Request failed with status code 5xx" Axios message so
          // any catch block that forwards error.message shows something meaningful.
          if (!error.response?.data?.message) {
            error.message = 'Unable to reach the server. Please check your connection.';
          }
        }

        return Promise.reject(error);
      }
    );
  }

  private async clearAuthData() {
    try {
      await clearMobileAuthTokens();
      await secureStorage.removeItem(STORAGE_KEYS.USER_DATA);
      await secureStorage.removeItem(STORAGE_KEYS.DEVICE_TOKEN);
    } catch (error) {
      console.warn('Failed to clear auth data:', error);
    }
  }

  /** Exchange stored refresh token for a new access + refresh pair (CASA 2.2.3). */
  async tryRefreshAccessToken(): Promise<boolean> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      try {
        const refreshToken = await getStoredRefreshToken();
        if (!refreshToken) return false;

        const response = await this.client.post(
          MOBILE_ENDPOINTS.REFRESH,
          { refresh_token: refreshToken },
          { skipSessionExpiry: true, timeout: 15000 } as any,
        );
        const data = response?.data;
        if (!data?.success) return false;

        await persistMobileAuthTokens({
          token: data.token ?? data.access_token,
          access_token: data.access_token ?? data.token,
          refresh_token: data.refresh_token,
        });
        return true;
      } catch {
        return false;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  private async persistLoginResult(result: Record<string, any>): Promise<void> {
    if (result.user) {
      await secureStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(result.user));
    }
    await persistMobileAuthTokens({
      token: result.token,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    });
    if (result.deviceToken) {
      await secureStorage.setItem(STORAGE_KEYS.DEVICE_TOKEN, result.deviceToken);
    }
  }

  /** Quiet auth-check used before wiping session on 401. Never triggers logout itself. */
  private async probeSessionStillValid(): Promise<boolean> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.AUTH_CHECK, {
        skipSessionExpiry: true,
        timeout: 10000,
      } as any);
      const data = response?.data;
      return !!(data?.success && (data?.data || data?.user));
    } catch {
      return false;
    }
  }

  // ==================== MOBILE AUTHENTICATION ====================

  async login(credentials: { username: string; password: string }): Promise<AuthResponse> {
    try {
      const username = (credentials.username ?? '').trim();
      const password = (credentials.password ?? '').trim();
      console.log('🔄 Attempting mobile login with:', { username });
      const payload = { username, password };
      const response = await this.client.post(MOBILE_ENDPOINTS.LOGIN, payload);
      console.log('✅ Mobile login response:', response.status, response.data);
      
      const result = response.data;
      
      if (result.success) {
        // Check if 2FA is required (backend sends OTP and requires verification)
        if (result.requires2FA) {
          console.log('🔐 2FA required - OTP sent, returning requires2FA flag');
          return {
            success: false, // Set to false so UI knows login isn't complete yet
            requires2FA: true,
            message: result.message || 'Please verify the code sent to your ' + (result.preferredAuthMethod === 'phone' ? 'phone' : 'email'),
            user: result.user,
            preferredAuthMethod: result.preferredAuthMethod,
            identifier: result.user?.masked_phone_number || result.user?.email,
          };
        }
        
        // Login successful (no 2FA required)
        await this.persistLoginResult(result);
        if (result.token) {
          console.log('💾 Stored authentication token:', result.token.substring(0, 20) + '...');
        } else {
          console.log('ℹ️ No JWT token returned; using cookie-based session');
        }
        if (result.refresh_token) {
          console.log('💾 Stored refresh token');
        }
        if (result.deviceToken) {
          console.log('💾 Stored device token for trusted device');
        }
        
        return {
          success: true,
          message: 'Login successful',
          user: result.user,
          token: result.token,
          session_info: result.session_info,
        };
      }
      
      return {
        success: false,
        message: result.message || 'Login failed',
      };
      
    } catch (error: any) {
      // console.error('❌ Mobile login error:', error);
      
      if (error.response) {
        // console.error('❌ Error response:', error.response.data);
        // console.error('❌ Error status:', error.response.status);
        
        if (error.response.status === 0) {
          throw new Error('Unable to reach the server. Please check your connection.');
        }
        
        if (error.response.status === 500) {
          throw new Error('Server error occurred. Please try again later.');
        }
        
        throw new Error(error.response.data?.message || 'Login failed');
      } else if (error.request) {
        // console.error('❌ No response received:', error.request);
        throw new Error('No response from server. Please check your connection.');
      } else {
        // console.error('❌ Error setting up request:', error.message);
        throw new Error('Error setting up request: ' + error.message);
      }
    }
  }

  async logout(expoPushToken?: string | null): Promise<ApiResponse> {
    try {
      const refreshToken = await getStoredRefreshToken();
      const body: Record<string, string> = {};
      if (expoPushToken) body.token = expoPushToken;
      if (refreshToken) body.refresh_token = refreshToken;
      const response = await this.client.post(
        MOBILE_ENDPOINTS.LOGOUT,
        Object.keys(body).length > 0 ? body : undefined,
      );
      await this.clearAuthData();
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Logout failed');
    }
  }

  async checkAuth(): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.AUTH_CHECK);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Auth check failed');
    }
  }

  /** Web session auth-check; includes defaultHomePath when authenticated (same backend session as mobile). */
  async getWebAuthCheck(): Promise<
    ApiResponse & { authenticated?: boolean; defaultHomePath?: string | null; default_home_path?: string | null }
  > {
    try {
      const response = await this.client.get('/api/v1/web/auth-check');
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Web auth check failed');
    }
  }

  /** Web user profile; includes defaultHomePath. */
  async getWebUser(): Promise<ApiResponse & { defaultHomePath?: string | null; default_home_path?: string | null; user?: any }> {
    try {
      const response = await this.client.get('/api/v1/web/user');
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch web user');
    }
  }

  async updateWebDefaultHomePath(path: string | null): Promise<ApiResponse & { defaultHomePath?: string | null }> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.USER_DEFAULT_HOME_PATH, {
        defaultHomePath: path,
        default_home_path: path,
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to update default home path');
    }
  }

  async getAppPreferences(): Promise<
    ApiResponse & {
      hiddenApps?: Record<string, boolean>;
      hidden_apps?: Record<string, boolean>;
      companyPolicy?: { disabledApps?: Record<string, boolean> };
      appFeatures?: any[];
      apps?: any[];
    }
  > {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.USER_APP_PREFERENCES);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to load app preferences');
    }
  }

  async getAppFeatures(): Promise<ApiResponse & { apps?: any[]; appFeatures?: any[] }> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.APP_FEATURES);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to load app features');
    }
  }

  async updateAppPreferences(patch: Record<string, boolean>): Promise<
    ApiResponse & {
      hiddenApps?: Record<string, boolean>;
      hidden_apps?: Record<string, boolean>;
      companyPolicy?: { disabledApps?: Record<string, boolean> };
      defaultHomePath?: string | null;
    }
  > {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.USER_APP_PREFERENCES, {
        hidden_apps: patch,
        hiddenApps: patch,
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to update app preferences');
    }
  }

  /**
   * Exchange a one-time Google OAuth code (grabdocs://login-success?code=...) for tokens.
   * The `code` is an opaque exchange token — not a JWT.
   */
  async exchangeGoogleOAuthToken(exchangeCode: string): Promise<{
    success: boolean;
    user?: { id: number; username: string; email: string; firstName?: string; lastName?: string };
    token?: string;
    access_token?: string;
    refresh_token?: string;
  }> {
    const response = await this.client.post('/api/v1/web/oauth/exchange-token', {
      code: exchangeCode,
    }, {
      headers: { 
        'Content-Type': 'application/json',
        'X-Platform': 'mobile',
      },
      withCredentials: true,
      skipSessionExpiry: true,
    } as any);
    return response.data;
  }

  /**
   * Native Google Sign-In (Android): verify a Google ID token server-side and establish a session.
   * The native SDK returns the idToken in-session (no browser / grabdocs:// deep link), so this
   * call is synchronous from the app's perspective and avoids the Android deep-link navigation race.
   * Backend contract: POST { id_token } -> { success, user, token } (mobile JWT).
   */
  async googleSignInWithIdToken(idToken: string): Promise<{ success: boolean; user?: { id: number | string; username?: string; email?: string; firstName?: string; lastName?: string; name?: string }; token?: string; access_token?: string; refresh_token?: string; message?: string }> {
    try {
      const response = await this.client.post('/api/v1/web/auth/google-id-token', {
        id_token: idToken,
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Platform': 'mobile', // Indicate this is a mobile request to get a JWT token
        },
        withCredentials: true,
      });
      return response.data;
    } catch (error: any) {
      const message =
        error?.response?.data?.error ||
        error?.response?.data?.message ||
        error?.message ||
        'Google sign-in failed';
      return { success: false, message };
    }
  }

  async testConnectivity(): Promise<ApiResponse> {
    try {
      const response = await this.client.get('/api/v1/mobile/health');
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Connectivity test failed');
    }
  }

  async signup(data: any): Promise<AuthResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.SIGNUP, data);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Signup failed');
    }
  }

  async forgotPassword(email: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.FORGOT_PASSWORD, { email });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Password reset failed');
    }
  }

  // ==================== MOBILE 2FA AUTHENTICATION ====================

  async requestOtp(
    phoneNumber: string,
    countryCode: string = 'US',
    purpose: string = 'verification',
    smsConsent: boolean = false,
  ): Promise<ApiResponse> {
    try {
      console.log('🔄 Requesting OTP for:', { phoneNumber, countryCode, purpose });
      
      const response = await this.client.post(MOBILE_ENDPOINTS.REQUEST_OTP, {
        phoneNumber,
        countryCode,
        purpose,
        smsConsent,
      });
      
      console.log('✅ OTP request response:', response.status, response.data);
      return response.data;
    } catch (error: any) {
      // console.error('❌ OTP request error:', error);
      throw new Error(error.response?.data?.message || 'Failed to send verification code');
    }
  }

  async verifyOtp(phoneNumber: string, otpCode: string): Promise<ApiResponse> {
    try {
      console.log('🔄 Verifying OTP for:', { phoneNumber, otpCode });
      
      const response = await this.client.post(MOBILE_ENDPOINTS.VERIFY_OTP, {
        phoneNumber,
        otpCode
      });
      
      console.log('✅ OTP verification response:', response.status, response.data);
      return response.data;
    } catch (error: any) {
      // console.error('❌ OTP verification error:', error);
      throw new Error(error.response?.data?.message || 'Invalid verification code');
    }
  }

  async requestMfaOtp(data: {
    purpose: string;
    method: 'phone' | 'email';
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.REQUEST_MFA_OTP, {
        purpose: data.purpose,
        method: data.method,
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to send verification code');
    }
  }

  async verifyMfaOtp(data: {
    method: 'phone' | 'email';
    otpCode: string;
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.VERIFY_MFA_OTP, {
        method: data.method,
        otpCode: data.otpCode,
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Invalid verification code');
    }
  }

  async verifyOtpWithEmail(email: string, otpCode: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.VERIFY_OTP, {
        email,
        otpCode,
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Invalid verification code');
    }
  }

  async registerWithPhone(data: {
    phoneNumber: string;
    countryCode?: string;
    username: string;
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    smsConsent?: boolean;
    dataRightsConsent?: boolean;
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.REGISTER_WITH_PHONE, {
        phoneNumber: data.phoneNumber,
        countryCode: data.countryCode || 'US',
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        password: data.password,
        smsConsent: data.smsConsent ?? true,
        dataRightsConsent: data.dataRightsConsent ?? false,
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Phone registration failed');
    }
  }

  async loginWithPhone(phoneNumber: string, password: string): Promise<AuthResponse> {
    try {
      console.log('🔄 Attempting phone login for:', { phoneNumber });
      
      const response = await this.client.post(MOBILE_ENDPOINTS.LOGIN_WITH_PHONE, {
        phoneNumber,
        password
      });
      
      console.log('✅ Phone login response:', response.status, response.data);
      
      const result = response.data;
      
      if (result.success) {
        if (result.user) {
          await this.persistLoginResult(result);
          console.log('💾 Stored phone login user data');
        }
        
        return {
          success: true,
          message: 'Login successful',
          user: result.user,
          token: result.token || result.access_token,
          refresh_token: result.refresh_token,
          session_info: result.session_info,
        };
      }
      
      return {
        success: false,
        message: result.message || 'Phone login failed',
      };
      
    } catch (error: any) {
      // console.error('❌ Phone login error:', error);
      throw new Error(error.response?.data?.message || 'Phone login failed');
    }
  }

  async checkPhone(phoneNumber: string, countryCode: string = 'US'): Promise<ApiResponse> {
    try {
      console.log('🔄 Checking phone number:', { phoneNumber, countryCode });
      
      const response = await this.client.post(MOBILE_ENDPOINTS.CHECK_PHONE, {
        phoneNumber,
        countryCode
      });
      
      console.log('✅ Phone check response:', response.status, response.data);
      return response.data;
    } catch (error: any) {
      // console.error('❌ Phone check error:', error);
      throw new Error(error.response?.data?.message || 'Failed to check phone number');
    }
  }

  // ==================== MOBILE USER MANAGEMENT ====================

  async getUserProfile(): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.USER);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch user profile');
    }
  }

  async updateUserProfile(data: any): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.USER, data);
      return response.data;
    } catch (error: any) {
      const err: any = new Error(
        error.response?.data?.message || 'Failed to update user profile',
      );
      err.response = error.response;
      err.data = error.response?.data;
      throw err;
    }
  }

  async requestEmailChange(data: {
    newEmail: string;
    currentPassword?: string;
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.USER_REQUEST_EMAIL_CHANGE, {
        newEmail: data.newEmail,
        ...(data.currentPassword ? { currentPassword: data.currentPassword } : {}),
      });
      return response.data;
    } catch (error: any) {
      const err: any = new Error(
        error.response?.data?.message || 'Failed to request email change',
      );
      err.response = error.response;
      err.data = error.response?.data;
      throw err;
    }
  }

  async cancelEmailChange(): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.USER_CANCEL_EMAIL_CHANGE);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to cancel email change');
    }
  }

  async verifyEmailChange(token: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.USER_VERIFY_EMAIL_CHANGE, {
        token,
      });
      const result = response.data;
      const hasTokens = !!(result?.token || result?.access_token || result?.refresh_token);
      // matched_session means this device kept a live JWT (tokens re-issued).
      const matchedSession =
        hasTokens &&
        (result?.matched_session === true ||
          result?.matchedSession === true ||
          hasTokens);
      const accountMatched =
        result?.account_matched === true ||
        result?.accountMatched === true ||
        matchedSession;
      if (result?.success && hasTokens) {
        await persistMobileAuthTokens({
          token: result.token ?? result.access_token,
          access_token: result.access_token ?? result.token,
          refresh_token: result.refresh_token,
        });
      }
      // Rewrite local identity only when tokens were re-issued (session kept).
      // Still update remembered / last-login email when this account matched but re-issue failed.
      const newEmail = (result?.email || result?.data?.email) as string | undefined;
      if (result?.success && newEmail && (matchedSession || accountMatched)) {
        try {
          if (matchedSession) {
            const raw = await secureStorage.getItem(STORAGE_KEYS.USER_DATA);
            if (raw) {
              const stored = JSON.parse(raw);
              stored.email = newEmail;
              await secureStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(stored));
            }
            const userRaw = await secureStorage.getItem('user');
            if (userRaw) {
              const storedUser = JSON.parse(userRaw);
              storedUser.email = newEmail;
              await secureStorage.setItem('user', JSON.stringify(storedUser));
            }
          }
          const remembered = await secureStorage.getItem('remembered_email');
          if (remembered) {
            await secureStorage.setItem('remembered_email', newEmail);
          }
          try {
            const deviceSecurityService = (await import('./deviceSecurity')).default;
            await deviceSecurityService.updateLastLoginEmail(newEmail);
          } catch {
            // non-fatal
          }
        } catch {
          // non-fatal
        }
      }
      if (result && typeof result === 'object') {
        (result as any).matched_session = matchedSession;
        (result as any).account_matched = accountMatched;
      }
      return result;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to verify email change');
    }
  }

  async changePassword(data: {
    currentPassword: string;
    newPassword: string;
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.USER, {
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });
      const result = response.data;
      if (result?.success && (result.token || result.access_token || result.refresh_token)) {
        await persistMobileAuthTokens({
          token: result.token ?? result.access_token,
          access_token: result.access_token ?? result.token,
          refresh_token: result.refresh_token,
        });
      }
      return result;
    } catch (error: any) {
      const err: any = new Error(
        error.response?.data?.message || 'Failed to change password',
      );
      err.response = error.response;
      err.data = error.response?.data;
      throw err;
    }
  }

  // ==================== MOBILE FILE MANAGEMENT ====================

  async getFiles(page = 1, perPage = 20, search?: string, category?: string, workspaceId?: number): Promise<ApiResponse> {
    try {
      const params = new URLSearchParams();
      params.append('page', page.toString());
      params.append('perPage', perPage.toString());
      if (search) params.append('search', search);
      if (category) params.append('category', category);
      if (workspaceId) params.append('workspace_id', workspaceId.toString());
      
      const response = await this.client.get(`${MOBILE_ENDPOINTS.FILES}?${params}`);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch files');
    }
  }

  /** Mobile upload returns task_id only — resolve the created file row by name after processing. */
  private normalizeUploadBasename(filename: string): string {
    let name = filename.trim();
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep raw if not valid URI encoding
    }
    return name.split(/[/\\]/).pop()?.toLowerCase() || '';
  }

  private listFilesFromApiResponse(res: ApiResponse): Array<{
    id?: number;
    original_filename?: string;
    filename?: string;
    name?: string;
    created_at?: string;
  }> {
    if (Array.isArray(res.files)) return res.files;
    if (Array.isArray(res.data)) return res.data as ApiResponse[];
    const nested = (res.data as { files?: unknown[] } | undefined)?.files;
    return Array.isArray(nested) ? (nested as ApiResponse[]) : [];
  }

  extractFileIdFromUploadProgress(
    progressData: unknown,
    filename?: string,
  ): number | undefined {
    const data = progressData as {
      uploaded_files?: Array<{ id?: number; filename?: string }>;
      files?: Array<{ id?: number; filename?: string; original_filename?: string }>;
    };
    const uploaded =
      data?.uploaded_files ??
      data?.files?.filter((f) => f?.id).map((f) => ({
        id: f.id,
        filename: f.filename || f.original_filename,
      }));
    if (!Array.isArray(uploaded) || !uploaded.length) return undefined;

    const target = filename ? this.normalizeUploadBasename(filename) : '';
    if (target) {
      for (const item of uploaded) {
        const name = this.normalizeUploadBasename(item.filename || '');
        if (item.id && (name === target || name.includes(target) || target.includes(name))) {
          return item.id;
        }
      }
    }
    return uploaded[0]?.id;
  }

  async lookupUploadedFileByName(
    filename: string,
    maxWaitMs = 90000,
    uploadedAfterMs?: number,
  ): Promise<number | undefined> {
    const target = this.normalizeUploadBasename(filename);
    if (!target) return undefined;

    const since = uploadedAfterMs ?? Date.now() - 180000;
    const deadline = Date.now() + maxWaitMs;
    const basename = filename.split(/[/\\]/).pop() || filename;

    while (Date.now() < deadline) {
      try {
        const queries = [...new Set([basename, target].filter(Boolean))];
        for (const q of queries) {
          const res = await this.getDocuments(1, 50, q, undefined, undefined, true, false, 20000);
          for (const f of this.listFilesFromApiResponse(res)) {
            if (!f.id) continue;
            const names = [f.original_filename, f.filename, f.name].map((n) =>
              this.normalizeUploadBasename(n || ''),
            );
            if (names.some((n) => n === target || (n && target && (n.includes(target) || target.includes(n))))) {
              return f.id;
            }
          }
        }

        const recent = await this.getDocuments(1, 25, undefined, undefined, undefined, true, false, 20000);
        const candidates = this.listFilesFromApiResponse(recent).filter((f) => {
          if (!f.id) return false;
          if (!f.created_at) return true;
          return new Date(f.created_at).getTime() >= since - 15000;
        });
        const named = candidates.filter((f) => {
          const names = [f.original_filename, f.filename, f.name].map((n) =>
            this.normalizeUploadBasename(n || ''),
          );
          return names.some((n) => n === target || (n && target && (n.includes(target) || target.includes(n))));
        });
        if (named.length >= 1) {
          named.sort(
            (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime(),
          );
          return named[0].id;
        }
      } catch {
        // File list may lag behind processing completion — retry.
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    return undefined;
  }

  /**
   * Upload file - backend automatically encrypts files on save
   * All file operations go through backend encryption class
   * Uses native fetch() for FormData on React Native (axios XMLHttpRequest often fails with FormData)
   */
  async uploadFile(file: FormData, onProgress?: (progress: number) => void): Promise<ApiResponse> {
    await assertUploadAllowedForCurrentNetwork();
    // Best-effort size/type checks when FormData exposes a file entry (RN multipart).
    try {
      const prefs = await getUserPreferences();
      const maybeFile = (file as any)?._parts?.find?.((p: any) => p?.[0] === 'file')?.[1];
      if (maybeFile && typeof maybeFile === 'object') {
        validateFileAgainstUploadSettings(
          {
            name: maybeFile.name || 'upload',
            size: maybeFile.size,
            type: maybeFile.type,
          },
          prefs,
        );
      }
    } catch (e) {
      if (e instanceof Error && (e.message.includes('File too large') || e.message.includes('not allowed'))) {
        throw e;
      }
    }

    const { Platform } = require('react-native');
    const isReactNative = Platform.OS === 'ios' || Platform.OS === 'android';

    if (isReactNative) {
      return this.uploadFileWithXHR(file, onProgress);
    }

    try {
      console.log('🔄 Attempting file upload (axios)...');
      console.log('🔐 File will be encrypted by backend encryption class on save');
      const response = await this.client.post(MOBILE_ENDPOINTS.UPLOAD, file, {
        timeout: 120000,
        transformRequest: (data: any) => data,
        onUploadProgress: (progressEvent: any) => {
          if (onProgress && progressEvent.total) {
            const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            onProgress(progress);
          }
        },
      });
      console.log('✅ Upload successful');
      return response.data;
    } catch (error: any) {
      console.error('❌ Upload failed:', error);
      let errorMessage = error.response?.data?.message || error.message || 'Upload failed';
      throw new Error(errorMessage);
    }
  }

  /**
   * Upload using XMLHttpRequest on React Native — supports real upload progress events
   * via xhr.upload.onprogress, unlike fetch which has no upload progress on mobile.
   * Falls back to fetch if XHR fails unexpectedly.
   */
  private async uploadFileWithXHR(file: FormData, onProgress?: (progress: number) => void): Promise<ApiResponse> {
    console.log('🔄 Attempting file upload (XHR with progress)...');
    const baseURL = this.client.defaults.baseURL || API_BASE_URL;
    const uploadUrl = baseURL + MOBILE_ENDPOINTS.UPLOAD;

    const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    const deviceToken = await secureStorage.getItem(STORAGE_KEYS.DEVICE_TOKEN);

    return new Promise<ApiResponse>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let lastReported = 0;
      let settled = false;
      let abortedForBackground = false;

      const finish = (handler: () => void) => {
        if (settled) return;
        settled = true;
        appStateSub.remove();
        handler();
      };

      const appStateSub = AppState.addEventListener('change', (next: AppStateStatus) => {
        if (settled) return;
        if (next === 'background' || next === 'inactive') {
          abortedForBackground = true;
          try {
            xhr.abort();
          } catch {
            // ignore
          }
        }
      });

      xhr.upload.addEventListener('loadstart', () => {
        if (onProgress) onProgress(Math.max(lastReported, 1));
      });

      xhr.upload.addEventListener('progress', (event) => {
        if (!onProgress) return;
        if (event.lengthComputable && event.total > 0) {
          const progress = Math.round((event.loaded / event.total) * 100);
          lastReported = Math.max(lastReported, progress);
          onProgress(lastReported);
        } else if (event.loaded > 0) {
          const soft = Math.min(92, 5 + Math.log10(event.loaded + 1) * 18);
          lastReported = Math.max(lastReported, soft);
          onProgress(lastReported);
        }
      });

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            console.log('✅ Upload successful (XHR)');
            finish(() => resolve(data));
          } catch {
            finish(() => reject(new Error('Invalid JSON response from server')));
          }
        } else {
          let errData: any = {};
          try {
            errData = JSON.parse(xhr.responseText);
          } catch {
            errData = { message: xhr.statusText };
          }
          finish(() => reject(new Error(errData.message || `Upload failed with status ${xhr.status}`)));
        }
      };

      xhr.onabort = () => {
        if (abortedForBackground) {
          finish(() => reject(new Error('Upload paused (app backgrounded)')));
          return;
        }
        finish(() => reject(new Error('Upload aborted')));
      };

      xhr.onerror = () => {
        console.error('❌ Upload failed (XHR network error)');
        finish(() => reject(new Error('Upload failed (XHR network error)')));
      };
      xhr.ontimeout = () => {
        console.error('❌ Upload timed out (XHR)');
        finish(() => reject(new Error('Upload timed out (XHR)')));
      };

      xhr.open('POST', uploadUrl);
      xhr.timeout = 300000;

      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      if (deviceToken) xhr.setRequestHeader('X-Device-Token', deviceToken);
      xhr.setRequestHeader('X-Platform', 'mobile');
      if (baseURL.startsWith('https://')) {
        xhr.setRequestHeader('X-Forwarded-Proto', 'https');
        xhr.setRequestHeader('X-Forwarded-Scheme', 'https');
      }

      xhr.send(file as any);
    });
  }

  async getUploadProgress(taskId: string, opts?: { quiet?: boolean }): Promise<ApiResponse> {
    try {
      if (!opts?.quiet) {
        console.log(`🔄 Checking upload progress for task: ${taskId}`);
      }
      const response = await this.client.get(`/api/v1/mobile/progress/${taskId}`, {
        timeout: 10000 // 10 second timeout for progress requests
      });
      if (!opts?.quiet) {
        console.log(`📊 Progress response for ${taskId}:`, response.data);
      }
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to get upload progress');
    }
  }

  async uploadFileWithProgressPolling(
    file: FormData, 
    onProgress?: (progress: number, message?: string, phase?: string) => void,
    options?: { filename?: string; uploadStartedAt?: number },
  ): Promise<ApiResponse> {
    const uploadStartedAt = options?.uploadStartedAt ?? Date.now();
    const smoother = createSmoothProgressEmitter(
      (p, m, ph) => onProgress?.(p, m, ph),
      { uploadPhaseMax: 40, tickMs: 100 }
    );
    smoother.start();
    smoother.setTarget(0.5, 'Preparing upload...', 'upload');

    const settleAndStop = (msg: string, phase: string) =>
      new Promise<void>((r) => {
        smoother.setTarget(100, msg, phase);
        setTimeout(() => {
          onProgress?.(100, msg, phase);
          smoother.stop();
          r();
        }, 420);
      });

    try {
      console.log('🔄 Starting upload with progress polling (smoothed)...');

      // 0–40%: network upload (XHR may report rarely on RN — smoother crawls the gap)
      const uploadResponse = await this.uploadFileWithRetry(
        file,
        5,
        (networkProgress) => {
          smoother.setTarget(networkProgress * 0.4, 'Uploading file...', 'upload');
        },
        {
          onSuspended: () => smoother.setMessage('Waiting — return to app to continue', 'upload'),
          onResumed: () => smoother.setMessage('Uploading file...', 'upload'),
        },
      );
      // HTTP finished — anchor at end of upload phase while we wait for task / polling
      smoother.setTarget(40, 'Processing on server...', 'processing');

      const taskId = (uploadResponse as any).task_id;

      const enrichWithFileId = async (
        base: ApiResponse,
        progressData?: unknown,
      ): Promise<ApiResponse> => {
        const existing = (base as { file?: { id?: number } }).file?.id;
        if (existing) return base;

        const fromProgress = progressData
          ? this.extractFileIdFromUploadProgress(progressData, options?.filename)
          : undefined;
        if (fromProgress) return { ...base, file: { id: fromProgress } };

        if (!options?.filename) return base;
        onProgress?.(undefined as unknown as number, 'Locating uploaded file...', 'processing');
        const fileId = await this.lookupUploadedFileByName(
          options.filename,
          90000,
          uploadStartedAt,
        );
        if (!fileId) return base;
        return { ...base, file: { id: fileId } };
      };

      if (!taskId) {
        console.warn('⚠️ No task_id in upload response, cannot poll progress');
        await settleAndStop('Upload completed', 'completed');
        return await enrichWithFileId(uploadResponse);
      }

      console.log(`📋 Got task_id: ${taskId}, starting progress polling...`);

      // 40–100%: server-side processing (map backend 0–100 → 40–100)
      return await new Promise<ApiResponse>((resolve, reject) => {
        const maxPollTime = 300000;
        const startTime = Date.now();
        let settled = false;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let lastServerProgress = -1;
        let lastStatus = '';
        let lastProgressChangeAt = Date.now();
        let pollDelayMs = 500;
        let lastLookupAttemptAt = 0;
        let loggedPollSummary = false;

        const finish = async (
          outcome: 'resolve' | 'reject',
          payload?: ApiResponse | Error,
          progressData?: unknown,
          settleMsg?: string,
          settlePhase?: string,
        ) => {
          if (settled) return;
          settled = true;
          if (pollTimer) clearTimeout(pollTimer);
          appStateSub.remove();
          if (settleMsg && settlePhase) {
            await settleAndStop(settleMsg, settlePhase);
          } else {
            smoother.stop();
          }
          if (outcome === 'reject') {
            reject(payload instanceof Error ? payload : new Error('Upload processing failed'));
            return;
          }
          const base = (payload ?? uploadResponse) as ApiResponse;
          resolve(await enrichWithFileId({ ...base, task_id: taskId }, progressData));
        };

        const schedulePoll = (delayMs: number) => {
          if (settled) return;
          if (pollTimer) clearTimeout(pollTimer);
          pollTimer = setTimeout(() => {
            void pollProgress();
          }, delayMs);
        };

        const tryEarlyCompletion = async (progressData: unknown): Promise<boolean> => {
          const fileId = this.extractFileIdFromUploadProgress(progressData, options?.filename);
          if (fileId) {
            await finish('resolve', uploadResponse, progressData, 'Processing complete', 'completed');
            return true;
          }
          if (!options?.filename) return false;
          const stuckMs = Date.now() - lastProgressChangeAt;
          if (stuckMs < 30000 || Date.now() - lastLookupAttemptAt < 15000) return false;
          lastLookupAttemptAt = Date.now();
          smoother.setMessage('Locating uploaded file...', 'processing');
          const lookedUp = await this.lookupUploadedFileByName(
            options.filename,
            12000,
            uploadStartedAt,
          );
          if (lookedUp) {
            await finish(
              'resolve',
              { ...uploadResponse, file: { id: lookedUp } },
              progressData,
              'Processing complete',
              'completed',
            );
            return true;
          }
          return false;
        };

        const appStateSub = AppState.addEventListener('change', (next: AppStateStatus) => {
          if (settled) return;
          if (next === 'background' || next === 'inactive') {
            pollDelayMs = Math.max(pollDelayMs, 4000);
            smoother.setMessage('Processing paused — return to app', 'processing');
          } else if (next === 'active') {
            pollDelayMs = 500;
            smoother.setMessage('Processing on server...', 'processing');
            schedulePoll(100);
          }
        });

        const pollProgress = async (): Promise<void> => {
          if (settled) return;
          if (isAppBackgrounded()) {
            pollDelayMs = Math.max(pollDelayMs, 4000);
            schedulePoll(pollDelayMs);
            return;
          }

          try {
            const quiet = lastServerProgress >= 0 && Date.now() - lastProgressChangeAt > 5000;
            const progressResponse = await this.getUploadProgress(taskId, { quiet });

            if (progressResponse.success && progressResponse.data) {
              const progressData = progressResponse.data;
              const { progress, status, message, phase } = progressData;
              const serverProgress = Math.min(100, Math.max(0, progress ?? 0));
              const statusStr = String(status ?? '');

              if (serverProgress !== lastServerProgress || statusStr !== lastStatus) {
                lastServerProgress = serverProgress;
                lastStatus = statusStr;
                lastProgressChangeAt = Date.now();
                pollDelayMs = 500;
                loggedPollSummary = false;
              } else {
                const stuckMs = Date.now() - lastProgressChangeAt;
                if (stuckMs > 5000) {
                  pollDelayMs = Math.min(4000, pollDelayMs + 250);
                }
                if (!loggedPollSummary) {
                  console.log(
                    `📊 Upload task ${taskId} still ${statusStr} at ${serverProgress}% — backing off polls`,
                  );
                  loggedPollSummary = true;
                }
              }

              const mapped =
                statusStr === 'completed'
                  ? 100
                  : 40 + serverProgress * 0.6;

              smoother.setTarget(
                mapped,
                message || 'Processing...',
                typeof phase === 'string' ? phase : 'processing',
              );

              if (statusStr === 'error') {
                await finish(
                  'reject',
                  new Error(message || 'Upload processing failed'),
                  progressData,
                  message || 'Processing failed',
                  'error',
                );
                return;
              }

              if (statusStr === 'completed') {
                await finish('resolve', uploadResponse, progressData, 'Processing complete', 'completed');
                return;
              }

              if (await tryEarlyCompletion(progressData)) return;

              if (Date.now() - startTime < maxPollTime) {
                schedulePoll(pollDelayMs);
              } else {
                console.warn('⚠️ Progress polling timeout reached');
                await finish('resolve', uploadResponse, progressData, 'Processing timeout', 'timeout');
              }
            } else {
              if (!progressResponse.success && progressResponse.message?.includes('not found')) {
                smoother.setTarget(42, 'Processing started...', 'processing');
              }
              if (Date.now() - startTime < maxPollTime) {
                schedulePoll(Math.max(pollDelayMs, 1000));
              } else {
                await finish('resolve', uploadResponse, undefined, 'Processing complete', 'completed');
              }
            }
          } catch {
            if (Date.now() - startTime < maxPollTime) {
              schedulePoll(Math.max(pollDelayMs, 1500));
            } else {
              await finish('resolve', uploadResponse, undefined, 'Processing complete', 'completed');
            }
          }
        };

        schedulePoll(50);
      });
    } catch (error: any) {
      smoother.stop();
      throw error;
    }
  }

  async deleteFile(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(MOBILE_ENDPOINTS.FILE_DELETE(id));
      const raw = response.data as ApiResponse | null | undefined;
      // Many DELETE handlers return 204/empty body or JSON without `success`; treat 2xx as OK unless explicitly false.
      if (raw == null || raw === '' || (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw as object).length === 0)) {
        return { success: true };
      }
      if (typeof raw === 'object' && raw !== null && !('success' in raw)) {
        return { success: true, ...raw };
      }
      return raw as ApiResponse;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Delete failed');
    }
  }

  /**
   * Rename a file (web endpoint).
   * PUT /api/v1/web/files/:id/rename with body { filename }.
   */
  async renameFile(fileId: number, filename: string): Promise<ApiResponse> {
    const response = await this.client.put(`/api/v1/web/files/${fileId}/rename`, { filename });
    return response.data;
  }

  // ==================== DRAFT API (web endpoints, Bearer auth) ====================

  /**
   * List drafts: get files with category=Draft (server-side filter when supported).
   * Falls back to client filter if backend does not return only drafts.
   */
  async getDrafts(): Promise<ApiResponse> {
    // Use getDocuments for resilience: 25s timeout + fallback to getFiles on error
    const res = await this.getDocuments(1, 100, undefined, 'Draft');
    const raw = res?.data?.files ?? res?.data?.data ?? res?.files ?? (Array.isArray(res?.data) ? res.data : []);
    const list = Array.isArray(raw) ? raw : [];
    const drafts = list.filter((f: any) => (f.file_kind || '').toString().toLowerCase() === 'draft');
    return { ...res, success: res?.success !== false, data: { drafts }, drafts };
  }

  /**
   * Create a draft. POST /api/v1/web/drafts/create. Body: {} or { source_file_id }.
   */
  async createDraft(sourceFileId?: number): Promise<ApiResponse> {
    const response = await this.client.post('/api/v1/web/drafts/create', sourceFileId != null ? { source_file_id: sourceFileId } : {});
    return response.data;
  }

  /**
   * Get draft content. GET /api/v1/web/files/:id/draft-content.
   */
  async getDraftContent(draftId: number, token?: string): Promise<ApiResponse> {
    const config = token ? { params: { token } } : {};
    const response = await this.client.get(`/api/v1/web/files/${draftId}/draft-content`, config);
    return response.data;
  }

  /**
   * Save draft. PUT /api/v1/web/files/:id/edit with { content_html, content_text }.
   */
  async saveDraft(draftId: number, contentHtml: string, contentText: string, shareToken?: string): Promise<ApiResponse> {
    const body: { content_html: string; content_text: string; token?: string } = { content_html: contentHtml, content_text: contentText };
    if (shareToken) body.token = shareToken;
    const response = await this.client.put(`/api/v1/web/files/${draftId}/edit`, body);
    return response.data;
  }

  /**
   * Move draft to trash (soft delete). Uses the mobile file endpoint so JWT auth matches
   * the rest of the app; web-only session is not required (see mobile_delete_file → perform_soft_delete).
   */
  async deleteDraft(draftId: number): Promise<ApiResponse> {
    return this.deleteFile(draftId);
  }

  /** Soft-deleted files (trash). GET /api/v1/web/files/deleted */
  async getDeletedFiles(
    page = 1,
    perPage = 100
  ): Promise<
    ApiResponse & {
      files?: Array<{
        id: number;
        original_filename?: string;
        filename?: string;
        file_kind?: string;
        file_type?: string;
        file_size?: number;
        deleted_at?: string | null;
        purge_at?: string | null;
        days_remaining?: number | null;
        lifecycle_state?: string;
      }>;
      folder_groups?: import('../types/folder').DeletedFolderGroup[];
      standalone_files?: import('../types/folder').FileRowModel[];
      pagination?: { page: number; per_page: number; total: number; has_more: boolean };
      retention_days?: number;
    }
  > {
    try {
      const { getDeletedFilesWithFolders } = await import('./folderApi');
      return await getDeletedFilesWithFolders(this.client, page, perPage);
    } catch (error: any) {
      return {
        success: false,
        files: [],
        folder_groups: [],
        standalone_files: [],
        message: error.response?.data?.message || 'Failed to load deleted files',
      };
    }
  }

  // ==================== FOLDERS (web endpoints, Bearer auth) ====================

  async resolveEffectiveWorkspaceId(options?: {
    folderId?: number | null;
    explicitWorkspaceId?: number;
  }): Promise<number | null> {
    const { resolveEffectiveWorkspaceId: resolve } = await import('./folderApi');
    return resolve(this.client, options);
  }

  async getWebFiles(params: import('../types/folder').GetWebFilesParams) {
    const { getWebFiles: fetch } = await import('./folderApi');
    return fetch(this.client, params);
  }

  async listFolders(options?: {
    parentId?: number | null;
    workspaceId?: number;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }) {
    const { listFolders: list } = await import('./folderApi');
    return list(this.client, options);
  }

  async getFolderDetail(folderId: number, signal?: AbortSignal) {
    const { getFolder } = await import('./folderApi');
    return getFolder(this.client, folderId, signal);
  }

  async createFolder(body: {
    name: string;
    workspace_id: number;
    parent_folder_id?: number | null;
  }) {
    const { createFolder: create } = await import('./folderApi');
    return create(this.client, body);
  }

  async renameFolder(folderId: number, name: string) {
    const { renameFolder: rename } = await import('./folderApi');
    return rename(this.client, folderId, name);
  }

  async deleteFolderById(folderId: number) {
    const { deleteFolder } = await import('./folderApi');
    return deleteFolder(this.client, folderId);
  }

  async moveFolderToParent(folderId: number, parentFolderId: number | null) {
    const { moveFolder } = await import('./folderApi');
    return moveFolder(this.client, folderId, parentFolderId);
  }

  async moveFilesToFolder(fileIds: number[], folderId?: number | null) {
    const { moveFilesToFolder: move } = await import('./folderApi');
    return move(this.client, fileIds, folderId);
  }

  async restoreFolderFromTrash(folderId: number) {
    const { restoreFolder } = await import('./folderApi');
    return restoreFolder(this.client, folderId);
  }

  async permanentlyDeleteFolderFromTrash(folderId: number) {
    const { permanentlyDeleteFolder } = await import('./folderApi');
    return permanentlyDeleteFolder(this.client, folderId);
  }

  /** Restore from trash. POST /api/v1/web/files/:id/trash-restore (may return 202) */
  async restoreFileFromTrash(fileId: number): Promise<ApiResponse & { status?: string }> {
    try {
      const response = await this.client.post(`/api/v1/web/files/${fileId}/trash-restore`);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to restore file');
    }
  }

  /** Permanent delete while in trash. DELETE /api/v1/web/files/:id/permanent?confirmed=true */
  async permanentlyDeleteTrashedFile(fileId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(`/api/v1/web/files/${fileId}/permanent?confirmed=true`);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to permanently delete file');
    }
  }

  /**
   * Create share link for a file (draft or any file). POST /api/v1/web/files/:id/create-link.
   */
  async createFileShareLink(fileId: number, options?: { role?: 'viewer' | 'member' | 'admin'; expires_in_days?: number }): Promise<ApiResponse> {
    const response = await this.client.post(`/api/v1/web/files/${fileId}/create-link`, options || {});
    return response.data;
  }

  /**
   * Send share link by email. POST /api/v1/web/files/:id/send-share-link.
   */
  async sendFileShareLinkEmail(
    fileId: number,
    params: { share_link: string; emails: string[]; message?: string; role?: string; expires_in_days?: number }
  ): Promise<ApiResponse> {
    const response = await this.client.post(`/api/v1/web/files/${fileId}/send-share-link`, params);
    return response.data;
  }

  /**
   * Get all external shares for a file
   */
  async getFileExternalShares(fileId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.get(`/api/v1/web/files/${fileId}/external-shares`);
      return response.data;
    } catch (error: any) {
      const msg = error?.response?.data?.message ?? error?.message;
      throw new Error(typeof msg === 'string' ? msg : 'Failed to fetch external shares');
    }
  }

  /**
   * Revoke an external file share
   */
  async revokeFileShare(fileId: number, shareId: number): Promise<ApiResponse> {
    const response = await this.client.delete(`/api/v1/web/files/${fileId}/external-shares/${shareId}`);
    return response.data;
  }

  /**
   * Permanently delete a revoked external file share
   */
  async deleteFileShare(fileId: number, shareId: number): Promise<ApiResponse> {
    const response = await this.client.delete(`/api/v1/web/files/${fileId}/external-shares/${shareId}?permanent=true`);
    return response.data;
  }

  // ==================== CHUNKED UPLOAD METHODS ====================
  // Resilient file upload with chunking, resume, and retry support

  /**
   * Initialize a chunked upload session
   */
  async initChunkedUpload(
    filename: string,
    fileSize: number,
    fileType: string = 'application/octet-stream',
    workspaceId?: number
  ): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.UPLOAD_INIT, {
        filename,
        file_size: fileSize,
        file_type: fileType,
        workspace_id: workspaceId
      });
      return response.data;
    } catch (error: any) {
      const err = new Error(error.response?.data?.message || 'Failed to initialize upload');
      (err as any).responseData = error.response?.data;
      throw err;
    }
  }

  /**
   * Upload a single chunk
   */
  async uploadChunk(
    uploadId: string,
    chunkIndex: number,
    totalChunks: number,
    chunkBlob: Blob,
    onProgress?: (progress: number) => void
  ): Promise<ApiResponse> {
    try {
      const formData = new FormData();
      formData.append('upload_id', uploadId);
      formData.append('chunk_index', chunkIndex.toString());
      formData.append('total_chunks', totalChunks.toString());
      formData.append('chunk', chunkBlob as any);

      const response = await this.client.post(MOBILE_ENDPOINTS.UPLOAD_CHUNK, formData, {
        // Don't set Content-Type - React Native FormData will set it with proper boundary
        onUploadProgress: (progressEvent) => {
          if (onProgress && progressEvent.total) {
            const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            onProgress(progress);
          }
        },
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to upload chunk');
    }
  }

  /**
   * Complete chunked upload
   */
  async completeChunkedUpload(uploadId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.UPLOAD_COMPLETE, {
        upload_id: uploadId
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to complete upload');
    }
  }

  /**
   * Get upload status (for resume)
   */
  async getUploadStatus(uploadId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.UPLOAD_STATUS, {
        params: { upload_id: uploadId }
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to get upload status');
    }
  }

  /**
   * Cancel upload
   */
  async cancelUpload(uploadId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.UPLOAD_CANCEL, {
        upload_id: uploadId
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to cancel upload');
    }
  }

  /**
   * Pause upload
   */
  async pauseUpload(uploadId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.UPLOAD_PAUSE, {
        upload_id: uploadId
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to pause upload');
    }
  }

  /**
   * Resume upload
   */
  async resumeUpload(uploadId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.UPLOAD_RESUME, {
        upload_id: uploadId
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to resume upload');
    }
  }

  /**
   * Upload file with retry (for small files < 5MB)
   */
  async uploadFileWithRetry(
    file: FormData,
    maxRetries: number = 3,
    onProgress?: (progress: number) => void,
    retryCallbacks?: UploadRetryCallbacks,
  ): Promise<ApiResponse> {
    return withUploadForegroundRetry(
      () => this.uploadFile(file, onProgress),
      {
        maxForegroundRetries: maxRetries,
        onSuspended: retryCallbacks?.onSuspended,
        onResumed: retryCallbacks?.onResumed,
      },
    );
  }

  /**
   * Upload file using chunked upload (for large files >= 5MB)
   * Supports resume, pause, cancel, parallel uploads, and AppState monitoring
   */
  async uploadFileChunked(
    fileUri: string,
    filename: string,
    fileType: string = 'application/octet-stream',
    workspaceId?: number,
    chunkSize: number = 5 * 1024 * 1024, // 5MB default
    signal?: AbortSignal,
    onProgress?: (progress: number, message?: string, phase?: string) => void,
    onPause?: () => void,
    onResume?: () => void,
    maxParallelUploads: number = 3 // Number of chunks to upload simultaneously
  ): Promise<ApiResponse> {
    try {
      await assertUploadAllowedForCurrentNetwork();

      // Read file to get size
      const response = await fetch(fileUri);
      const blob = await response.blob();
      const fileSize = blob.size;
      
      console.log(`📤 [CHUNKED] Starting chunked upload: ${filename} (${fileSize} bytes)`);
      
      // Step 1: Initialize upload
      const initResponse = await this.initChunkedUpload(filename, fileSize, fileType, workspaceId);
      if (!initResponse.success || !initResponse.upload_id) {
        throw new Error(initResponse.message || 'Failed to initialize upload');
      }
      
      const uploadId = initResponse.upload_id;
      const totalChunks = initResponse.total_chunks;
      const actualChunkSize = initResponse.chunk_size || chunkSize;
      
      // Validate required fields
      if (!uploadId) {
        throw new Error('Upload ID is required');
      }
      if (!totalChunks || totalChunks <= 0) {
        throw new Error('Total chunks is required and must be greater than 0');
      }
      
      // TypeScript type narrowing: after validation, totalChunks is definitely a number
      const validatedTotalChunks: number = totalChunks;
      
      console.log(`📤 [CHUNKED] Upload initialized: ${uploadId}, ${validatedTotalChunks} chunks`);
      
      // Step 2: Check for resume (get already uploaded chunks)
      let uploadedChunks = new Set<number>();
      try {
        const statusResponse = await this.getUploadStatus(uploadId);
        if (statusResponse.success && statusResponse.uploaded_chunks) {
          uploadedChunks = new Set(statusResponse.uploaded_chunks);
          console.log(`📤 [CHUNKED] Resuming upload: ${uploadedChunks.size}/${validatedTotalChunks} chunks already uploaded`);
        }
      } catch (statusError) {
        console.warn('⚠️ [CHUNKED] Could not get upload status, starting fresh');
      }
      
      // Step 3: Upload chunks (with parallel support; resume after app background)
      let isPaused = false;
      
      try {
        // Prepare chunks to upload (skip already uploaded)
        const chunksToUpload: number[] = [];
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          if (!uploadedChunks.has(chunkIndex)) {
            chunksToUpload.push(chunkIndex);
          } else {
            const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
            onProgress?.(progress, `Chunk ${chunkIndex + 1}/${totalChunks} (already uploaded)`, 'upload');
          }
        }
        
        // Upload chunks in parallel batches
        const uploadChunkWithRetry = async (chunkIndex: number): Promise<void> => {
          // Check abort signal
          if (signal?.aborted) {
            throw new Error('Upload cancelled');
          }
          
          // Check if manually paused
          while (isPaused && !signal?.aborted) {
            await new Promise(resolve => setTimeout(resolve, 500));
            try {
              const status = await this.getUploadStatus(uploadId);
              if (!status.paused) {
                isPaused = false;
                onResume?.();
                console.log('▶️ [CHUNKED] Upload resumed');
              }
            } catch {
              // Ignore status check errors
            }
          }
          
          if (signal?.aborted) {
            throw new Error('Upload cancelled');
          }
          
          // Read chunk from blob
          const start = chunkIndex * actualChunkSize;
          const end = Math.min(start + actualChunkSize, fileSize);
          const chunkBlob = blob.slice(start, end);
          
          // Upload chunk with retry
          let chunkUploaded = false;
          let retryCount = 0;
          const maxChunkRetries = 3;
          
          while (!chunkUploaded && retryCount < maxChunkRetries) {
            try {
              await this.uploadChunk(
                uploadId,
                chunkIndex,
                validatedTotalChunks,
                chunkBlob,
                (chunkProgress) => {
                  // Calculate overall progress including all chunks
                  const completedChunks = uploadedChunks.size;
                  const currentChunkProgress = chunkProgress / 100; // 0-1
                  const overallProgress = Math.round(
                    ((completedChunks + currentChunkProgress) / validatedTotalChunks) * 100
                  );
                  onProgress?.(overallProgress, `Uploading chunk ${chunkIndex + 1}/${validatedTotalChunks}`, 'upload');
                }
              );
              chunkUploaded = true;
              uploadedChunks.add(chunkIndex);
              console.log(`✅ [CHUNKED] Chunk ${chunkIndex + 1}/${totalChunks} uploaded`);
            } catch (chunkError: any) {
              if (isAppBackgrounded()) {
                onPause?.();
                onProgress?.(
                  Math.round((uploadedChunks.size / validatedTotalChunks) * 100),
                  'Waiting — return to app to continue',
                  'upload',
                );
                await waitForAppActive();
                onResume?.();
                continue;
              }
              retryCount++;
              if (retryCount >= maxChunkRetries) {
                throw new Error(`Failed to upload chunk ${chunkIndex + 1} after ${maxChunkRetries} attempts: ${chunkError.message}`);
              }
              // Exponential backoff
              const delay = Math.pow(2, retryCount) * 1000;
              console.log(`⏳ [CHUNKED] Retrying chunk ${chunkIndex + 1} in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        };
        
        // Upload chunks in parallel batches
        for (let i = 0; i < chunksToUpload.length; i += maxParallelUploads) {
          // Check abort signal before starting batch
          if (signal?.aborted) {
            console.log('🛑 [CHUNKED] Abort signal received, cancelling upload');
            await this.cancelUpload(uploadId);
            throw new Error('Upload cancelled');
          }
          
          // Wait if paused
          while (isPaused && !signal?.aborted) {
            await new Promise(resolve => setTimeout(resolve, 500));
            try {
              const status = await this.getUploadStatus(uploadId);
              if (!status.paused) {
                isPaused = false;
                onResume?.();
                console.log('▶️ [CHUNKED] Upload resumed');
              }
            } catch {
              // Ignore status check errors
            }
          }
          
          if (signal?.aborted) {
            await this.cancelUpload(uploadId);
            throw new Error('Upload cancelled');
          }
          
          // Upload batch of chunks in parallel
          const batch = chunksToUpload.slice(i, i + maxParallelUploads);
          console.log(`📤 [CHUNKED] Uploading batch: chunks ${batch.map(c => c + 1).join(', ')} (${batch.length} parallel)`);
          
          await Promise.all(batch.map(chunkIndex => uploadChunkWithRetry(chunkIndex)));
          
          // Update progress after batch
          const progress = Math.round((uploadedChunks.size / validatedTotalChunks) * 100);
          onProgress?.(progress, `Uploaded ${uploadedChunks.size}/${validatedTotalChunks} chunks`, 'upload');
        }
      } finally {
        // no-op
      }
      
      // Step 4: Complete upload
      console.log(`📦 [CHUNKED] All chunks uploaded, finalizing...`);
      onProgress?.(95, 'Finalizing upload...', 'finalizing');
      const completeResponse = await this.completeChunkedUpload(uploadId);
      
      if (!completeResponse.success) {
        throw new Error(completeResponse.message || 'Failed to complete upload');
      }
      
      onProgress?.(100, 'Upload complete', 'completed');
      console.log(`✅ [CHUNKED] Upload completed: ${uploadId}`);
      
      return completeResponse;
      
    } catch (error: any) {
      console.error('❌ [CHUNKED] Chunked upload failed:', error);
      throw error;
    }
  }

  /**
   * Hybrid upload - automatically chooses chunked or retry based on file size
   * Files >= 5MB use chunked upload, smaller files use retry
   */
  async uploadFileHybrid(
    file: FormData | { uri: string; name: string; type?: string; size?: number },
    workspaceId?: number,
    signal?: AbortSignal,
    onProgress?: (progress: number, message?: string, phase?: string) => void,
    onPause?: () => void,
    onResume?: () => void
  ): Promise<ApiResponse> {
    const CHUNKED_THRESHOLD = 5 * 1024 * 1024; // 5MB
    
    // Determine file size
    let fileSize: number;
    let fileUri: string;
    let filename: string;
    let fileType: string;
    
    if (file instanceof FormData) {
      // FormData - use simple retry (can't easily get size from FormData)
      console.log('📤 [HYBRID] Using retry upload (FormData)');
      return await this.uploadFileWithRetry(file, 3, (progress) => {
        onProgress?.(progress, 'Uploading file...', 'upload');
      });
    } else {
      // File object with URI
      fileUri = file.uri;
      filename = file.name;
      fileType = file.type || 'application/octet-stream';
      fileSize = file.size || 0;
      
      // If size not provided, try to get it
      if (!fileSize) {
        try {
          const response = await fetch(fileUri);
          const blob = await response.blob();
          fileSize = blob.size;
        } catch (e) {
          console.warn('⚠️ [HYBRID] Could not determine file size, using retry upload');
          // Fallback to retry upload
          const formData = new FormData();
          formData.append('file', {
            uri: fileUri,
            type: fileType,
            name: filename,
          } as any);
          return await this.uploadFileWithRetry(formData, 3, (progress) => {
            onProgress?.(progress, 'Uploading file...', 'upload');
          });
        }
      }
    }
    
    // Choose method based on size
    if (fileSize >= CHUNKED_THRESHOLD) {
      console.log(`📤 [HYBRID] Using chunked upload (${fileSize} bytes >= ${CHUNKED_THRESHOLD})`);
      return await this.uploadFileChunked(
        fileUri!,
        filename!,
        fileType!,
        workspaceId,
        5 * 1024 * 1024, // 5MB chunks
        signal,
        onProgress,
        onPause,
        onResume,
        3 // maxParallelUploads: upload 3 chunks simultaneously
      );
    } else {
      console.log(`📤 [HYBRID] Using retry upload (${fileSize} bytes < ${CHUNKED_THRESHOLD})`);
      const formData = new FormData();
      formData.append('file', {
        uri: fileUri!,
        type: fileType!,
        name: filename!,
      } as any);
      return await this.uploadFileWithRetry(formData, 3, (progress) => {
        onProgress?.(progress, 'Uploading file...', 'upload');
      });
    }
  }

  /**
   * Get file by ID. Pass workspaceId when the file was listed from a workspace so the
   * backend can apply the same visibility (workspace membership) as the list endpoints.
   */
  async getFileById(id: number, workspaceId?: number): Promise<ApiResponse> {
    try {
      const url = MOBILE_ENDPOINTS.FILE_BY_ID(id);
      const config = workspaceId != null ? { params: { workspace_id: workspaceId } } : undefined;
      const response = await this.client.get(url, config);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to get file');
    }
  }

  /**
   * Download file - backend automatically decrypts encrypted files
   * All file operations go through backend encryption class
   */
  async downloadFile(id: number): Promise<{ url: string; filename: string; blob?: Blob }> {
    try {
      console.log('🔄 Downloading file with ID:', id);
      console.log('🔐 File will be decrypted by backend encryption class');
      
      // First get the file info
      const infoResponse = await this.client.get(MOBILE_ENDPOINTS.FILE_BY_ID(id));
      const fileInfo = infoResponse.data?.file;
      const filename = fileInfo?.name || `document_${id}`;

      const signedDl = fileInfo?.signed_download_url as string | undefined;
      const rawDl = fileInfo?.download_url as string | undefined;

      let downloadUrl: string;
      if (typeof signedDl === 'string' && signedDl.trim().length > 0) {
        downloadUrl = signedDl.startsWith('http') ? signedDl : `${API_BASE_URL}${signedDl.startsWith('/') ? '' : '/'}${signedDl}`;
      } else if (typeof rawDl === 'string' && rawDl.trim().length > 0) {
        if (rawDl.startsWith('http')) {
          downloadUrl = rawDl;
        } else {
          downloadUrl = `${API_BASE_URL}${rawDl.startsWith('/') ? '' : '/'}${rawDl}`;
        }
      } else {
        downloadUrl = `${API_BASE_URL}${MOBILE_ENDPOINTS.FILE_DOWNLOAD(id)}`;
      }

      console.log('📁 File download URL:', downloadUrl);
      console.log('📁 File name:', filename);
      console.log('🔐 Backend will decrypt file before serving');
      
      return {
        url: downloadUrl,
        filename: filename
      };
      
    } catch (error: any) {
      // console.error('❌ Download file error:', error);
      throw new Error(error.response?.data?.message || 'Download failed');
    }
  }

  /**
   * View file - backend automatically decrypts encrypted files for viewing
   * All file operations go through backend encryption class
   */
  async viewFile(id: number): Promise<{ url: string; filename: string }> {
    try {
      console.log('🔄 Viewing file with ID:', id);
      console.log('🔐 File will be decrypted by backend encryption class');
      
      // First get the file info
      const infoResponse = await this.client.get(MOBILE_ENDPOINTS.FILE_BY_ID(id));
      const fileInfo = infoResponse.data?.file;
      const filename = fileInfo?.name || `document_${id}`;
      
      // Use view endpoint if available, otherwise fallback to download
      // Backend handles decryption automatically
      const viewUrl = `${API_BASE_URL}${MOBILE_ENDPOINTS.FILE_VIEW(id)}`;
      
      console.log('📁 File view URL:', viewUrl);
      console.log('📁 File name:', filename);
      console.log('🔐 Backend will decrypt file before serving');
      
      return {
        url: viewUrl,
        filename: filename
      };
      
    } catch (error: any) {
      // Fallback to download endpoint if view endpoint doesn't exist
      console.log('⚠️ View endpoint not available, falling back to download endpoint');
      return this.downloadFile(id);
    }
  }

  async categorizeFile(id: number, category: string): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.FILE_CATEGORIZE(id), { category });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Categorize failed');
    }
  }

  async autoCategorizeFile(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.FILE_AUTO_CATEGORIZE(id));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Auto-categorize failed');
    }
  }

  // ==================== MOBILE CHAT ====================
  // All chat communication and responses are encrypted by backend

  /**
   * Send chat message - backend automatically encrypts messages and responses
   * All chat operations go through backend encryption class
   */
  async sendChatMessage(message: string, filters?: any, signal?: AbortSignal): Promise<ApiResponse> {
    try {
      console.log('💬 Sending chat message');
      console.log('🔐 Message and response will be encrypted by backend encryption class');
      const payload: any = { 
        message,
        response_mode: 'flexible', // Use same response mode as web
        user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      };
      
      // Map filters to the same format as web
      if (filters) {
        if (filters.context_file_ids) {
          payload.context_file_ids = filters.context_file_ids;
        }
        if (filters.context_bookmark_ids) {
          payload.context_bookmark_ids = filters.context_bookmark_ids;
        }
        if (filters.context_transcript_ids) {
          payload.context_transcript_ids = filters.context_transcript_ids;
        }
        if (filters.search_type) {
          payload.search_type = filters.search_type;
        }
        if (filters.chat_history_id) {
          payload.chat_history_id = filters.chat_history_id;
        }
        // Map other filter properties
        Object.keys(filters).forEach(key => {
          if (!['context_file_ids', 'context_bookmark_ids', 'context_transcript_ids', 'search_type', 'chat_history_id'].includes(key)) {
            payload[key] = filters[key];
          }
        });
      }
      
      // Use the new streaming endpoint that calls smart_chat_stream()
      const response = await this.client.post(MOBILE_ENDPOINTS.CHAT_SMART_STREAM, payload, {
        signal
      });
      return response.data;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw error; // Re-throw abort errors to be handled by caller
      }
      throw new Error(error.response?.data?.message || 'Chat failed');
    }
  }

  /**
   * Helper function to normalize IDs from dicts with 'id' field or simple values
   * Matches web implementation: normalize_ids() helper function
   */
  private normalizeIds(ids: any[]): number[] {
    if (!Array.isArray(ids)) return [];
    return ids
      .map((id) => {
        if (id == null) return null;
        // Handle dicts with 'id' field
        if (typeof id === 'object' && id.id != null) {
          const numId = Number(id.id);
          return !Number.isNaN(numId) ? numId : null;
        }
        // Handle simple values
        const numId = Number(id);
        return !Number.isNaN(numId) ? numId : null;
      })
      .filter((id): id is number => id != null);
  }

  /**
   * Extract filenames from query text (e.g., "Document: IMG_9734.png")
   * Matches web implementation: filename extraction and resolution
   */
  private extractFilenamesFromQuery(query: string): string[] {
    const filenamePatterns = [
      /Document:\s*([^\s]+\.\w+)/gi,
      /File:\s*([^\s]+\.\w+)/gi,
      /Filename:\s*([^\s]+\.\w+)/gi,
      /"([^"]+\.\w+)"/g,
      /'([^']+\.\w+)'/g,
    ];
    
    const filenames: string[] = [];
    filenamePatterns.forEach((pattern) => {
      const matches = query.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          filenames.push(match[1]);
        }
      }
    });
    
    return [...new Set(filenames)]; // Remove duplicates
  }

  /**
   * Format conversation history for context (last 10 messages)
   * Matches web implementation: conversation history formatting
   */
  private formatConversationHistory(messages: any[]): any[] {
    if (!Array.isArray(messages)) return [];
    
    // Get last 10 messages
    const recentMessages = messages.slice(-10);
    
    return recentMessages.map((msg) => {
      // Extract role: 'user' or 'assistant'
      const role = msg.role || 
                   (msg.is_own_message ? 'user' : 'assistant') ||
                   (msg.sender?.id === 1 ? 'assistant' : 'user') ||
                   'user';
      
      // Extract content from various field names
      const content = msg.content || 
                     msg.message || 
                     msg.text || 
                     '';
      
      return {
        role,
        content: String(content).trim()
      };
    }).filter((msg) => msg.content.length > 0);
  }

  /**
   * SSE Streaming chat message - backend automatically encrypts messages and responses
   * All chat operations go through backend encryption class
   * Enhanced with full web feature parity
   */
  async sendChatMessageStream(
    message: string, 
    filters?: any, 
    signal?: AbortSignal,
    onChunk?: (type: string, data: any) => void
  ): Promise<void> {
    // MOBILE: Use EventSource for SSE streaming (React Native doesn't support fetch streaming)
    // WEB: Would use fetch with response.body.getReader() - but this is mobile-only code
    
    const isMobile = Platform.OS === 'ios' || Platform.OS === 'android';
    
    try {
      console.log('💬 [MOBILE] Sending chat message via SSE streaming');
      console.log('🔐 Message and response will be encrypted by backend encryption class');
      
      const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) {
        throw new Error('Not authenticated');
      }
      
      // ==================== FEATURE 1: ID NORMALIZATION ====================
      // Normalize all ID arrays to extract IDs from dicts or simple values
      const normalizeIds = this.normalizeIds.bind(this);
      
      // ==================== FEATURE 2: FILENAME EXTRACTION ====================
      // Extract filenames from query text (e.g., "Document: IMG_9734.png")
      const extractedFilenames = this.extractFilenamesFromQuery(message);
      console.log('📄 [MOBILE] Extracted filenames from query:', extractedFilenames);
      
      // Note: Filename resolution to file IDs would require a database lookup
      // This is handled on the backend, but we log extracted filenames for debugging
      
      // ==================== FEATURE 3: PERSISTENT CONTEXT LOADING ====================
      // Load persistent context from chat history if chat_history_id exists
      let persistentContext: any = null;
      if (filters?.chat_history_id != null && filters.chat_history_id !== -1 && filters.chat_history_id > 0) {
        try {
          // Import chatStore dynamically to avoid circular dependencies
          const { useChatStore } = await import('../stores/chatStore');
          const chatHistory = useChatStore.getState().currentHistory;
          
          if (chatHistory?.persistent_context) {
            persistentContext = chatHistory.persistent_context;
            console.log('📋 [MOBILE] Loaded persistent context from chat history:', {
              context_file_ids: persistentContext.context_file_ids?.length || 0,
              context_bookmark_ids: persistentContext.context_bookmark_ids?.length || 0,
              context_entry_ids: persistentContext.context_entry_ids?.length || 0,
              context_transcript_ids: persistentContext.context_transcript_ids?.length || 0,
              selected_files: persistentContext.selected_files?.length || 0,
              selected_bookmarks: persistentContext.selected_bookmarks?.length || 0,
              selected_workspaces: persistentContext.selected_workspaces?.length || 0,
              selected_users: persistentContext.selected_users?.length || 0,
            });
          }
        } catch (error) {
          console.warn('⚠️ [MOBILE] Failed to load persistent context:', error);
        }
      }
      
      // ==================== FEATURE 4: CONVERSATION HISTORY ====================
      // Format conversation history (last 10 messages)
      let conversationHistory: any[] = [];
      if (filters?.chat_history_id != null && filters.chat_history_id !== -1 && filters.chat_history_id > 0) {
        try {
          const { useChatStore } = await import('../stores/chatStore');
          const chatHistory = useChatStore.getState().currentHistory;
          
          if (chatHistory?.messages && Array.isArray(chatHistory.messages)) {
            conversationHistory = this.formatConversationHistory(chatHistory.messages);
            console.log('💬 [MOBILE] Formatted conversation history:', {
              totalMessages: chatHistory.messages.length,
              formattedCount: conversationHistory.length,
              lastMessage: conversationHistory[conversationHistory.length - 1]
            });
          }
        } catch (error) {
          console.warn('⚠️ [MOBILE] Failed to format conversation history:', error);
        }
      }
      
      // ==================== BUILD COMPREHENSIVE PAYLOAD ====================
      // Build payload to match web: all context fields, normalized IDs, etc.
      const payload: any = { 
        message,
        response_mode: filters?.response_mode || 'flexible', // FEATURE 10: Response mode preference
        stream: true,
        preview_mode: true,
        enable_preview_mode: filters?.enable_preview_mode !== false, // FEATURE 16: Preview mode support
        search_type: filters?.search_type || 'refined',
        user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      };

      // Helper functions for ID conversion
      const toNum = (v: any) => (v == null || v === '') ? null : Number(v);
      const toNumList = (arr: any) => normalizeIds(Array.isArray(arr) ? arr : []);

      // ==================== FEATURE 5: CONTEXT ID NORMALIZATION ====================
      // Normalize all context ID arrays
      if (filters) {
        // Priority: Request context > Persistent context > Empty
        // Check if request arrays have VALUES (not just keys)
        const hasRequestContext = 
          (filters.selected_files && filters.selected_files.length > 0) ||
          (filters.context_file_ids && filters.context_file_ids.length > 0) ||
          (filters.selected_bookmarks && filters.selected_bookmarks.length > 0) ||
          (filters.context_bookmark_ids && filters.context_bookmark_ids.length > 0) ||
          (filters.selected_workspaces && filters.selected_workspaces.length > 0) ||
          (filters.selected_users && filters.selected_users.length > 0) ||
          (filters.selected_transcripts && filters.selected_transcripts.length > 0) ||
          (filters.context_transcript_ids && filters.context_transcript_ids.length > 0) ||
          (filters.context_entry_ids && filters.context_entry_ids.length > 0);

        // Merge persistent context with request context (request takes priority)
        const requestContext = {
          selected_files: filters.selected_files || filters.context_file_ids,
          selected_bookmarks: filters.selected_bookmarks || filters.context_bookmark_ids,
          selected_workspaces: filters.selected_workspaces,
          selected_users: filters.selected_users,
          selected_transcripts: filters.selected_transcripts || filters.context_transcript_ids,
          context_file_ids: filters.context_file_ids || filters.selected_files,
          context_bookmark_ids: filters.context_bookmark_ids || filters.selected_bookmarks,
          context_entry_ids: filters.context_entry_ids,
          context_transcript_ids: filters.context_transcript_ids || filters.selected_transcripts,
        };

        // Use request context if it has values, otherwise use persistent context
        const finalContext = hasRequestContext ? requestContext : persistentContext || requestContext;

        // Normalize and set all context IDs
        if (finalContext?.selected_files || finalContext?.context_file_ids) {
          const fileIds = toNumList(finalContext.selected_files || finalContext.context_file_ids);
          if (fileIds.length > 0) {
            payload.selected_files = fileIds;
            payload.context_file_ids = fileIds;
          }
        }

        if (finalContext?.selected_bookmarks || finalContext?.context_bookmark_ids) {
          const bookmarkIds = toNumList(finalContext.selected_bookmarks || finalContext.context_bookmark_ids);
          if (bookmarkIds.length > 0) {
            payload.selected_bookmarks = bookmarkIds;
            payload.context_bookmark_ids = bookmarkIds;
          }
        }

        if (finalContext?.selected_workspaces) {
          const workspaceIds = toNumList(finalContext.selected_workspaces);
          if (workspaceIds.length > 0) {
            payload.selected_workspaces = workspaceIds;
          }
        }

        if (finalContext?.selected_users) {
          const userIds = toNumList(finalContext.selected_users);
          if (userIds.length > 0) {
            payload.selected_users = userIds;
          }
        }

        if (finalContext?.selected_transcripts || finalContext?.context_transcript_ids) {
          const transcriptIds = toNumList(finalContext.selected_transcripts || finalContext.context_transcript_ids);
          if (transcriptIds.length > 0) {
            payload.selected_transcripts = transcriptIds;
            payload.context_transcript_ids = transcriptIds;
          }
        }

        // FEATURE 13: Context Entry IDs (for trend entity entries)
        if (finalContext?.context_entry_ids) {
          const entryIds = toNumList(finalContext.context_entry_ids);
          if (entryIds.length > 0) {
            payload.context_entry_ids = entryIds;
          }
        }

        // FEATURE 8: Conversation Session ID (optional)
        if (filters.conversation_session_id) {
          payload.conversation_session_id = toNum(filters.conversation_session_id);
        }

        // FEATURE 7: Active Workspace ID
        if (filters.active_workspace_id || filters.workspace_id) {
          payload.active_workspace_id = toNum(filters.active_workspace_id || filters.workspace_id);
        }

        // Chat history ID
        if (filters.chat_history_id != null && filters.chat_history_id !== -1) {
          payload.chat_history_id = toNum(filters.chat_history_id);
        }

        // Search type
        if (filters.search_type) {
          payload.search_type = filters.search_type;
        }

        // Log context priority decision
        const requestContextKeys = Object.keys(requestContext).filter((k: string) => {
          const val = (requestContext as any)[k];
          return Array.isArray(val) && val.length > 0;
        });
        const persistentContextKeys = persistentContext 
          ? Object.keys(persistentContext).filter((k: string) => {
              const val = (persistentContext as any)[k];
              return Array.isArray(val) && val.length > 0;
            })
          : [];
        
        console.log('📊 [MOBILE] Context priority decision:', {
          hasRequestContext,
          usingRequestContext: hasRequestContext,
          usingPersistentContext: !hasRequestContext && !!persistentContext,
          requestContextKeys,
          persistentContextKeys,
        });
      }

      // ==================== FEATURE 14: EXTRACTED ENTITIES PLACEHOLDER ====================
      // Initialize extracted_entities dict with proper structure
      payload.extracted_entities = {
        all_entities: [],
        is_metadata_query: false,
        metadata_type: null,
        document_location_hint: null,
        topic_keywords: []
      };

      // ==================== FEATURE 4: CONVERSATION HISTORY ====================
      // Add conversation history to payload
      if (conversationHistory.length > 0) {
        payload.conversation_history = conversationHistory;
      }

      // ==================== FEATURE 19: LOGGING & DEBUGGING ====================
      // Comprehensive logging for context decisions
      console.log('📤 [MOBILE] Complete payload being sent:', {
        message: message.substring(0, 100),
        hasConversationHistory: conversationHistory.length > 0,
        conversationHistoryLength: conversationHistory.length,
        context_file_ids: payload.context_file_ids?.length || 0,
        context_bookmark_ids: payload.context_bookmark_ids?.length || 0,
        context_entry_ids: payload.context_entry_ids?.length || 0,
        context_transcript_ids: payload.context_transcript_ids?.length || 0,
        selected_files: payload.selected_files?.length || 0,
        selected_bookmarks: payload.selected_bookmarks?.length || 0,
        selected_workspaces: payload.selected_workspaces?.length || 0,
        selected_users: payload.selected_users?.length || 0,
        selected_transcripts: payload.selected_transcripts?.length || 0,
        chat_history_id: payload.chat_history_id,
        active_workspace_id: payload.active_workspace_id,
        response_mode: payload.response_mode,
        search_type: payload.search_type,
        extractedFilenames: extractedFilenames.length > 0 ? extractedFilenames : undefined,
      });
      
      // Get base URL
      const baseURL = this.client.defaults.baseURL || '';
      const streamURL = `${baseURL}${MOBILE_ENDPOINTS.CHAT_SMART_STREAM}`;
      
      console.log('📱 [MOBILE] Connecting to SSE stream with EventSource:', streamURL);
      
      // MOBILE: Use react-native-fetch-api for TRUE streaming (supports ReadableStream)
      if (isMobile) {
        console.log('📱 [MOBILE] Using react-native-fetch-api for TRUE streaming');
        console.log('📱 [MOBILE] Payload:', JSON.stringify(payload).substring(0, 100));
        
        const response = await streamingFetch(streamURL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Accept': 'text/event-stream',
          },
          body: JSON.stringify(payload),
          signal,
          reactNative: { textStreaming: true }, // Enable true streaming
        });
        
        if (!response.ok) {
          // Handle specific HTTP status codes
          if (response.status === 429) {
            throw new Error(`Rate limit exceeded. Please wait a moment before sending another message.`);
          }
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        console.log('✅ [MOBILE] Fetch response received, status:', response.status);
        
        // Use ReadableStream if available (preferred for true streaming)
        const reader = response.body?.getReader();
        console.log('🔍 [MOBILE] Checking stream reader:', { hasReader: !!reader, hasBody: !!response.body });
        
        if (reader) {
          console.log('✅ [MOBILE] Using ReadableStream for true async streaming');
          const decoder = new TextDecoder();
          let buffer = '';
          let refinementCount = 0;
          let previewCount = 0;
          let lastEventType = '';
          let totalBytesRead = 0;
          
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
              console.log('📱 [MOBILE] Stream done', { 
                refinementCount, 
                bufferRemaining: buffer.length,
                receivedRefinement: refinementCount > 0 
              });
              
              // Process any remaining buffer before exiting
              if (buffer.trim()) {
                console.log('⚠️ [MOBILE] Processing remaining buffer:', buffer.substring(0, 100));
              }
              break;
            }
            
            // Decode and add to buffer
            const chunk = decoder.decode(value, { stream: true });
            totalBytesRead += value.length;
            buffer += chunk;
            
            console.log('📥 [MOBILE] Received chunk:', { 
              bytes: value.length, 
              totalBytes: totalBytesRead,
              chunkPreview: chunk.substring(0, 50).replace(/\n/g, '\\n')
            });
            
            // Process complete lines
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || ''; // Keep incomplete line in buffer
            
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const dataStr = line.substring(6).trim();
                if (!dataStr) continue;
                
                try {
                  const data = JSON.parse(dataStr);
                  const eventType = data.type || 'unknown';
                  
                  // Track phase transitions
                  if (lastEventType !== eventType) {
                    console.log('🔄 [MOBILE] Phase transition:', { 
                      from: lastEventType || 'none', 
                      to: eventType,
                      previewCount,
                      refinementCount
                    });
                    lastEventType = eventType;
                  }
                  
                  if (eventType === 'preview_chunk') previewCount++;
                  if (eventType === 'refinement_chunk') refinementCount++;
                  
                  console.log('📱 [MOBILE] SSE event:', eventType, {
                    chunk_index: data.chunk_index,
                    hasContent: !!(data.content || data.response),
                    previewTotal: previewCount,
                    refinementTotal: refinementCount
                  });
                  
                  if (!onChunk) continue;
                  
                  if (data.type === 'status') {
                    onChunk('status', data);
                  } else if (data.type === 'instant_preview') {
                    onChunk('instant_preview', data);
                  } else if (data.type === 'result_superseded' || data.type === 'main_search_pending') {
                    console.info(
                      data.type === 'result_superseded'
                        ? '[SSE] result_superseded — analytics won; replacing preview with main answer'
                        : '[SSE] main_search_pending — showing refining dots until main search + refinement'
                    );
                    onChunk(data.type, data);
                  } else if (data.type === 'preview_complete') {
                    onChunk('preview_complete', data);
                  } else if (data.type === 'preview_chunk' || data.type === 'chunk') {
                    const chunkContent = data.content || data.response || '';
                    onChunk('preview_chunk', {
                      content: chunkContent,
                      chunk_index: data.chunk_index,
                      total_chunks: data.total_chunks,
                      progress: data.progress,
                      phase: data.phase || 'preview'
                    });
                  } else if (data.type === 'refinement_chunk' || data.type === 'refinement') {
                    const c = data.content || data.response || '';
                    refinementCount++;
                    console.log('📦 [API] refinement_chunk #' + (data.chunk_index ?? '?') + ' (total: ' + refinementCount + ')');
                    onChunk('refinement_chunk', {
                      content: c,
                      chunk_index: data.chunk_index,
                      total_chunks: data.total_chunks,
                      progress: data.progress,
                      phase: data.phase || 'final'
                    });
                  } else if (data.type === 'complete') {
                    const fullResponse = data.response ?? data.content ?? data.captured_text ?? data.refinement ?? '';
                    const resp = typeof fullResponse === 'string' ? fullResponse : String(fullResponse || '');
                    console.log('📱 [MOBILE] Received complete', { responseLen: resp.length, refinementCount });
                    onChunk('complete', {
                      type: 'complete',
                      response: resp,
                      citations: data.citations || [],
                      chat_history_id: data.chat_history_id,
                      metadata: data.metadata
                    });
                    return; // Exit streaming
                  } else if (data.type === 'error') {
                    console.error('❌ [MOBILE] SSE error:', data.message);
                    throw new Error(data.message || 'Chat processing error');
                  }
                } catch (parseError) {
                  console.error('❌ [MOBILE] Parse error:', parseError, 'Line:', dataStr.substring(0, 100));
                }
              }
            }
          }
          
          console.log('📱 [MOBILE] ReadableStream streaming complete');
          return;
        }
        
        // Fallback: response.text() (synchronous, no true streaming)
        console.warn('⚠️ [MOBILE] No ReadableStream, using response.text() fallback');
        const text = await response.text();
        console.log('📱 [MOBILE] Full response length:', text.length);
        
        const lines = text.split('\n');
        let refinementCount = 0;
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.substring(6).trim();
            if (!dataStr) continue;
            
            try {
              const data = JSON.parse(dataStr);
              if (!onChunk) continue;
              
              if (data.type === 'instant_preview') {
                onChunk('instant_preview', data);
              } else if (data.type === 'result_superseded' || data.type === 'main_search_pending') {
                console.info(
                  data.type === 'result_superseded'
                    ? '[SSE fallback] result_superseded — analytics won; replacing preview with main answer'
                    : '[SSE fallback] main_search_pending — showing refining dots until main search + refinement'
                );
                onChunk(data.type, data);
              } else if (data.type === 'preview_chunk' || data.type === 'chunk') {
                onChunk('preview_chunk', {
                  content: data.content || data.response || '',
                  chunk_index: data.chunk_index,
                  total_chunks: data.total_chunks,
                  progress: data.progress,
                  phase: data.phase || 'preview'
                });
              } else if (data.type === 'refinement_chunk' || data.type === 'refinement') {
                refinementCount++;
                onChunk('refinement_chunk', {
                  content: data.content || data.response || '',
                  chunk_index: data.chunk_index,
                  total_chunks: data.total_chunks,
                  progress: data.progress,
                  phase: data.phase || 'final'
                });
              } else if (data.type === 'complete') {
                const resp = data.response ?? data.content ?? data.captured_text ?? data.refinement ?? '';
                onChunk('complete', {
                  type: 'complete',
                  response: typeof resp === 'string' ? resp : String(resp || ''),
                  citations: data.citations || [],
                  chat_history_id: data.chat_history_id,
                  metadata: data.metadata
                });
                return;
              }
            } catch (parseError) {
              console.error('❌ [MOBILE] Parse error:', parseError);
            }
          }
        }
        
        console.log('📱 [MOBILE] Text fallback complete');
        return;
      }
      
      // Non-mobile platforms would use different implementation
      throw new Error('Non-mobile streaming not implemented in this mobile-specific function');

    } catch (error: any) {
      // Error handling
      console.error('❌ [MOBILE] Chat stream error:', error);
      
      if (error.name === 'AbortError') {
        throw error; // Re-throw abort errors to be handled by caller
      }
      
      console.error('❌ [MOBILE] Chat stream failed:', error);
      
      // Determine user-friendly error message
      let userFriendlyMessage = 'Sorry, there was an issue processing your request.';
      
      if (error.message?.includes('429') || error.message?.includes('Rate limit') || error.message?.includes('rate limit')) {
        userFriendlyMessage = 'Rate limit exceeded. Please wait a moment before sending another message.';
      } else if (error.message?.includes('timeout') || error.message?.includes('Timeout')) {
        userFriendlyMessage = 'Connection timed out. Please check your internet connection and try again.';
      } else if (error.message?.includes('Network Error') || error.message?.includes('ERR_NETWORK')) {
        userFriendlyMessage = 'Unable to connect to the server. Please check your internet connection.';
      }
      
      if (onChunk) {
        onChunk('error', {
          type: 'error',
          message: userFriendlyMessage,
          content: userFriendlyMessage,
          error: error.message
        });
      }
      
      throw new Error(error.message || 'Chat stream failed');
    }
  }

  /**
   * Chunked Polling Chat - Resilient alternative to streaming
   * Uses job-based polling instead of long-lived SSE connections
   */
  async startChatJob(
    message: string,
    filters?: any,
    signal?: AbortSignal
  ): Promise<ApiResponse> {
    try {
      console.log('💬 [POLLING] Starting chat job');
      
      const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) {
        throw new Error('Not authenticated');
      }

      // Build payload (same as streaming)
      const normalizeIds = this.normalizeIds.bind(this);
      const payload: any = {
        message,
        response_mode: filters?.response_mode || 'flexible',
        stream: false, // Job-based polling; server still emits preview/refinement chunks to the job
        preview_mode: false,
        search_type: filters?.search_type || 'refined',
        user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      };

      const toNum = (v: any) => (v == null || v === '') ? null : Number(v);
      const toNumList = (arr: any) => normalizeIds(Array.isArray(arr) ? arr : []);

      // Add context IDs (same normalization as streaming)
      if (filters) {
        if (filters.selected_files || filters.context_file_ids) {
          const fileIds = toNumList(filters.selected_files || filters.context_file_ids);
          if (fileIds.length > 0) {
            payload.selected_files = fileIds;
            payload.context_file_ids = fileIds;
          }
        }

        if (filters.selected_bookmarks || filters.context_bookmark_ids) {
          const bookmarkIds = toNumList(filters.selected_bookmarks || filters.context_bookmark_ids);
          if (bookmarkIds.length > 0) {
            payload.selected_bookmarks = bookmarkIds;
            payload.context_bookmark_ids = bookmarkIds;
          }
        }

        if (filters.selected_workspaces) {
          const workspaceIds = toNumList(filters.selected_workspaces);
          if (workspaceIds.length > 0) {
            payload.selected_workspaces = workspaceIds;
          }
        }

        if (filters.selected_users) {
          const userIds = toNumList(filters.selected_users);
          if (userIds.length > 0) {
            payload.selected_users = userIds;
          }
        }

        if (filters.selected_transcripts || filters.context_transcript_ids) {
          const transcriptIds = toNumList(filters.selected_transcripts || filters.context_transcript_ids);
          if (transcriptIds.length > 0) {
            payload.selected_transcripts = transcriptIds;
            payload.context_transcript_ids = transcriptIds;
          }
        }

        if (filters.context_entry_ids) {
          const entryIds = toNumList(filters.context_entry_ids);
          if (entryIds.length > 0) {
            payload.context_entry_ids = entryIds;
          }
        }

        if (filters.conversation_session_id) {
          payload.conversation_session_id = toNum(filters.conversation_session_id);
        }

        if (filters.active_workspace_id || filters.workspace_id) {
          payload.active_workspace_id = toNum(filters.active_workspace_id || filters.workspace_id);
        }

        if (filters.chat_history_id != null && filters.chat_history_id !== -1) {
          payload.chat_history_id = toNum(filters.chat_history_id);
        }

        if (filters.client_id != null && filters.client_id !== '') {
          const cid = toNum(filters.client_id);
          if (cid != null && Number.isFinite(cid) && cid > 0) {
            payload.client_id = cid;
          }
        }

        // Same as web — retry replaces that assistant bubble (do not combine with additional_response)
        if (filters.retry === true && filters.retry_replace_message_id != null) {
          payload.retry = true;
          payload.retry_replace_message_id = toNum(filters.retry_replace_message_id);
          payload.message = ''; // Backend resolves user query from saved conversation
          payload.enable_preview_mode = true; // Match web: required for preview/refinement chunks
          payload.enable_cot = true;
        } else if (filters.additional_response_for_message_id != null) {
          // More sources: append user stub + new assistant; server excludes chunks from this message
          payload.additional_response_for_message_id = toNum(filters.additional_response_for_message_id);
          payload.message =
            typeof filters.message === 'string' && filters.message.trim()
              ? filters.message.trim()
              : 'Additional sources (same topic).';
          payload.preview_mode = true;
          payload.enable_preview_mode = true;
        }

        // Send on-screen turns so the backend can merge them with DB-canonical history.
        // This kills the save-race and makes follow-ups work even when chat_history_id
        // is momentarily null (mirrors web buildConversationHistory).
        if (Array.isArray(filters.conversation_history) && filters.conversation_history.length > 0) {
          payload.conversation_history = filters.conversation_history;
        }
      }

      // Use longer timeout for starting chat job (60s) to handle slow network conditions
      // The endpoint should return quickly, but network issues can cause delays
      const response = await this.client.post(MOBILE_ENDPOINTS.CHAT_SMART_START, payload, {
        timeout: 60000, // 60 seconds timeout
        signal,
      });
      console.log('✅ [POLLING] Chat job started:', response.data);
      return response.data;
    } catch (error: any) {
      console.error('❌ [POLLING] Failed to start chat job:', error);
      // User cancelled — don't wrap as a start failure
      if (
        signal?.aborted ||
        error?.code === 'ERR_CANCELED' ||
        error?.name === 'CanceledError' ||
        error?.name === 'AbortError' ||
        axios.isCancel?.(error)
      ) {
        throw error;
      }
      // Preserve 409 (e.g. additional_limit) for callers that remove placeholder rows
      if (error.response?.status === 409) {
        throw error;
      }
      // Handle network errors (connection refused, DNS failure, etc.)
      if (error.message === 'Network Error' || error.code === 'ERR_NETWORK' || error.code === 'ECONNREFUSED') {
        const errorMsg = 'Cannot connect to server. Please check:\n' +
          '1. Backend server is running\n' +
          '2. Network connection is active\n' +
          '3. Server URL is correct';
        throw new Error(errorMsg);
      }
      
      // Handle timeout errors
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        throw new Error('Request timed out. Please check your connection and try again.');
      }
      
      // Handle other errors
      throw new Error(error.response?.data?.message || error.message || 'Failed to start chat job');
    }
  }

  async pollChatChunk(
    jobId: string,
    cursor: number = 0,
    signal?: AbortSignal
  ): Promise<ApiResponse> {
    try {
      // Backend long-polls: holds the GET until data is ready. First chunk can take 10–60+ seconds.
      // Use a long timeout so we don't stop fake streaming with a timeout before preview arrives.
      const response = await this.client.get(MOBILE_ENDPOINTS.CHAT_SMART_CHUNK, {
        params: { job_id: jobId, cursor },
        timeout: 90000, // 90 seconds – backend holds connection until first chunk is ready
        signal,
      });
      return response.data;
    } catch (error: any) {
      // Preserve original error for classification (don't wrap it)
      // The caller will classify it as permanent or transient
      throw error;
    }
  }

  async cancelChatJob(jobId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.CHAT_SMART_CANCEL, {
        job_id: jobId
      });
      console.log('✅ [POLLING] Chat job cancelled:', jobId);
      return response.data;
    } catch (error: any) {
      console.error('❌ [POLLING] Failed to cancel chat job:', error);
      throw new Error(error.response?.data?.message || 'Failed to cancel chat job');
    }
  }

  /**
   * Send chat message using chunked polling (resilient alternative to streaming)
   * Polls every 500ms to get chunks, making it feel like streaming
   */
  async sendChatMessagePolling(
    message: string,
    filters?: any,
    signal?: AbortSignal,
    onChunk?: (type: string, data: any) => void
  ): Promise<void> {
    // Declare in outer scope so catch block can cancel the job if start succeeded but later code threw
    let currentJobId: string | null = null;

    // Drop all UI updates after the user cancels (matches web fetch+signal behavior).
    const userOnChunk = onChunk;
    onChunk = userOnChunk
      ? (type: string, data: any) => {
          if (signal?.aborted) return;
          userOnChunk(type, data);
        }
      : undefined;

    const isAbortError = (error: any): boolean =>
      !!signal?.aborted ||
      error?.code === 'ERR_CANCELED' ||
      error?.name === 'CanceledError' ||
      error?.name === 'AbortError' ||
      !!axios.isCancel?.(error);

    try {
      console.log('💬 [POLLING] Starting chat message via polling');

      if (signal?.aborted) {
        console.log('🛑 [POLLING] Aborted before start');
        return;
      }
      
      // Step 1: Start job
      // CRITICAL: If this fails, we must NOT continue with polling
      let startResponse;
      try {
        startResponse = await this.startChatJob(message, filters, signal);
      } catch (startError: any) {
        if (isAbortError(startError)) {
          console.log('🛑 [POLLING] Start aborted by user');
          return;
        }
        // Network errors or other start failures - don't continue
        console.error('❌ [POLLING] Failed to start chat job, aborting:', startError);
        if (onChunk) {
          onChunk('error', {
            type: 'error',
            message: startError.message || 'Failed to start chat job. Please check your connection and try again.',
            error: 'StartJobFailed'
          });
        }
        throw startError; // Re-throw to stop execution
      }
      
      if (!startResponse || !startResponse.success || !startResponse.job_id) {
        const errorMsg = startResponse?.message || 'Failed to start chat job - no job ID received';
        console.error('❌ [POLLING] Invalid start response:', startResponse);
        if (onChunk) {
          onChunk('error', {
            type: 'error',
            message: errorMsg,
            error: 'InvalidStartResponse'
          });
        }
        throw new Error(errorMsg);
      }

      const jobId: string = startResponse.job_id;
      currentJobId = jobId; // set for catch-block cleanup

      // Cancel the server job immediately on abort — don't wait for the next poll tick.
      // Listener stays until abort ({ once: true }); do not remove it when this function
      // returns early because pollChunks runs asynchronously after we return.
      const cancelOnAbort = () => {
        console.log('🛑 [POLLING] Abort signal — cancelling job immediately:', jobId);
        void this.cancelChatJob(jobId).catch((cancelError) => {
          console.error('❌ [POLLING] Failed to cancel job on abort:', cancelError);
        });
      };
      if (signal) {
        if (signal.aborted) {
          cancelOnAbort();
          return;
        }
        signal.addEventListener('abort', cancelOnAbort, { once: true });
      }

      let cursor = 0;
      let isDone = false;
      let accumulatedContent = ''; // Track accumulated content for streaming-like display
      let previousPhase: boolean | null = null; // Track previous phase to detect transitions (null = not set yet)
      let previewContentLength = 0; // Track where preview ends
      let refinementContentReceived = false; // Track if we've received any refinement content
      let previewContentReceived = false; // Track if we've actually received any preview content
      /** Job-store gap UX (library search vs refining); mirrors SSE main_search_pending / preview_complete */
      let prevJobRap = false;
      let prevJobMsp = false;
      const pollInterval = 200; // Poll every 200ms for faster preview capture
      const initialPollInterval = 100; // Poll every 100ms for first few polls to catch preview quickly
      const maxPollTime = 300000; // Max 5 minutes
      const startTime = Date.now();
      let pollCount = 0; // Track number of polls
      
      // Network resilience: Track failures and implement exponential backoff
      let consecutiveFailures = 0; // Track consecutive failures
      let currentDelay = pollInterval; // Current delay between polls (starts at 200ms)
      const maxDelay = 5000; // Maximum delay (5 seconds)
      const maxFailures = 10; // Maximum consecutive failures before giving up
      
      // Helper: Axios sometimes exposes status as string — [].includes('404') is false, so 404 was retried for 5min.
      const httpStatus = (error: any): number | undefined => {
        const s = error?.response?.status;
        if (s == null || s === '') return undefined;
        const n = Number(s);
        return Number.isFinite(n) ? n : undefined;
      };
      // Permanent errors: 401, 403, 404, 410 — stop immediately with a clear message (no spin until timeout)
      const isPermanentError = (error: any): boolean => {
        const status = httpStatus(error);
        if (status == null) return false;
        return [401, 403, 404, 410].includes(status);
      };
      
      // Helper function to calculate exponential backoff with jitter
      const calculateBackoff = (failures: number): number => {
        const baseDelay = 200;
        const exponentialDelay = Math.min(baseDelay * Math.pow(2, failures), maxDelay);
        // Add jitter: 0.7 to 1.3 multiplier (70% to 130% of calculated delay)
        const jitter = 0.7 + Math.random() * 0.6;
        return Math.floor(exponentialDelay * jitter);
      };

      // Step 2: Poll for chunks
      const pollChunks = async (): Promise<void> => {
        // Check abort signal
        if (signal?.aborted) {
          console.log('🛑 [POLLING] Abort signal received, stopping poll loop');
          cancelOnAbort();
          return;
        }

        // Check timeout
        if (Date.now() - startTime > maxPollTime) {
          console.warn('⚠️ [POLLING] Polling timeout reached');
          if (onChunk) {
            onChunk('error', {
              type: 'error',
              message: 'Request timeout. Please try again.',
              error: 'Timeout'
            });
          }
          return;
        }

        try {
          const chunkResponse = await this.pollChatChunk(jobId, cursor, signal);

          // User may have cancelled while this long-poll was in flight
          if (signal?.aborted) {
            console.log('🛑 [POLLING] Aborted after poll returned — ignoring chunk');
            return;
          }

          // Success - reset failure counter and delay
          const hadFailures = consecutiveFailures > 0;
          consecutiveFailures = 0;
          currentDelay = pollInterval;
          
          // Show reconnection success if we had failures
          if (hadFailures) {
            // Connection restored - silently continue
            console.log('✅ [POLLING] Connection restored, resuming polling');
          }
          
          if (!chunkResponse.success) {
            if (chunkResponse.status === 'not_found') {
              console.error('❌ [POLLING] Job not found');
              if (onChunk) {
                onChunk('error', {
                  type: 'error',
                  message: 'Chat job not found',
                  error: 'Job not found'
                });
              }
              return;
            }
            throw new Error(chunkResponse.message || 'Failed to poll chunk');
          }

          const {
            content,
            cursor: newCursor,
            done,
            status,
            preview_started,
            is_preview_phase,
            preview_cursor_reset,
            refinement_cursor_reset,
            refining_answer_pending: jobRap,
            main_search_pending: jobMsp,
          } = chunkResponse;
          const accumulatedSnapshotBeforeChunk = accumulatedContent;

          // Early chat_history_id binding: the backend now emits the ID as soon as it
          // is known (before the job completes), so forward it immediately so the UI
          // can update currentChatIdRef before any fast follow-up message is sent.
          if (onChunk && !done && chunkResponse.chat_history_id) {
            onChunk('chat_history_id', { chat_history_id: chunkResponse.chat_history_id });
          }

          const rap = jobRap === true;
          const msp = jobMsp === true;
          if (onChunk && status !== 'error' && status !== 'cancelled') {
            if (rap && msp && !(prevJobRap && prevJobMsp)) {
              onChunk('main_search_pending', { type: 'main_search_pending' });
            }
            if (rap && !msp && !(prevJobRap && !prevJobMsp)) {
              onChunk('preview_complete', {
                type: 'preview_complete',
                preview_length: accumulatedContent.length,
              });
            }
            prevJobRap = rap;
            prevJobMsp = msp;
          }

          // Handle status changes
          if (status === 'cancelled') {
            console.log('🛑 [POLLING] Job was cancelled');
            return;
          }

          if (status === 'error') {
            const errorMsg = chunkResponse.error || 'Chat generation failed';
            console.error('❌ [POLLING] Job error:', errorMsg);
            if (onChunk) {
              onChunk('error', {
                type: 'error',
                message: errorMsg,
                error: errorMsg
              });
            }
            return;
          }

          // CRITICAL: Process content FIRST, then check for phase transition
          // This ensures preview chunks are sent even if refinement is ready
          const currentPhase = is_preview_phase !== undefined ? is_preview_phase : true;
          
          // Send new content chunk if available (slice from cursor)
          // Process content based on CURRENT phase, not previous phase
          if (content && content.length > 0) {
            // Content is the slice from cursor to end of buffer
            // CRITICAL: Always accumulate content for the complete event
            // When done=true, backend returns buffer[cursor:] which is ALL remaining content from cursor
            // We still need to accumulate it (or replace if cursor was reset to 0 in refinement phase)
            if (preview_cursor_reset) {
              // Preview buffer replaced at first LLM token while client cursor still pointed past "Searching…"
              accumulatedContent = content;
            } else if (refinement_cursor_reset) {
              // Refinement replaced preview (or completed) while client cursor still tracked preview length
              accumulatedContent = content;
            } else if (done && is_preview_phase === false && cursor === 0) {
              // Special case: done=true, refinement phase, cursor=0
              // This means backend buffer was replaced with complete refinement, content is the full refinement
              console.log('📦 [POLLING] Done=true in refinement phase with cursor=0 - complete refinement received:', content.length, 'chars');
              accumulatedContent = content; // Replace with complete refinement (buffer was replaced)
            } else {
              // Normal accumulation: add content to accumulated (works for both done and not done)
              accumulatedContent += content;
            }
            // Update cursor only if newCursor is provided (may be undefined in some responses)
            if (newCursor !== undefined) {
              cursor = newCursor;
            }
            
            // CRITICAL: Send chunk to frontend IMMEDIATELY (before checking done)
            // This provides real-time streaming UX - user sees content as it arrives
            if (onChunk) {
              // Determine event type based on is_preview_phase flag
              // CRITICAL: Always use is_preview_phase to determine chunk type, not preview_started
              // preview_started might be false even when preview content exists
              const eventType = is_preview_phase !== undefined && is_preview_phase !== null
                ? (is_preview_phase ? 'preview_chunk' : 'refinement_chunk')
                : (preview_started 
                    ? 'preview_chunk' 
                    : 'chunk'); // Fallback to generic 'chunk' if flags not available
              
              // Send chunk immediately to frontend for real-time display
              // Frontend will append this to buffer and start streaming
              
              // CRITICAL: Detect phase transition AFTER processing content
              // Only detect transition if we actually received preview content first
              // This prevents false transitions when backend skips preview phase
              const phaseChanged = previousPhase !== null && previousPhase === true && currentPhase === false && previewContentReceived;
              
              onChunk(eventType, {
                type: eventType,
                content: content, // New content since last cursor - send immediately
                chunk_index: Math.floor(cursor / 50), // Approximate chunk index
                total_chunks: -1, // Unknown until done
                progress: done ? 100 : 50,
                phase: is_preview_phase ? 'preview' : 'refinement',
                preview_started: preview_started || false,
                is_preview_phase: is_preview_phase !== undefined ? is_preview_phase : true,
                preview_cursor_reset: !!preview_cursor_reset,
                refinement_cursor_reset: !!refinement_cursor_reset,
                // Add flag to indicate this is the first refinement chunk (for frontend reset)
                is_first_refinement:
                  (phaseChanged && eventType === 'refinement_chunk') || !!refinement_cursor_reset
              });
              
              // Log preview chunks being sent
              if (eventType === 'preview_chunk') {
                previewContentReceived = true; // Mark that we've received preview content
                console.log('📤 [POLLING] Sent preview chunk to frontend immediately:', content.length, 'chars (accumulated:', accumulatedContent.length, 'chars)');
              }
              
              // Mark that we've received refinement content
              if (eventType === 'refinement_chunk') {
                refinementContentReceived = true;
                console.log('📤 [POLLING] Sent refinement chunk to frontend immediately:', content.length, 'chars (accumulated:', accumulatedContent.length, 'chars)');
              }
              
              // Handle phase transition AFTER sending current chunk
              if (phaseChanged) {
                console.log('🔄 [POLLING] Phase transition detected: preview -> refinement');
                previewContentLength = accumulatedSnapshotBeforeChunk.length;
                console.log('🔄 [POLLING] Preview content length:', previewContentLength);
                
                // If this poll returned a full-buffer refinement resync, keep accumulatedContent and
                // cursor from the server — otherwise we drop the beginning of refinement.
                if (!refinement_cursor_reset) {
                  accumulatedContent = '';
                  cursor = 0;
                  refinementContentReceived = false;
                  console.log('🔄 [POLLING] Reset cursor and accumulated content for refinement phase');
                } else {
                  console.log('🔄 [POLLING] Keeping refinement resync buffer and cursor (refinement_cursor_reset)');
                }
                
                // Send preview_complete signal to frontend
                if (onChunk) {
                  onChunk('preview_complete', {
                    type: 'preview_complete',
                    preview_length: previewContentLength
                  });
                }
              }
              
              // Update previous phase AFTER processing
              previousPhase = currentPhase;
            }
          } else if (!content || content.length === 0) {
            // No content in this poll - check for phase transition
            // Only detect transition if we actually received preview content first
            const phaseChanged = previousPhase !== null && previousPhase === true && currentPhase === false && previewContentReceived;
            
            if (phaseChanged) {
              console.log('🔄 [POLLING] Phase transition detected (no content): preview -> refinement');
              console.log('🔄 [POLLING] Preview content length:', accumulatedContent.length);
              previewContentLength = accumulatedContent.length;
              
              // Reset for refinement phase
              accumulatedContent = '';
              cursor = 0;
              refinementContentReceived = false;
              
              console.log('🔄 [POLLING] Reset cursor and accumulated content for refinement phase');
              
              // Send preview_complete signal
              if (onChunk) {
                onChunk('preview_complete', {
                  type: 'preview_complete',
                  preview_length: previewContentLength
                });
              }
              
              // Poll again immediately with cursor=0 to get refinement content
              if (!isDone && Date.now() - startTime < maxPollTime) {
                console.log('🔄 [POLLING] Polling immediately for refinement content');
                setTimeout(() => pollChunks(), 50);
                return; // Exit early - don't process done status yet
              }
            }
            
            // Update previous phase even when no content
            if (previousPhase === null || currentPhase !== previousPhase) {
              previousPhase = currentPhase;
            }
          }

          // Check if done - but handle phase transition case
          if (done) {
            // Check for phase transition one more time
            const phaseChanged = previousPhase !== null && previousPhase === true && currentPhase === false;
            
            // CRITICAL: If we just detected a phase change but haven't received refinement content yet,
            // we need to poll one more time with cursor=0 to get the refinement buffer
            if (phaseChanged && !refinementContentReceived) {
              console.log('🔄 [POLLING] Job done but phase just changed - polling once more with cursor=0 for refinement');
              cursor = 0; // Ensure cursor is 0
              // Poll one more time immediately to get refinement content
              if (!isDone && Date.now() - startTime < maxPollTime) {
                setTimeout(() => pollChunks(), 50);
                return; // Exit - don't mark as done yet
              }
            }
            
            isDone = true;
            console.log('✅ [POLLING] Chat job completed');
            console.log('✅ [POLLING] Final accumulated content length:', accumulatedContent.length);
            console.log('✅ [POLLING] Final cursor position:', cursor);
            console.log('✅ [POLLING] Content in this response:', content?.length || 0);
            console.log('✅ [POLLING] Is refinement phase:', is_preview_phase === false);
            
            // CRITICAL: When done=true, backend returns buffer[cursor:] which is ALL remaining content
            // For refinement phase, we need to ensure we have the complete refinement
            // If cursor > 0, we might have missed the beginning - poll once more with cursor=0
            if (is_preview_phase === false && cursor > 0 && !isDone && Date.now() - startTime < maxPollTime) {
              console.log('🔄 [POLLING] Refinement phase with cursor > 0 - polling once more with cursor=0 to get complete refinement');
              cursor = 0; // Reset to get complete refinement buffer
              setTimeout(() => pollChunks(), 50);
              return; // Exit - poll again to get complete refinement
            }
            
            // Use the longer of accumulated or current content to ensure we get the full response
            let finalContent = accumulatedContent || content || '';
            
            // If we're in refinement phase and content was received with done=true,
            // it should be the complete refinement from cursor position
            if (is_preview_phase === false && content && content.length > 0) {
              // In refinement phase with done=true, content is the complete refinement from cursor
              // If cursor was 0, this is the full refinement. If cursor > 0, this is the remaining part
              // CRITICAL: If accumulatedContent is empty (was reset during phase transition),
              // use content from done response, but ensure it's complete
              if (accumulatedContent.length === 0) {
                // accumulatedContent was reset - use content from done response
                // This should be the complete refinement buffer from the backend
                console.log('📦 [POLLING] Using refinement content from done response (accumulated was reset):', content.length, 'chars');
                finalContent = content;
              } else if (content.length >= accumulatedContent.length) {
                // Content is longer or equal - use it (it's the complete response from cursor)
                console.log('📦 [POLLING] Using complete refinement content from done response:', content.length, 'chars');
                finalContent = content;
              } else {
                // Accumulated is longer - might have parts from multiple polls
                console.log('📦 [POLLING] Using accumulated content (includes multiple chunks):', accumulatedContent.length, 'chars');
                finalContent = accumulatedContent;
              }
            } else if (content && content.length > accumulatedContent.length) {
              // Content is longer than accumulated - use it directly
              console.log('⚠️ [POLLING] Content in response is longer than accumulated - using content directly');
              finalContent = content;
            }
            
            console.log('✅ [POLLING] Sending complete event with content length:', finalContent.length);
            
            const chunkMeta = (chunkResponse as any).metadata;
            const resolvedMessageId =
              (chunkResponse as any).message_id ??
              (chunkMeta && typeof chunkMeta === 'object' ? (chunkMeta as any).message_id : undefined);

            // Send completion event with all metadata
            if (onChunk) {
              onChunk('complete', {
                type: 'complete',
                response: finalContent,
                content: finalContent, // Some handlers expect 'content'
                citations: chunkResponse.citations || [],
                chat_history_id: chunkResponse.chat_history_id,
                message_id: resolvedMessageId, // Persisted assistant row id for retry / more sources
                metadata: chunkResponse.metadata || {},
                is_preview_phase: is_preview_phase !== undefined ? is_preview_phase : false // Include phase in complete event
              });
            }
            return;
          }

          // Continue polling if not done
          if (!isDone && Date.now() - startTime < maxPollTime) {
            pollCount++;
            // Use faster polling for first 10 polls (first 1-2 seconds) to catch preview quickly
            // Then switch to normal interval
            const currentInterval = pollCount <= 10 ? initialPollInterval : pollInterval;
            setTimeout(pollChunks, currentInterval);
          }

        } catch (error: any) {
          if (isAbortError(error)) {
            console.log('🛑 [POLLING] Poll aborted by user');
            cancelOnAbort();
            return;
          }
          const status = httpStatus(error);
          if (isPermanentError(error)) {
            const msg =
              status === 404
                ? 'Chat poll 404 — job not found on this server (often: load balancer sent start vs chunk to different instances). Fix: sticky sessions or shared job store (Redis) for /smart/start + /smart/chunk. Also ensure GET /api/v1/mobile/chat/smart/chunk is deployed.'
                : status === 401 || status === 403
                  ? 'Not authorized to poll chat job.'
                  : error?.response?.data?.message || error.message || 'Chat job unavailable.';
            console.error('❌ [POLLING] Stopping (HTTP ' + String(status) + '):', msg);
            if (onChunk) {
              onChunk('error', { type: 'error', message: msg, error: 'PollPermanentError', status });
            }
            return;
          }
          const isTimeout = error?.code === 'ECONNABORTED' || error?.message?.includes('timeout') || error?.message?.includes('exceeded');
          if (isTimeout) {
            console.warn('⚠️ [POLLING] Chunk request timed out (backend may be slow), retrying…');
          } else {
            console.error('❌ [POLLING] Polling error:', error);
          }
          if (Date.now() - startTime < maxPollTime && !signal?.aborted) {
            pollCount++;
            const currentInterval = pollCount <= 10 ? initialPollInterval : pollInterval;
            setTimeout(pollChunks, currentInterval);
          } else {
            if (onChunk) {
              onChunk('error', {
                type: 'error',
                message: error.message || 'Network error. Please check your connection.',
                error: error.message
              });
            }
          }
        }
      };

      // Start polling immediately (first poll)
      pollChunks();

    } catch (error: any) {
      if (isAbortError(error)) {
        console.log('🛑 [POLLING] Chat polling aborted by user');
        return;
      }
      console.error('❌ [POLLING] Chat polling failed:', error);
      
      // If we have a jobId, try to cancel it (best effort, don't fail if cancel fails)
      if (currentJobId) {
        try {
          await this.cancelChatJob(currentJobId);
          console.log('✅ [POLLING] Cancelled job after error:', currentJobId);
        } catch (cancelError) {
          console.warn('⚠️ [POLLING] Failed to cancel job after error:', cancelError);
        }
      }
      
      if (onChunk) {
        onChunk('error', {
          type: 'error',
          message: error.message || 'Failed to start chat',
          error: error.message || 'UnknownError'
        });
      }
      
      throw error;
    }
  }

  async getChatHistory(limit: number = 50, offset: number = 0): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.CHAT_HISTORY, {
        params: { limit, offset }
      });
      return response.data;
    } catch (error: any) {
      const status = error.response?.status;
      const msg =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.response?.data?.detail ||
        (typeof error.response?.data === 'string' ? error.response.data : null);
      const suffix = status != null ? ` (${status})` : '';
      throw new Error(msg ? `${msg}${suffix}` : `Failed to fetch chat history${suffix}`);
    }
  }

  /** Get full conversation for a single chat (full messages). Use when opening a chat. */
  async getChatConversation(historyId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.get(`${MOBILE_ENDPOINTS.CHAT_HISTORY}/${historyId}`);
      return response.data;
    } catch (error: any) {
      const status = error.response?.status;
      const msg =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.response?.data?.detail ||
        (typeof error.response?.data === 'string' ? error.response.data : null);
      const suffix = status != null ? ` (${status})` : '';
      throw new Error(msg ? `${msg}${suffix}` : `Failed to fetch chat conversation${suffix}`);
    }
  }

  /**
   * Submit feedback for a chat assistant response (thumbs up/down).
   * Calls the same web endpoint used by the web app.
   */
  async submitChatFeedback(params: {
    chat_history_id?: number;
    message_pair_index?: number;
    query_text?: string;
    response_text?: string;
    feedback_score: number; // 1 = helpful, -1 = needs improvement, 0 = undo
    workspace_id?: number | null;
    conversation_id?: number | null;
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.CHAT_FEEDBACK, {
        chat_history_id: params.chat_history_id ?? null,
        message_pair_index: params.message_pair_index ?? null,
        query_text: params.query_text ?? null,
        response_text: params.response_text ?? null,
        feedback_score: params.feedback_score,
        workspace_id: params.workspace_id ?? null,
        conversation_id: params.conversation_id ?? null,
      });
      return response.data;
    } catch (error: any) {
      const msg = error.response?.data?.message ?? error.response?.data?.error ?? error.message;
      throw new Error(msg || 'Failed to submit feedback');
    }
  }

  async deleteChatHistory(id: number): Promise<ApiResponse> {
    try {
      // Use mobile endpoint for deleting chat history: /api/v1/mobile/chat/history/{id}
      // Falls back to compatibility route: /api/chat/history/{id} if mobile endpoint is not available
      try {
        const response = await this.client.delete(`/api/v1/mobile/chat/history/${id}`);
        return response.data;
      } catch (mobileError: any) {
        // If mobile endpoint returns 404, try compatibility route
        if (mobileError.response?.status === 404) {
          console.log('Mobile endpoint not found, trying compatibility route');
          const response = await this.client.delete(`/api/chat/history/${id}`);
          return response.data;
        }
        // Re-throw other errors
        throw mobileError;
      }
    } catch (error: any) {
      const status = error.response?.status;
      const msg =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.response?.data?.detail ||
        (typeof error.response?.data === 'string' ? error.response.data : null);
      const suffix = status != null ? ` (${status})` : '';
      throw new Error(msg ? `${msg}${suffix}` : `Failed to delete chat history${suffix}`);
    }
  }

  // ==================== MOBILE FORMS ====================

  async getForms(): Promise<ApiResponse> {
    try {
      // Use proper mobile endpoint
      const response = await this.client.get(MOBILE_ENDPOINTS.FORMS);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch forms');
    }
  }

  async createForm(form: any): Promise<ApiResponse> {
    try {
      // Use proper mobile endpoint
      const response = await this.client.post(MOBILE_ENDPOINTS.FORMS, form);
      return response.data;
    } catch (error: any) {
      console.error('Create form error:', error);
      throw new Error(error.response?.data?.message || 'Failed to create form');
    }
  }

  async updateForm(id: number, form: any): Promise<ApiResponse> {
    try {
      // Use proper mobile endpoint
      const response = await this.client.put(MOBILE_ENDPOINTS.FORM_BY_ID(id), form);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to update form');
    }
  }

  /** Publish or unpublish a form (POST routes; avoids PUT issues and matches backend helpers). */
  async setFormPublished(id: number, published: boolean): Promise<ApiResponse> {
    try {
      const path = published
        ? MOBILE_ENDPOINTS.FORM_PUBLISH(id)
        : MOBILE_ENDPOINTS.FORM_UNPUBLISH(id);
      const response = await this.client.post(path);
      return response.data;
    } catch (error: any) {
      throw new Error(
        error.response?.data?.message ||
          (published ? 'Failed to publish form' : 'Failed to unpublish form')
      );
    }
  }

  async deleteForm(id: number): Promise<ApiResponse> {
    try {
      // Use proper mobile endpoint
      const response = await this.client.delete(MOBILE_ENDPOINTS.FORM_BY_ID(id));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to delete form');
    }
  }

  async getFormById(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.FORM_BY_ID(id));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to get form');
    }
  }

  async getFormResponses(id: number): Promise<ApiResponse> {
    try {
      // Use proper mobile endpoint
      const response = await this.client.get(MOBILE_ENDPOINTS.FORM_RESPONSES(id));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch form responses');
    }
  }

  // ==================== MOBILE ANALYTICS ====================

  async getDashboardStats(): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.DASHBOARD);
      return response.data;
    } catch (error: any) {
      // Return mock data on failure for development
      return {
        success: true,
        data: {
          stats: {
            totalDocuments: 0,
            totalForms: 0,
            totalFiles: 0,
            totalChats: 0,
          },
          recentActivity: []
        }
      };
    }
  }

  async getAnalytics(): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.ANALYTICS);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch analytics');
    }
  }

  async getRecentActivities(days = 7, limit = 10): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.ACTIVITY, {
        params: { days, limit }
      });
      return response.data;
    } catch (error: any) {
      // console.error('❌ Failed to get recent activities:', error);
      throw new Error(error.response?.data?.message || 'Failed to get recent activities');
    }
  }

  async getComprehensiveAnalytics(days = 30): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.COMPREHENSIVE, {
        params: { days }
      });
      return response.data;
    } catch (error: any) {
      // console.error('❌ Failed to get comprehensive analytics:', error);
      throw new Error(error.response?.data?.message || 'Failed to get comprehensive analytics');
    }
  }

  // ==================== NOTIFICATIONS ====================

  async getNotifications(): Promise<ApiResponse & { data?: { notifications: any[]; unreadCount: number } }> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.NOTIFICATIONS);
      return response.data;
    } catch (error: any) {
      return {
        success: false,
        data: { notifications: [], unreadCount: 0 },
        message: error.response?.data?.message || 'Failed to get notifications',
      };
    }
  }

  async markNotificationRead(notificationId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.NOTIFICATION_MARK_READ(notificationId));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to mark notification as read');
    }
  }

  async markAllNotificationsRead(): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.NOTIFICATION_MARK_ALL_READ);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to mark all as read');
    }
  }

  async clearAllNotifications(): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(MOBILE_ENDPOINTS.NOTIFICATION_CLEAR_ALL);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to clear all notifications');
    }
  }

  async getFileInvites(): Promise<ApiResponse & { file_invites?: Array<{
    share_id: number;
    file_id: number;
    file_name: string;
    is_draft: boolean;
    role: string;
    inviter_name: string;
    message?: string;
    created_at?: string;
    expires_at?: string;
  }> }> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.FILE_INVITES);
      return response.data;
    } catch (error: any) {
      return { success: false, file_invites: [], message: error.response?.data?.message || 'Failed to get file invites' };
    }
  }

  async acceptFileInvite(shareId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.FILE_INVITE_ACCEPT(shareId));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to accept file invite');
    }
  }

  async rejectFileInvite(shareId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.FILE_INVITE_REJECT(shareId));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to reject file invite');
    }
  }

  /** Unified file-sharing: accept share (internal or external). Use for draft_invite/file_invite notifications. */
  async acceptFileShare(shareId: number): Promise<ApiResponse & { file_id?: number }> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.FILE_SHARING_ACCEPT(shareId));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to accept share');
    }
  }

  /** Unified file-sharing: reject share (internal or external). */
  async rejectFileShare(shareId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.FILE_SHARING_REJECT(shareId));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to reject share');
    }
  }

  async acceptWorkspaceInvitation(invitationId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WORKSPACE_INVITATION_ACCEPT(invitationId));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to accept workspace invitation');
    }
  }

  async getWorkspaceInvitationByToken(token: string): Promise<ApiResponse> {
    const response = await this.client.get(
      `/api/v1/web/workspaces/invitations/${encodeURIComponent(token)}`,
    );
    return response.data;
  }

  async acceptWorkspaceInvitationByToken(token: string): Promise<ApiResponse> {
    const response = await this.client.post(
      `/api/v1/web/workspaces/invitations/${encodeURIComponent(token)}/accept`,
    );
    return response.data;
  }

  async processWorkspaceInvitationByToken(token: string): Promise<ApiResponse> {
    const response = await this.client.post(
      `/api/v1/web/workspaces/invitations/${encodeURIComponent(token)}/process`,
    );
    return response.data;
  }

  async rejectWorkspaceInvitation(invitationId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WORKSPACE_INVITATION_REJECT(invitationId));
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to reject workspace invitation');
    }
  }

  async approveJoinRequest(videoCallId: number, joinRequestId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(
        MOBILE_ENDPOINTS.JOIN_REQUEST_APPROVE(videoCallId, joinRequestId),
      );
      return response.data;
    } catch (error: any) {
      throw new Error(
        error.response?.data?.message ||
          error.response?.data?.error ||
          'Failed to approve join request',
      );
    }
  }

  async rejectJoinRequest(videoCallId: number, joinRequestId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(
        MOBILE_ENDPOINTS.JOIN_REQUEST_REJECT(videoCallId, joinRequestId),
      );
      return response.data;
    } catch (error: any) {
      throw new Error(
        error.response?.data?.message ||
          error.response?.data?.error ||
          'Failed to reject join request',
      );
    }
  }

  async registerPushToken(expoPushToken: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.PUSH_TOKEN, {
        token: expoPushToken,
        expo_push_token: expoPushToken,
      });
      return response.data;
    } catch (error: any) {
      console.warn('Register push token failed:', error.response?.data?.message || error.message);
      return { success: false, message: error.response?.data?.message || 'Failed to register push token' };
    }
  }

  // ==================== WEB RECEIPT & INVOICE ENDPOINTS ====================
  // All receipt and invoice operations use web endpoints (no mobile-specific endpoints).
  // Same as web: GET /api/v1/web/analysis/receipts (search uses similarity match on store name).

  async getReceiptAnalytics(
    days?: number, 
    category?: string, 
    dateFrom?: string, 
    dateTo?: string, 
    search?: string
  ): Promise<ApiResponse> {
    try {
      console.log(`📊 Getting receipt analytics (${days ? `${days} days` : 'custom range'}${category ? `, category: ${category}` : ''}${search ? `, search: ${search}` : ''})`);
      const params: any = {};
      if (days !== undefined && days !== null) {
        params.days = days;
      }
      if (category) params.category = category;
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      if (search) params.search = search;
      const response = await this.client.get('/api/v1/web/analysis/receipts', { params });
      console.log('✅ Receipt analytics loaded from web endpoint');
      return response.data;
    } catch (error: any) {
      // Log detailed error for debugging (without throwing)
      const errorMessage = error.response?.data?.message || error.response?.data?.error || error.message || 'Failed to fetch receipt analytics';
      const status = error.response?.status;
      
      if (status) {
        console.warn(`❌ Receipt analytics failed (${status}):`, errorMessage);
      } else {
        console.warn('❌ Receipt analytics failed:', errorMessage);
      }
      
      // Return a graceful error response instead of throwing
      // This allows the dashboard to continue with empty receipt data
      return {
        success: false,
        message: errorMessage,
        data: null
      };
    }
  }

  /**
   * POST /api/v1/web/analysis/receipts/download-report — Word .docx (same as web).
   * Binary response; use postWebAnalysisDownloadReport or downloadReceiptReport.
   */
  async downloadReceiptReport(body: WebAnalysisDownloadReportBody): Promise<{
    arrayBuffer: ArrayBuffer;
    filename?: string;
  }> {
    return this.postWebAnalysisDownloadReport('receipts', body);
  }

  async autoCategorizeAllReceipts(): Promise<ApiResponse> {
    try {
      const response = await this.client.post('/receipts/auto-categorize');
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to auto-categorize receipts');
    }
  }

  async autoCategorizeReceipt(fileId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(`/files/${fileId}/auto-categorize`);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to auto-categorize receipt');
    }
  }

  async batchAutoCategorizeReceipts(fileIds: number[]): Promise<ApiResponse> {
    try {
      const response = await this.client.post('/files/batch-auto-categorize', { file_ids: fileIds });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to batch auto-categorize receipts');
    }
  }

  async categorizeReceipt(fileId: number, category: string): Promise<ApiResponse> {
    try {
      // Use web endpoint - route is registered under /api/v1/web prefix
      const endpoint = `/api/v1/web/files/${fileId}/categorize`;
      const payload = { category };

      console.log(`📊 Categorizing receipt:`, {
        fileId,
        category,
        endpoint,
        payload,
        baseURL: this.client.defaults.baseURL
      });

      const response = await this.client.put(endpoint, payload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      console.log('📊 Categorize response:', response.data);
      return response.data;
    } catch (error: any) {
      console.error('❌ Categorize receipt error:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.response?.data?.message || error.response?.data?.error,
        data: error.response?.data,
        requestUrl: error.config?.url,
        fullUrl: (error.config?.baseURL || '') + (error.config?.url || '')
      });
      // Return a graceful error response instead of throwing
      return {
        success: false,
        message: error.response?.data?.message || error.response?.data?.error || error.message || 'Failed to categorize receipt',
        data: null
      };
    }
  }

  /**
   * Correct file data (receipt/invoice) - same endpoint as web.
   * POST /api/v1/web/files/<file_id>/correct with correction_data (only edited fields + file_kind).
   * Backend merges into existing json_data. Mobile uses this for Edit receipt/invoice.
   */
  async correctFileData(fileId: number, correctionData: Record<string, unknown>): Promise<ApiResponse> {
    try {
      const endpoint = `/api/v1/web/files/${fileId}/correct`;
      const payload = { correction_data: correctionData };

      const response = await this.client.post(endpoint, payload, {
        headers: { 'Content-Type': 'application/json' },
      });

      return response.data;
    } catch (error: any) {
      const message = error.response?.data?.message || error.response?.data?.error || error.message || 'Failed to save correction';
      console.error('❌ Correct file data error:', { fileId, message, data: error.response?.data });
      return {
        success: false,
        message,
        data: null,
      };
    }
  }

  async getImportedReceipts(): Promise<ApiResponse> {
    try {
      const response = await this.client.get('/platforms/imported-receipts');
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch imported receipts');
    }
  }

  async getImportedReceiptsStats(): Promise<ApiResponse> {
    try {
      const response = await this.client.get('/platforms/imported-receipts/stats');
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch imported receipts stats');
    }
  }

  async getInvoiceAnalytics(
    days?: number, 
    category?: string, 
    dateFrom?: string, 
    dateTo?: string, 
    search?: string
  ): Promise<ApiResponse> {
    try {
      console.log(`📊 Getting invoice analytics (${days ? `${days} days` : 'custom range'}${category ? `, category: ${category}` : ''}${search ? `, search: ${search}` : ''})`);
      const params: any = {};
      if (days !== undefined && days !== null) {
        params.days = days;
      }
      if (category) params.category = category;
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      if (search) params.search = search;
      const response = await this.client.get('/api/v1/web/analysis/invoices', { params });
      console.log('✅ Invoice analytics loaded from web endpoint');
      return response.data;
    } catch (error: any) {
      // Log detailed error for debugging (without throwing)
      const errorMessage = error.response?.data?.message || error.response?.data?.error || error.message || 'Failed to fetch invoice analytics';
      const status = error.response?.status;
      
      if (status) {
        console.warn(`❌ Invoice analytics failed (${status}):`, errorMessage);
      } else {
        console.warn('❌ Invoice analytics failed:', errorMessage);
      }
      
      // Return a graceful error response instead of throwing
      // This allows the dashboard to continue with empty invoice data
      return {
        success: false,
        message: errorMessage,
        data: null
      };
    }
  }

  /**
   * POST /api/v1/web/analysis/invoices/download-report — Word .docx (same as web).
   */
  async downloadInvoiceReport(body: WebAnalysisDownloadReportBody): Promise<{
    arrayBuffer: ArrayBuffer;
    filename?: string;
  }> {
    return this.postWebAnalysisDownloadReport('invoices', body);
  }

  /**
   * Web analysis DOCX download — POST + JSON, session auth via axios client (same as other /api/v1/web routes).
   */
  async postWebAnalysisDownloadReport(
    segment: 'receipts' | 'invoices',
    body: WebAnalysisDownloadReportBody
  ): Promise<{ arrayBuffer: ArrayBuffer; filename?: string }> {
    const url = `/api/v1/web/analysis/${segment}/download-report`;
    try {
      const response = await this.client.post<ArrayBuffer>(url, body, {
        responseType: 'arraybuffer',
        headers: { 'Content-Type': 'application/json' },
      });
      const cd =
        (response.headers['content-disposition'] as string | undefined) ||
        (response.headers['Content-Disposition'] as string | undefined);
      let filename: string | undefined;
      if (cd) {
        const star = cd.match(/filename\*=UTF-8''([^;\s]+)/i);
        if (star?.[1]) {
          try {
            filename = decodeURIComponent(star[1].replace(/"/g, ''));
          } catch {
            filename = star[1];
          }
        } else {
          const m = cd.match(/filename="([^"]+)"/i) || cd.match(/filename=([^;\s]+)/i);
          if (m?.[1]) filename = m[1].replace(/^["']|["']$/g, '');
        }
      }
      return { arrayBuffer: response.data, filename };
    } catch (error: any) {
      const message = this.messageFromWebBinaryError(error);
      throw new Error(message || 'Failed to download report');
    }
  }

  private messageFromWebBinaryError(error: any): string | undefined {
    const data = error.response?.data;
    if (data instanceof ArrayBuffer) {
      try {
        const text = new TextDecoder().decode(data);
        const j = JSON.parse(text);
        return j.message || j.error || j.detail;
      } catch {
        return undefined;
      }
    }
    if (typeof data === 'string') {
      try {
        const j = JSON.parse(data);
        return j.message || j.error;
      } catch {
        return data;
      }
    }
    return error.response?.data?.message || error.message;
  }

  async linkReceiptToInvoice(invoiceId: number, receiptId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(`/invoices/${invoiceId}/link-receipt`, { receipt_id: receiptId });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to link receipt to invoice');
    }
  }

  async bulkMatchReceiptsToInvoices(): Promise<ApiResponse> {
    try {
      const response = await this.client.post('/api/v1/web/invoices/bulk-match');
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to bulk match receipts to invoices');
    }
  }

  async updateInvoiceStatus(invoiceId: number, status: string): Promise<ApiResponse> {
    try {
      const response = await this.client.put(`/invoices/${invoiceId}/status`, { status });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to update invoice status');
    }
  }

  async updateInvoicePaymentStatus(fileId: number, paymentStatus: string): Promise<ApiResponse> {
    try {
      console.log(`💳 Updating payment status for invoice file ${fileId} to "${paymentStatus}"`);
      console.log('💳 Payment status request payload:', { payment_status: paymentStatus });
      
      // Use the file-based endpoint - accepts file ID instead of invoice record ID
      const endpoint = `/api/v1/web/files/${fileId}/payment-status`;
      console.log('💳 Payment status request endpoint:', endpoint);
      
      const response = await this.client.put(endpoint, { payment_status: paymentStatus });
      console.log('💳 Payment status response:', response.data);
      return response.data;
    } catch (error: any) {
      console.error('❌ Update payment status error:', {
        requestUrl: error.config?.url,
        fullUrl: (error.config?.baseURL || '') + (error.config?.url || ''),
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.response?.data?.message || error.response?.data?.error,
        data: error.response?.data,
      });
      return {
        success: false,
        message: error.response?.data?.message || 'Failed to update invoice payment status',
        data: null,
      };
    }
  }

  // ==================== MOBILE DOCUMENTS ====================

  async getDocuments(
    page = 1,
    perPage = 20,
    search?: string,
    category?: string,
    workspaceId?: number,
    onlyOwn = false,
    metadataOnly = false,
    requestTimeoutMs?: number,
    signal?: AbortSignal,
    folderOptions?: {
      folderId?: number | null;
      scope?: import('../types/folder').FileListScope;
      folderAware?: boolean;
    }
  ): Promise<ApiResponse> {
    const useFolderApi =
      folderOptions?.folderAware === true ||
      folderOptions?.folderId !== undefined ||
      (folderOptions?.scope != null && folderOptions.scope !== 'current_folder');

    if (useFolderApi && workspaceId == null) {
      try {
        const folderId = folderOptions?.folderId ?? null;
        const res = await this.getWebFiles({
          folderId,
          workspaceId,
          search,
          scope: folderOptions?.scope ?? 'current_folder',
          page,
          perPage,
          fileKind: category,
          signal,
        });
        let files = res.files;
        if (category) {
          const cat = category.toLowerCase();
          files = files.filter(
            (f) => (f.file_kind || '').toString().toLowerCase() === cat
          );
        }
        return {
          success: res.success,
          data: files,
          files,
          pagination: res.pagination,
        };
      } catch (error: any) {
        if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
          return {
            success: true,
            timedOut: true,
            data: [],
            files: [],
            pagination: { page, per_page: perPage, total: 0, has_more: false },
          };
        }
        console.warn('📁 API: Web folder-aware files failed, falling back to mobile:', error.message);
      }
    }

    try {
      // Mobile app should use mobile endpoints, not web endpoints
      // Use the mobile files endpoint which supports workspace_id and only_own parameters
      const params = new URLSearchParams();
      params.append('page', page.toString());
      params.append('perPage', perPage.toString());
      if (search) params.append('search', search);
      if (category) params.append('category', category);
      if (workspaceId != null) params.append('workspace_id', workspaceId.toString());
      if (onlyOwn) params.append('only_own', '1');
      if (metadataOnly) params.append('metadata_only', '1');
      
      const url = `${MOBILE_ENDPOINTS.FILES}?${params}`;
      const timeout = requestTimeoutMs ?? 25000;
      console.log('📁 API: Requesting files from mobile endpoint:', url);
      const response = await this.client.get(url, { timeout, signal });
      console.log('📁 API: Files response success:', response.data?.success, 'Files count:', response.data?.files?.length || response.data?.data?.length || 0);
      
      // Transform response format to match expected format
      if (response.data) {
        // Handle different response formats
        const files = response.data.files || response.data.data || [];
        const success = response.data.success !== false; // Default to true if not specified
        
        return {
          success,
          data: files,
          files: files,
          pagination: response.data.pagination || {
            page,
            per_page: perPage,
            total: Array.isArray(files) ? files.length : 0,
            has_more: false
          }
        };
      }
      
      return response.data;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        console.warn('⚠️ Documents request timed out - returning empty list for @ mentions');
        return {
          success: true,
          timedOut: true,   // callers (e.g. searchDocumentsForMention) must not wipe existing results
          data: [],
          files: [],
          pagination: { page, per_page: perPage, total: 0, has_more: false }
        };
      }
      console.warn('📁 API: Mobile files endpoint failed, falling back to getFiles:', error.message);
      return this.getFiles(page, perPage, search, category, workspaceId);
    }
  }

  // ==================== MOBILE TEMPLATES ====================

  async getTemplates(): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.TEMPLATES);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch templates');
    }
  }

  async getFormTemplates(): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.FORM_TEMPLATES);
      return response.data;
      
    } catch (error: any) {
      console.error('Get form templates error:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch form templates');
    }
  }

  // ==================== USER CHAT SYSTEM (Mobile-specific endpoints) ====================
  // These endpoints handle ONLY user-to-user and workspace chats (NOT AI chats)
  // Mobile endpoints are SEPARATE from web endpoints to avoid 403 errors
  // User chat: app uses web endpoints /api/v1/web/user-chat/* for list, messages, send, start, search
  
  /**
   * Get all user chats - Mobile-specific endpoint
   * Returns direct messages and workspace chats only
   */
  async getChats(limit: number = 50, offset: number = 0): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.USER_CHATS, { params: { limit, offset } });
      return response.data;
    } catch (error: any) {
      console.error('Get chats error:', error);
      const errorMessage = error.response?.data?.error || error.response?.data?.message || 'Failed to fetch chats';
      throw new Error(errorMessage);
    }
  }

  /**
   * Get messages for a specific chat - Mobile-specific endpoint
   */
  async getChatMessages(chatId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.USER_CHAT_MESSAGES(chatId));
      return response.data;
    } catch (error: any) {
      console.error('Get chat messages error:', error);
      console.error('Error details:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message,
        chatId: chatId
      });
      
      let errorMessage = 'Failed to fetch chat messages';
      
      if (error.response?.status === 404) {
        errorMessage = 'Chat not found. The chat may have been deleted or you may not have access.';
      } else if (error.response?.status === 403) {
        errorMessage = 'You do not have permission to view messages in this chat.';
      } else if (error.response?.data?.error) {
        errorMessage = error.response.data.error;
      } else if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      throw new Error(errorMessage);
    }
  }

  /**
   * Advance delivery cursor for secure messaging (web receipt API).
   */
  async ackChatDelivered(chatId: number, throughMessageId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.USER_CHAT_DELIVERED(chatId), {
        through_message_id: throughMessageId,
      });
      return response.data;
    } catch (error: any) {
      console.debug('ackChatDelivered failed', error?.message || error);
      throw error;
    }
  }

  /**
   * Advance read cursor for secure messaging (web receipt API).
   */
  async ackChatRead(chatId: number, throughMessageId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.USER_CHAT_READ(chatId), {
        through_message_id: throughMessageId,
      });
      return response.data;
    } catch (error: any) {
      console.debug('ackChatRead failed', error?.message || error);
      throw error;
    }
  }

  /**
   * Get all favorite chat ids from server (LLM history ids + user chat ids) so web favorites show on mobile.
   * GET /api/v1/mobile/chat/favorites
   */
  async getChatFavorites(): Promise<ApiResponse> {
    try {
      const response = await this.client.get('/api/v1/mobile/chat/favorites');
      return response.data;
    } catch (error: any) {
      console.error('Get chat favorites error:', error);
      return { success: false, favorite_history_ids: [], favorite_chat_ids: [] } as ApiResponse;
    }
  }

  /**
   * Set favorite for a chat (unified history) - syncs with web.
   * PUT /api/v1/mobile/chat/unified-history/<id>/favorite
   * @param unifiedId - For AI/LLM chats use "llm_<historyId>", for user chats use "user_<chatId>"
   * @param isFavorite - true to favorite, false to unfavorite
   */
  async setUnifiedChatFavorite(unifiedId: string, isFavorite: boolean): Promise<ApiResponse> {
    try {
      const response = await this.client.put(
        `/api/v1/mobile/chat/unified-history/${unifiedId}/favorite`,
        { is_favorite: isFavorite }
      );
      return response.data;
    } catch (error: any) {
      const status = error.response?.status;
      const msg =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.response?.data?.detail ||
        (typeof error.response?.data === 'string' ? error.response.data : null);
      const suffix = status != null ? ` (${status})` : '';
      throw new Error(msg ? `${msg}${suffix}` : `Failed to update favorite${suffix}`);
    }
  }

  /**
   * Delete a user chat - Uses unified endpoint like web version
   * Uses /api/v1/mobile/chat/unified-history/user_<id> so any participant can remove themselves
   */
  async deleteUserChat(chatId: number): Promise<ApiResponse> {
    try {
      // Use unified endpoint format: /api/v1/mobile/chat/unified-history/user_<id>
      const response = await this.client.delete(`/api/v1/mobile/chat/unified-history/user_${chatId}`);
      return response.data;
    } catch (error: any) {
      const status = error.response?.status;
      const msg =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.response?.data?.detail ||
        (typeof error.response?.data === 'string' ? error.response.data : null);
      const suffix = status != null ? ` (${status})` : '';
      // Preserve the original error's response status for proper error handling
      const newError: any = new Error(msg ? `${msg}${suffix}` : `Failed to delete user chat${suffix}`);
      newError.response = error.response; // Preserve response for status checking
      throw newError;
    }
  }

  /**
   * Send a message to a chat - Mobile-specific endpoint
   */
  async sendChatMessageToChat(message: string, chatId: number, metadata?: any): Promise<ApiResponse> {
    try {
      const payload: any = {
        content: message,
        type: 'text'
      };
      
      if (metadata) {
        payload.metadata = metadata;
      }
      
      const response = await this.client.post(MOBILE_ENDPOINTS.USER_CHAT_SEND(chatId), payload);
      return response.data;
    } catch (error: any) {
      console.error('Send chat message error:', error);
      console.error('Error details:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message
      });
      
      let errorMessage = 'Failed to send message';
      
      if (error.response?.status === 500) {
        errorMessage = error.response?.data?.error || 
                      error.response?.data?.message || 
                      'Server error. Please try again later.';
      } else if (error.response?.status === 404) {
        errorMessage = 'Chat not found. Please refresh and try again.';
      } else if (error.response?.status === 403) {
        errorMessage = 'You do not have permission to send messages in this chat.';
      } else if (error.response?.data?.error) {
        errorMessage = error.response.data.error;
      } else if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      throw new Error(errorMessage);
    }
  }

  /**
   * Start a new user chat (direct or workspace) - Mobile-specific endpoint
   */
  async startUserChat(data: { 
    type: 'direct' | 'workspace';
    user_id?: number;
    workspace_id?: number;
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.USER_CHAT_START, data);
      return response.data;
    } catch (error: any) {
      console.error('Start chat error:', error);
      const errorMessage = error.response?.data?.error || error.response?.data?.message || 'Failed to start chat';
      throw new Error(errorMessage);
    }
  }

  /**
   * Search for users and workspaces to start chats - Mobile-specific endpoint
   */
  async searchUsersForChat(query: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(`${MOBILE_ENDPOINTS.USER_CHAT_SEARCH_USERS}?q=${encodeURIComponent(query)}`, {
        timeout: 10000 // 10 second timeout for user search (faster than default 30s)
      });
      return response.data;
    } catch (error: any) {
      console.error('Search users error:', error);
      // Return empty array instead of throwing to allow app to continue
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        console.warn('⚠️ User search timed out - returning empty list');
        return { success: false, message: 'Request timed out', data: [] } as any;
      }
      const errorMessage = error.response?.data?.error || error.response?.data?.message || 'Failed to search users';
      throw new Error(errorMessage);
    }
  }

  async inviteSecureMessage(data: {
    email?: string;
    phone?: string;
    smsConsent?: boolean;
  }): Promise<ApiResponse> {
    const response = await this.client.post(MOBILE_ENDPOINTS.USER_CHAT_INVITE, {
      email: data.email,
      phone: data.phone,
      smsConsent: data.smsConsent,
    });
    return response.data;
  }

  async acceptSecureMessageInvite(data: {
    token?: string;
    invitation_id?: number;
  }): Promise<ApiResponse> {
    const response = await this.client.post(MOBILE_ENDPOINTS.USER_CHAT_INVITE_ACCEPT, data);
    return response.data;
  }

  async resolveSecureMessageInvite(token: string): Promise<ApiResponse> {
    const response = await this.client.get(MOBILE_ENDPOINTS.USER_CHAT_INVITE_RESOLVE, {
      params: { token },
    });
    return response.data;
  }

  async getSecureMessageInvitesPendingForMe(): Promise<ApiResponse> {
    const response = await this.client.get(MOBILE_ENDPOINTS.USER_CHAT_INVITES_PENDING_FOR_ME);
    return response.data;
  }

  async resendSecureMessageInvite(inviteId: number): Promise<ApiResponse> {
    const response = await this.client.post(MOBILE_ENDPOINTS.USER_CHAT_INVITE_RESEND(inviteId));
    return response.data;
  }

  async revokeSecureMessageInvite(inviteId: number): Promise<ApiResponse> {
    const response = await this.client.post(MOBILE_ENDPOINTS.USER_CHAT_INVITE_REVOKE(inviteId));
    return response.data;
  }

  // ==================== MOBILE BOOKMARKS ====================
  
  async getBookmarks(limit: number = 50, offset: number = 0, workspaceId?: number): Promise<ApiResponse> {
    try {
      const params: { limit: number; offset: number; workspace_id?: number } = { limit, offset };
      if (workspaceId != null) params.workspace_id = workspaceId;
      const response = await this.client.get(MOBILE_ENDPOINTS.BOOKMARKS, { params });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch bookmarks');
    }
  }

  async addFileToBookmark(bookmarkId: number, fileId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(`${MOBILE_ENDPOINTS.BOOKMARKS}/${bookmarkId}/files/${fileId}`);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to add file to bookmark');
    }
  }

  async addFilesToBookmark(bookmarkId: number, fileIds: number[]): Promise<ApiResponse> {
    try {
      const response = await this.client.post(`${MOBILE_ENDPOINTS.BOOKMARKS}/${bookmarkId}/files/bulk`, { file_ids: fileIds });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        try {
          for (const fileId of fileIds) {
            await this.client.post(`${MOBILE_ENDPOINTS.BOOKMARKS}/${bookmarkId}/files/${fileId}`);
          }
          return { success: true, message: `${fileIds.length} file(s) added to bookmark successfully` };
        } catch (fallbackError: any) {
          throw new Error(fallbackError.response?.data?.message || 'Failed to add files to bookmark');
        }
      }
      throw new Error(error.response?.data?.message || 'Failed to add files to bookmark');
    }
  }

  async getBookmarkFiles(
    bookmarkId: number,
    params?: { limit?: number; offset?: number }
  ): Promise<ApiResponse> {
    try {
      const response = await this.client.get(`${MOBILE_ENDPOINTS.BOOKMARKS}/${bookmarkId}/files`, {
        params: params ?? undefined,
      });
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch bookmark files');
    }
  }

  async removeFileFromBookmark(bookmarkId: number, fileId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(`${MOBILE_ENDPOINTS.BOOKMARKS}/${bookmarkId}/files/${fileId}`);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to remove file from bookmark');
    }
  }

  async updateBookmark(bookmarkId: number, data: { name?: string; description?: string; color?: string; is_locked?: boolean }): Promise<ApiResponse> {
    try {
      const response = await this.client.put(`${MOBILE_ENDPOINTS.BOOKMARKS}/${bookmarkId}`, data);
      return response.data;
    } catch (error: any) {
      console.error('Update bookmark error:', error);
      throw new Error(error.response?.data?.message || 'Failed to update bookmark');
    }
  }

  async deleteBookmark(bookmarkId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(`${MOBILE_ENDPOINTS.BOOKMARKS}/${bookmarkId}`);
      return response.data;
    } catch (error: any) {
      console.error('Delete bookmark error:', error);
      throw new Error(error.response?.data?.message || 'Failed to delete bookmark');
    }
  }

  async createBookmark(bookmarkData: { name: string; description?: string; color: string }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.BOOKMARKS, bookmarkData);
      return response.data;
    } catch (error: any) {
      console.error('Create bookmark error:', error);
      throw new Error(error.response?.data?.message || 'Failed to create bookmark');
    }
  }

  // ==================== MOBILE WORKSPACES ====================

  /** Get workspaces where a file is visible (Make Global / workspace sharing). */
  async getFileWorkspaceVisibility(fileId: number): Promise<ApiResponse & { visible_workspaces?: { id: number; name?: string }[] }> {
    const response = await this.client.get(MOBILE_ENDPOINTS.FILE_WORKSPACE_VISIBILITY(fileId));
    return response.data;
  }

  /** Set which workspaces can see a file (Make Global). Reuses web logic via mobile route. */
  async setFileWorkspaceVisibility(fileId: number, workspaceIds: number[]): Promise<ApiResponse> {
    const response = await this.client.put(MOBILE_ENDPOINTS.FILE_WORKSPACE_VISIBILITY(fileId), { workspace_ids: workspaceIds });
    return response.data;
  }
  
  async getMobileWorkspaces(limit: number = 50, offset: number = 0): Promise<ApiResponse> {
    try {
      console.log('🔄 Loading workspaces from:', MOBILE_ENDPOINTS.WORKSPACES);
      // Use proper mobile endpoint with pagination
      // Increased timeout to 15s for better reliability with slow backends
      const response = await this.client.get(MOBILE_ENDPOINTS.WORKSPACES, {
        params: { limit, offset },
        timeout: 15000
      });
      return response.data;
    } catch (error: any) {
      // Suppress timeout error logs - they're expected and handled gracefully by callers
      const isTimeout = error.message?.includes('timeout') || error.message?.includes('exceeded');
      
      if (isTimeout) {
        // Timeout errors are handled gracefully, no need to log
        const errorMessage = error.response?.data?.message || error.message || 'Failed to fetch workspaces';
        throw new Error(errorMessage);
      } else {
        // Only log unexpected errors
        console.error('❌ Get mobile workspaces error:', {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status,
          url: error.config?.url
        });
        const errorMessage = error.response?.data?.message || error.message || 'Failed to fetch workspaces';
        throw new Error(errorMessage);
      }
    }
  }

  async createWorkspace(data: {
    name: string;
    description?: string;
    slug?: string;
  }): Promise<ApiResponse> {
    try {
      // Use proper mobile endpoint
      const response = await this.client.post(MOBILE_ENDPOINTS.WORKSPACES, data);
      return response.data;
    } catch (error: any) {
      console.error('Create workspace error:', error);
      throw new Error(error.response?.data?.message || 'Failed to create workspace');
    }
  }

  async getWorkspace(id: number): Promise<ApiResponse & { workspace?: any }> {
    try {
      // Mobile endpoint supports Bearer JWT (same token as all other mobile calls).
      const response = await this.client.get(MOBILE_ENDPOINTS.WORKSPACE_BY_ID(id), { timeout: 12000 });
      return response.data;
    } catch (error: any) {
      const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
      if (!isTimeout) {
        try {
          const fallback = await this.client.get(MOBILE_ENDPOINTS.WORKSPACE_WEB_BY_ID(id), { timeout: 12000 });
          return fallback.data;
        } catch (_fb: any) {
          // fall through to throw
        }
      }
      throw new Error(error.response?.data?.message || 'Failed to fetch workspace');
    }
  }

  async updateWorkspace(id: number, data: {
    name?: string;
    description?: string;
    is_active?: boolean;
  }): Promise<ApiResponse> {
    try {
      // Same as web WorkspaceManager: PATCH /api/v1/web/workspaces/:id
      const response = await this.client.patch(MOBILE_ENDPOINTS.WORKSPACE_WEB_BY_ID(id), data);
      return response.data;
    } catch (error: any) {
      console.error('Update workspace error:', error);
      throw new Error(error.response?.data?.message || 'Failed to update workspace');
    }
  }

  async deleteWorkspace(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(MOBILE_ENDPOINTS.WORKSPACE_WEB_BY_ID(id));
      return response.data;
    } catch (error: any) {
      console.error('Delete workspace error:', error);
      throw new Error(error.response?.data?.message || 'Failed to delete workspace');
    }
  }

  async getWorkspaceMembers(id: number, limit: number = 100, offset: number = 0): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.WORKSPACE_MEMBERS(id), {
        params: { limit, offset }
      });
      return response.data;
    } catch (error: any) {
      console.error('Get workspace members error:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch workspace members');
    }
  }

  async addWorkspaceMember(workspaceId: number, data: {
    email: string;
    role: 'admin' | 'member' | 'viewer';
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WORKSPACE_MEMBERS(workspaceId), data);
      return response.data;
    } catch (error: any) {
      console.error('Add workspace member error:', error);
      throw new Error(error.response?.data?.message || 'Failed to add workspace member');
    }
  }

  async updateWorkspaceMember(workspaceId: number, memberId: number, data: {
    role: 'admin' | 'member' | 'viewer';
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.WORKSPACE_MEMBER_BY_ID(workspaceId, memberId), data);
      return response.data;
    } catch (error: any) {
      console.error('Update workspace member error:', error);
      throw new Error(error.response?.data?.message || 'Failed to update workspace member');
    }
  }

  async removeWorkspaceMember(workspaceId: number, memberId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(MOBILE_ENDPOINTS.WORKSPACE_MEMBER_BY_ID(workspaceId, memberId));
      return response.data;
    } catch (error: any) {
      console.error('Remove workspace member error:', error);
      throw new Error(error.response?.data?.message || 'Failed to remove workspace member');
    }
  }

  async updateWorkspaceMemberRole(workspaceId: number, memberId: number, role: 'owner' | 'admin' | 'member' | 'viewer'): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.WORKSPACE_MEMBER_ROLE(workspaceId, memberId), { role });
      return response.data;
    } catch (error: any) {
      console.error('Update workspace member role error:', error);
      throw new Error(error.response?.data?.message || 'Failed to update member role');
    }
  }

  async resendWorkspaceInvitation(workspaceId: number, invitationId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WORKSPACE_INVITATION_RESEND(workspaceId, invitationId));
      return response.data;
    } catch (error: any) {
      console.error('Resend workspace invitation error:', error);
      throw new Error(error.response?.data?.message || 'Failed to resend invitation');
    }
  }

  async cancelWorkspaceInvitation(workspaceId: number, invitationId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(MOBILE_ENDPOINTS.WORKSPACE_INVITATION_BY_ID(workspaceId, invitationId));
      return response.data;
    } catch (error: any) {
      console.error('Cancel workspace invitation error:', error);
      throw new Error(error.response?.data?.message || 'Failed to cancel invitation');
    }
  }

  async getWorkspaceUsers(): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.WORKSPACE_USERS, {
        timeout: 25000 // 25s for slow backends; on timeout we return empty list below
      });
      return response.data;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        console.warn('⚠️ Workspace users request timed out - returning empty list');
        return { success: true, data: { users: [] } } as ApiResponse;
      }
      console.error('Get workspace users error:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch workspace users');
    }
  }

  async inviteToWorkspace(workspaceId: number, email: string, role: string = 'member'): Promise<ApiResponse> {
    try {
      const response = await this.client.post(`/api/v1/mobile/workspaces/${workspaceId}/invite`, {
        email,
        role
      });
      return response.data;
    } catch (error: any) {
      console.error('Invite to workspace error:', error);
      throw new Error(error.response?.data?.message || 'Failed to invite user to workspace');
    }
  }

  /**
   * Workspace-scoped file list for mobile.
   * Prefers GET /api/v1/mobile/files?workspace_id=… (paginated, optimized) — avoids the web
   * workspace files route which often times out on large workspaces.
   */
  async getWorkspaceFiles(
    workspaceId: number,
    options?: {
      page?: number;
      perPage?: number;
      offset?: number;
      timeoutMs?: number;
      /** When false, API returns bookmark metadata + file_count only (no nested files). Default false for mobile. */
      includeBookmarkFiles?: boolean;
    }
  ): Promise<
    ApiResponse & {
      bookmarks?: any[];
      total_count?: number;
      has_more?: boolean;
      next_offset?: number | null;
    }
  > {
    const page = options?.page ?? 1;
    const perPage = Math.min(options?.perPage ?? 100, 100);
    const timeoutMs = options?.timeoutMs ?? 28000;
    const offset =
      options?.offset != null ? Math.max(0, options.offset) : (page - 1) * perPage;
    const includeBookmarkFiles = options?.includeBookmarkFiles === true;

    const normalizeWebShape = (data: any) => {
      const files = data?.files ?? data?.data ?? [];
      const bookmarks = data?.bookmarks ?? [];
      return {
        success: data?.success !== false,
        files,
        data: files,
        bookmarks,
        total_count: data?.total_count ?? files.length,
        has_more: data?.has_more,
        next_offset: data?.next_offset,
        workspace: data?.workspace,
      };
    };

    try {
      // Dedicated mobile route — delegates to same logic as web get_workspace_files + JWT user id
      const params = new URLSearchParams();
      params.append('limit', String(perPage));
      params.append('offset', String(offset));
      params.append('include_bookmark_files', includeBookmarkFiles ? 'true' : 'false');
      const url = `${MOBILE_ENDPOINTS.WORKSPACE_FILES(workspaceId)}?${params}`;
      const response = await this.client.get(url, { timeout: timeoutMs });
      return normalizeWebShape(response.data);
    } catch (error: any) {
      const isTimeout =
        error.code === 'ECONNABORTED' ||
        error.message?.includes('timeout') ||
        error.message?.includes('exceeded');
      if (!isTimeout && error.response?.status !== 404) {
        try {
          const params = new URLSearchParams();
          params.append('limit', String(perPage));
          params.append('offset', String(offset));
          params.append('include_bookmark_files', includeBookmarkFiles ? 'true' : 'false');
          const response = await this.client.get(
            `/api/v1/web/workspaces/${workspaceId}/files?${params}`,
            { timeout: 35000 }
          );
          return normalizeWebShape(response.data);
        } catch (webErr: any) {
          console.error('Get workspace files (web fallback) error:', webErr);
        }
      }
      if (isTimeout) {
        try {
          const params = new URLSearchParams();
          params.append('limit', String(perPage));
          params.append('offset', String(offset));
          params.append('include_bookmark_files', includeBookmarkFiles ? 'true' : 'false');
          const response = await this.client.get(
            `/api/v1/web/workspaces/${workspaceId}/files?${params}`,
            { timeout: 35000 }
          );
          return normalizeWebShape(response.data);
        } catch (webErr: any) {
          console.error('Get workspace files (web timeout fallback) error:', webErr);
        }
      }
      // Legacy generic mobile list (may differ from web UNION — last resort)
      try {
        const params = new URLSearchParams();
        params.append('page', String(page));
        params.append('perPage', String(perPage));
        params.append('workspace_id', String(workspaceId));
        const url = `${MOBILE_ENDPOINTS.FILES}?${params}`;
        const response = await this.client.get(url, { timeout: timeoutMs });
        const data = response.data;
        const files = data?.files ?? data?.data ?? [];
        const pag = data?.pagination;
        return {
          success: data?.success !== false,
          files,
          data: files,
          bookmarks: [],
          total_count: pag?.total ?? data?.total_count ?? files.length,
          pagination: pag,
          workspace: data?.workspace,
        };
      } catch (legacyErr: any) {
        console.error('Get workspace files (legacy fallback) error:', legacyErr);
      }
      console.error('Get workspace files error:', error);
      throw new Error(
        error.response?.data?.message ||
          error.response?.data?.error ||
          (isTimeout ? 'Request timed out while loading workspace files' : error.message) ||
          'Failed to fetch workspace files'
      );
    }
  }

  // ==================== UPLOAD LINKS (WEB ENDPOINTS) ====================
  // Use web endpoints so file request links work at https://grabdocs.com/upload-to/{link_token}

  /** Normalize web link object to mobile shape (url = upload-to/link_token). */
  private normalizeWebUploadLink(link: any): any {
    if (!link) return link;
    const token = link.link_token ?? link.token;
    return {
      ...link,
      id: link.id,
      name: link.name ?? link.link_name,
      token: token,
      url: token ? `upload-to/${token}` : (link.url || ''),
      upload_count: link.upload_count ?? link.current_uploads ?? 0,
      uploaded_files: link.uploaded_files ?? [],
      upload_code: link.upload_code ?? null,
    };
  }

  async getUploadLinks(page = 1, perPage = 20, q?: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.UPLOAD_LINKS, {
        params: { page, perPage, ...(q ? { q } : {}) },
      });
      const data = response.data;
      const links = (data.upload_links || []).map((l: any) => this.normalizeWebUploadLink(l));
      return { ...data, success: data.success !== false, upload_links: links };
    } catch (error: any) {
      console.error('Get upload links error:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch upload links');
    }
  }

  async createUploadLink(data: {
    name: string;
    description?: string;
    expires_in_days?: number;
    max_uploads?: number;
  }): Promise<ApiResponse> {
    try {
      let expires_at: string | undefined;
      if (data.expires_in_days != null && data.expires_in_days > 0) {
        const d = new Date();
        d.setDate(d.getDate() + data.expires_in_days);
        expires_at = d.toISOString();
      }
      const payload: Record<string, unknown> = {
        link_name: data.name?.trim() || undefined,
        description: data.description?.trim() || undefined,
        expires_at,
        max_uploads: data.max_uploads,
      };
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_UPLOAD_LINKS, payload);
      const res = response.data;
      // Web returns { link } on create
      const link = res.link ?? res.upload_link;
      const upload_link = this.normalizeWebUploadLink(link);
      return { success: true, upload_link, ...res };
    } catch (error: any) {
      console.error('Create upload link error:', error);
      throw new Error(error.response?.data?.message || 'Failed to create upload link');
    }
  }

  async getUploadLink(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.UPLOAD_LINK_BY_ID(id));
      const data = response.data;
      const upload_link = this.normalizeWebUploadLink(data.upload_link ?? data.link);
      return { ...data, success: data.success !== false, upload_link };
    } catch (error: any) {
      console.error('Get upload link error:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch upload link');
    }
  }

  async updateUploadLink(id: number, data: any): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.WEB_UPLOAD_LINK_BY_ID(id), data);
      const res = response.data;
      const upload_link = this.normalizeWebUploadLink(res.upload_link ?? res.link);
      return { ...res, success: true, upload_link };
    } catch (error: any) {
      console.error('Update upload link error:', error);
      throw new Error(error.response?.data?.message || 'Failed to update upload link');
    }
  }

  async deleteUploadLink(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(MOBILE_ENDPOINTS.WEB_UPLOAD_LINK_BY_ID(id));
      return response.data;
    } catch (error: any) {
      console.error('Delete upload link error:', error);
      throw new Error(error.response?.data?.message || 'Failed to delete upload link');
    }
  }

  async shareUploadLink(id: number, data: {
    emails: string[];
    message?: string;
  }): Promise<ApiResponse> {
    try {
      // Backend expects `recipient_emails` (same contract as web quick-links).
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_UPLOAD_LINK_SEND_EMAIL(id), {
        recipient_emails: data.emails,
        message: data.message,
      });
      return response.data;
    } catch (error: any) {
      console.error('Share upload link error:', error);
      const errData = error.response?.data;
      throw new Error(errData?.message || errData?.error || 'Failed to share upload link');
    }
  }

  async regenerateUploadLinkCode(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_UPLOAD_LINK_REGENERATE_CODE(id));
      const res = response.data;
      const upload_link = this.normalizeWebUploadLink(res.upload_link ?? res.link);
      return { ...res, success: res.success !== false, upload_link, upload_code: res.upload_code ?? upload_link?.upload_code };
    } catch (error: any) {
      console.error('Regenerate upload link code error:', error);
      throw new Error(error.response?.data?.message || 'Failed to regenerate upload code');
    }
  }

  /** Get public upload link info by link_token (for opening shared link grabdocs.com/upload-to/{token}). */
  async getUploadLinkByToken(token: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.WEB_UPLOAD_TO(token));
      return response.data;
    } catch (error: any) {
      console.error('Get upload link by token error:', error);
      throw new Error(error.response?.data?.message || 'Invalid or expired upload link');
    }
  }

  /** Resolve upload code to link_token (by-code endpoint). */
  async getUploadLinkByCode(code: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.WEB_UPLOAD_TO_BY_CODE(code));
      return response.data;
    } catch (error: any) {
      console.error('Get upload link by code error:', error);
      throw new Error(error.response?.data?.message || 'Invalid upload code');
    }
  }

  // ==================== INTAKE ====================
  // List/detail: mobile routes (paginated). Create/update/send/item actions: web routes.

  async getIntakes(
    status?: string,
    page = 1,
    perPage = 20,
    filters?: { q?: string; due?: string; kind?: string },
  ): Promise<ApiResponse> {
    try {
      const params: Record<string, string | number> = { page, perPage };
      if (status) params.status = status;
      if (filters?.q) params.q = filters.q;
      if (filters?.due) params.due = filters.due;
      if (filters?.kind) params.kind = filters.kind;
      const response = await this.client.get(MOBILE_ENDPOINTS.INTAKES, {
        params,
        timeout: 15000,
      });
      return response.data;
    } catch (error: any) {
      console.error('Get intakes error:', error);
      throw new Error(error.response?.data?.message || 'Failed to load Intakes');
    }
  }

  async getIntake(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.INTAKE_BY_ID(id));
      return response.data;
    } catch (error: any) {
      console.error('Get intake error:', error);
      throw new Error(error.response?.data?.message || 'Failed to load Intake');
    }
  }

  async createIntake(data: {
    title: string;
    client_name?: string | null;
    client_primary_email?: string | null;
    authorized_senders?: { name: string; email: string }[];
    items: { label: string; description?: string | null; required?: boolean }[];
    due_at?: string | null;
    destination_folder_id?: number | null;
    template_id?: number | null;
    auto_verify_high_confidence?: boolean;
    reminder_preset?: 'gentle' | 'standard' | 'urgent' | 'custom';
    reminder_first_after_hours?: number;
    reminder_repeat_every_hours?: number;
    reminder_max_count?: number;
    client_ids?: number[];
    schedule?: Record<string, unknown>;
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_INTAKES, data);
      return response.data;
    } catch (error: any) {
      console.error('Create intake error:', error);
      throw new Error(error.response?.data?.message || 'Failed to create Intake');
    }
  }

  async getIntakeSchedules(status?: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.WEB_INTAKE_SCHEDULES, {
        params: status ? { status } : undefined,
      });
      return response.data;
    } catch (error: any) {
      console.error('Get intake schedules error:', error);
      throw new Error(error.response?.data?.message || 'Failed to load schedules');
    }
  }

  async getIntakeSchedule(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.WEB_INTAKE_SCHEDULE_BY_ID(id));
      return response.data;
    } catch (error: any) {
      console.error('Get intake schedule error:', error);
      throw new Error(error.response?.data?.message || 'Failed to load schedule');
    }
  }

  async patchIntakeSchedule(id: number, data: Record<string, unknown>): Promise<ApiResponse> {
    try {
      const response = await this.client.patch(MOBILE_ENDPOINTS.WEB_INTAKE_SCHEDULE_BY_ID(id), data);
      return response.data;
    } catch (error: any) {
      console.error('Patch intake schedule error:', error);
      throw new Error(error.response?.data?.message || 'Failed to update schedule');
    }
  }

  async updateIntake(id: number, data: Record<string, unknown>): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.WEB_INTAKE_BY_ID(id), data);
      return response.data;
    } catch (error: any) {
      console.error('Update intake error:', error);
      throw new Error(error.response?.data?.message || 'Failed to update Intake');
    }
  }

  async addIntakeItem(
    intakeId: number,
    data: { label: string; description?: string | null; required?: boolean },
  ): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_INTAKE_ITEMS(intakeId), data);
      return response.data;
    } catch (error: any) {
      console.error('Add intake item error:', error);
      throw new Error(error.response?.data?.message || 'Failed to add checklist item');
    }
  }

  async updateIntakeItem(
    intakeId: number,
    itemId: number,
    data: { label?: string; description?: string | null; required?: boolean },
  ): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.WEB_INTAKE_ITEM_BY_ID(intakeId, itemId), data);
      return response.data;
    } catch (error: any) {
      console.error('Update intake item error:', error);
      throw new Error(error.response?.data?.message || 'Failed to update checklist item');
    }
  }

  async deleteIntakeItem(intakeId: number, itemId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(MOBILE_ENDPOINTS.WEB_INTAKE_ITEM_BY_ID(intakeId, itemId));
      return response.data;
    } catch (error: any) {
      console.error('Delete intake item error:', error);
      throw new Error(error.response?.data?.message || 'Failed to remove checklist item');
    }
  }

  /** Archive (soft-delete) — reachable from any state, same as web. */
  async archiveIntake(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(MOBILE_ENDPOINTS.WEB_INTAKE_BY_ID(id));
      return response.data;
    } catch (error: any) {
      console.error('Archive intake error:', error);
      throw new Error(error.response?.data?.message || 'Failed to archive Intake');
    }
  }

  /** Restore an archived intake — recomputes workflow status from checklist progress. */
  async unarchiveIntake(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_INTAKE_UNARCHIVE(id));
      return response.data;
    } catch (error: any) {
      console.error('Unarchive intake error:', error);
      throw new Error(error.response?.data?.message || 'Failed to restore Intake');
    }
  }

  /** draft -> waiting_for_client; emails the client and schedules the first reminder. */
  async sendIntake(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_INTAKE_SEND(id));
      return response.data;
    } catch (error: any) {
      console.error('Send intake error:', error);
      throw new Error(error.response?.data?.message || 'Failed to send Intake');
    }
  }

  /** Manual "send reminder now" — only valid while waiting_for_client. */
  async remindIntake(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_INTAKE_REMIND(id));
      return response.data;
    } catch (error: any) {
      console.error('Remind intake error:', error);
      throw new Error(error.response?.data?.message || 'Failed to send reminder');
    }
  }

  /** Mark a Received match "Verified" (human-in-the-loop confirmation). */
  async confirmIntakeItem(intakeId: number, itemId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_INTAKE_ITEM_CONFIRM(intakeId, itemId));
      return response.data;
    } catch (error: any) {
      console.error('Confirm intake item error:', error);
      throw new Error(error.response?.data?.message || 'Failed to verify checklist item');
    }
  }

  /** Reject a match — item returns to Missing, file moves to Unmatched. */
  async rejectIntakeItem(intakeId: number, itemId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_INTAKE_ITEM_REJECT(intakeId, itemId));
      return response.data;
    } catch (error: any) {
      console.error('Reject intake item error:', error);
      throw new Error(error.response?.data?.message || 'Failed to reject match');
    }
  }

  /** Mark a checklist item Not Applicable (e.g. doesn't apply to this client). */
  async markIntakeItemNotApplicable(intakeId: number, itemId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.WEB_INTAKE_ITEM_NOT_APPLICABLE(intakeId, itemId));
      return response.data;
    } catch (error: any) {
      console.error('Mark intake item N/A error:', error);
      throw new Error(error.response?.data?.message || 'Failed to update checklist item');
    }
  }

  /** Manually satisfy a checklist item with a file from Needs Attention / Unmatched. */
  async assignIntakeFile(intakeId: number, itemId: number, fileId: number, confidence?: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.WEB_INTAKE_ITEM_ASSIGN(intakeId, itemId), {
        file_id: fileId,
        confidence,
      });
      return response.data;
    } catch (error: any) {
      console.error('Assign intake file error:', error);
      throw new Error(error.response?.data?.message || 'Failed to assign file');
    }
  }

  /** Owner uploads a file directly onto a pending checklist item. */
  async uploadIntakeItem(
    intakeId: number,
    itemId: number,
    file: { uri: string; name: string; type?: string },
  ): Promise<ApiResponse> {
    try {
      await assertUploadAllowedForCurrentNetwork();
      const formData = new FormData();
      formData.append('file', {
        uri: file.uri,
        name: file.name,
        type: file.type || 'application/octet-stream',
      } as any);
      const response = await this.client.post(
        MOBILE_ENDPOINTS.WEB_INTAKE_ITEM_UPLOAD(intakeId, itemId),
        formData,
      );
      return response.data;
    } catch (error: any) {
      console.error('Upload intake item error:', error);
      throw new Error(error.response?.data?.message || error.message || 'Failed to upload file');
    }
  }

  async getIntakeTemplates(): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.INTAKE_TEMPLATES);
      return response.data;
    } catch (error: any) {
      console.error('Get intake templates error:', error);
      throw new Error(error.response?.data?.message || 'Failed to load templates');
    }
  }

  async getIntakeTemplate(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.INTAKE_TEMPLATE_BY_ID(id));
      return response.data;
    } catch (error: any) {
      console.error('Get intake template error:', error);
      throw new Error(error.response?.data?.message || 'Failed to load template');
    }
  }

  async createIntakeTemplate(data: {
    name: string;
    industry_tag?: string | null;
    items: { label: string; description?: string | null; required?: boolean }[];
  }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.INTAKE_TEMPLATES, data);
      return response.data;
    } catch (error: any) {
      console.error('Create intake template error:', error);
      throw new Error(error.response?.data?.message || 'Failed to save template');
    }
  }

  async updateIntakeTemplate(
    id: number,
    data: {
      name: string;
      industry_tag?: string | null;
      items: { label: string; description?: string | null; required?: boolean }[];
    },
  ): Promise<ApiResponse> {
    try {
      const response = await this.client.put(MOBILE_ENDPOINTS.INTAKE_TEMPLATE_BY_ID(id), data);
      return response.data;
    } catch (error: any) {
      console.error('Update intake template error:', error);
      throw new Error(error.response?.data?.message || 'Failed to update template');
    }
  }

  async deleteIntakeTemplate(id: number): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(MOBILE_ENDPOINTS.INTAKE_TEMPLATE_BY_ID(id));
      return response.data;
    } catch (error: any) {
      console.error('Delete intake template error:', error);
      throw new Error(error.response?.data?.message || 'Failed to delete template');
    }
  }

  async shareFile(fileId: number): Promise<ApiResponse> {
    try {
      const response = await this.client.post(`/api/v1/mobile/file/${fileId}/share`);
      return response.data;
    } catch (error: any) {
      console.error('Share file error:', error);
      throw new Error(error.response?.data?.message || 'Failed to share file');
    }
  }

  async downloadFormResponsesCSV(formId: number): Promise<string> {
    try {
      const response = await this.client.get(`/api/v1/mobile/forms/${formId}/responses/download`, {
        responseType: 'text' // Changed from 'blob' to 'text' to get string directly
      });
      return response.data;
    } catch (error: any) {
      console.error('Download form responses CSV error:', error);
      throw new Error(error.response?.data?.message || 'Failed to download CSV');
    }
  }

  async getUploadLinkFiles(id: number, page = 1, perPage = 20): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.WEB_FILES_UPLOADED_VIA_LINKS);
      const data = response.data;
      const allFiles = data.files ?? data.uploaded_files ?? [];
      const forLink = allFiles.filter((f: any) => (f.upload_link_id ?? f.upload_link?.id) === id);
      return {
        success: true,
        files: forLink,
        uploaded_files: forLink,
        ...data,
      };
    } catch (error: any) {
      console.error('Get upload link files error:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch upload link files');
    }
  }

  // ==================== LEGACY WEB COMPATIBILITY ====================
  
  // Keep existing methods for backward compatibility with web endpoints
  async getWorkspaces(): Promise<ApiResponse> {
    try {
      const response = await this.client.get(API_ENDPOINTS.WORKSPACES);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Failed to fetch workspaces');
    }
  }

  async healthCheck(): Promise<ApiResponse> {
    try {
      const response = await this.client.get(API_ENDPOINTS.HEALTH);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Health check failed');
    }
  }

  // ==================== DEVICE MANAGEMENT ====================

  async getRegisteredDevices(): Promise<ApiResponse> {
    try {
      const response = await this.client.get('/api/v1/mobile/devices');
      return response.data;
    } catch (error: any) {
      console.error('Get devices failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch devices');
    }
  }

  async trustCurrentDevice(deviceInfo?: {
    fingerprint?: Record<string, unknown> | string;
    deviceName?: string;
    platform?: string;
    installationId?: string;
    deviceId?: string;
  }): Promise<ApiResponse & { deviceToken?: string; deviceId?: string; deviceName?: string }> {
    try {
      const response = await this.client.post('/api/v1/mobile/devices/trust', {
        deviceInfo,
        installationId: deviceInfo?.installationId,
        deviceId: deviceInfo?.deviceId,
        deviceName: deviceInfo?.deviceName,
        platform: deviceInfo?.platform,
      });
      const data = response.data;
      if (data?.deviceToken) {
        await secureStorage.setItem(STORAGE_KEYS.DEVICE_TOKEN, data.deviceToken);
      }
      return data;
    } catch (error: any) {
      console.error('Trust current device failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to trust device');
    }
  }

  async revokeDevice(deviceId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.delete(`/api/v1/mobile/devices/${deviceId}`);
      return response.data;
    } catch (error: any) {
      console.error('Revoke device failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to revoke device');
    }
  }

  async revokeAllDevices(): Promise<ApiResponse> {
    try {
      console.log('🔄 Revoking all devices...');
      const response = await this.client.post('/api/v1/mobile/devices/revoke-all');
      console.log('✅ Revoke all devices response:', response.data);
      return response.data;
    } catch (error: any) {
      console.error('❌ Revoke all devices failed:', error);
      console.error('❌ Error response:', error.response?.data);
      console.error('❌ Error status:', error.response?.status);
      throw new Error(error.response?.data?.message || 'Failed to revoke all devices');
    }
  }

  // ==================== MEETING MANAGEMENT ====================

  async getMeetings(limit: number = 50, offset: number = 0): Promise<ApiResponse> {
    try {
      console.log(`📱 Fetching meetings with limit=${limit}, offset=${offset}`);
      const response = await this.client.get('/api/v1/mobile/meetings', {
        params: { limit, offset },
        timeout: 20000 // 20 second timeout (reduced from default 30s to fail faster)
      });
      console.log(`✅ Successfully fetched meetings:`, response.data?.meetings?.length || 0);
      return response.data;
    } catch (error: any) {
      console.error('Get meetings failed:', error);
      
      // Handle timeout gracefully - return empty result instead of throwing
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        console.warn('⚠️ Meetings request timed out after 20s - returning empty result');
        // Return empty result instead of throwing so UI can still render
        return {
          success: false,
          data: { meetings: [] },
          message: 'Request timed out. Please check your connection and try again.'
        };
      }
      
      // For other errors, still throw but with better message
      throw new Error(error.response?.data?.message || 'Failed to fetch meetings');
    }
  }

  async joinMeeting(data: { meetingId: string; passcode?: string; force_join?: boolean }): Promise<ApiResponse> {
    try {
      const response = await this.client.post('/api/v1/mobile/meetings/join', data);
      return response.data;
    } catch (error: any) {
      const status = error.response?.status;
      const responseData = error.response?.data;
      if (
        status === 409 &&
        (responseData?.error_code === 'ALREADY_IN_MEETING' ||
          responseData?.error_code === 'ACTIVE_MEETING_EXISTS')
      ) {
        return {
          success: false,
          type: 'already_in_meeting',
          ...responseData,
        } as ApiResponse;
      }
      console.error('Join meeting failed:', error);
      throw new Error(responseData?.message || error.response?.data?.message || 'Failed to join meeting');
    }
  }

  async endMeeting(meetingId: string, forceEnd: boolean = false): Promise<ApiResponse> {
    try {
      console.log('Attempting to end meeting with ID:', meetingId, 'forceEnd:', forceEnd);
      console.log('Using endpoint: /api/v1/video/room/' + meetingId + '/end');
      
      const body = forceEnd ? { force: true } : {};
      const response = await this.client.post(`/api/v1/video/room/${meetingId}/end`, body);
      console.log('End meeting response:', response.data);
      return response.data;
    } catch (error: any) {
      console.error('End meeting failed:', error);
      console.error('Meeting ID was:', meetingId);
      const data = error.response?.data;
      const status = error.response?.status;

      // If room not found, return success anyway since the meeting is effectively ended
      if (status === 404) {
        console.log('Room not found - treating as success since meeting is effectively ended');
        return {
          success: true,
          message: 'Meeting ended successfully (room was not found in backend)',
          data: { meetingId },
        };
      }

      // 400 with active participants: backend requires confirmation before force-ending
      if (status === 400 && (data?.error === 'active_participants' || data?.requires_confirmation)) {
        return {
          success: false,
          requires_confirmation: true,
          message: data?.message || 'Meeting is still active. End it anyway?',
          participants: data?.participants,
          active_participants_count: data?.active_participants_count,
        } as ApiResponse;
      }

      throw new Error(data?.message || 'Failed to end meeting');
    }
  }

  async deleteMeeting(meetingId: string, forceDelete: boolean = false): Promise<ApiResponse> {
    try {
      console.log('🗑️ Attempting to delete meeting:', meetingId);
      console.log('🔍 Meeting ID type:', typeof meetingId, 'Value:', meetingId);
      console.log('🔍 Force delete:', forceDelete);
      
      // Use the correct endpoint that deletes the meeting record (backend expects POST, not DELETE)
      // Use delete-confirmed endpoint when user has already confirmed
      const url = forceDelete 
        ? `/api/v1/video/room/${meetingId}/delete-confirmed`
        : `/api/v1/video/room/${meetingId}/delete`;
      const response = await this.client.post(url, {});
      console.log('✅ Meeting delete response:', response.data);
      
      // Check if confirmation is required
      if (response.data.requires_confirmation && !forceDelete) {
        console.log('⚠️ Confirmation required for meeting with assets');
        return {
          success: false,
          requires_confirmation: true,
          message: response.data.message,
          asset_count: response.data.asset_count,
          asset_details: response.data.asset_details,
          warning: response.data.warning
        };
      }
      
      return response.data;
    } catch (error: any) {
      console.error('❌ Delete meeting failed:', error);
      console.error('Error details:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message
      });
      
      // Handle specific errors
      if (error.response?.status === 404) {
        throw new Error('Meeting not found. The meeting may have already been deleted or the ID is incorrect.');
      } else if (error.response?.status === 403) {
        throw new Error('You are not authorized to delete this meeting. Only the meeting creator can delete it.');
      }
      
      throw new Error(error.response?.data?.message || 'Failed to delete meeting');
    }
  }

  /** Remove meeting from the current user's invited/recent list without deleting the room (non-owners). */
  async dismissMeetingFromList(roomId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(
        `/api/v1/video/room/${roomId}/dismiss-from-list`,
        {}
      );
      return response.data;
    } catch (error: any) {
      const msg =
        error.response?.data?.error ||
        error.response?.data?.message ||
        'Failed to remove meeting from your list';
      throw new Error(msg);
    }
  }

  async sendMeetingInvite(meetingId: string, data: { emails: string[]; message?: string }): Promise<ApiResponse> {
    try {
      const response = await this.client.post(`/api/v1/mobile/meetings/${meetingId}/invite`, data);
      return response.data;
    } catch (error: any) {
      console.error('Send meeting invite failed:', error);
      throw new Error(
        error.response?.data?.message ||
          error.response?.data?.error ||
          'Failed to send meeting invite'
      );
    }
  }

  async copyMeetingInvite(meetingId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.post(`/api/v1/mobile/meetings/${meetingId}/copy-invite`);
      return response.data;
    } catch (error: any) {
      console.error('Copy meeting invite failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to copy meeting invite');
    }
  }

  async getMeetingInfo(meetingId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(`/api/v1/mobile/meetings/${meetingId}/info`);
      return response.data;
    } catch (error: any) {
      console.error('Get meeting info failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to get meeting info');
    }
  }

  /**
   * POST /api/v1/video/room/join-by-id (prepare). Bearer attached by interceptor.
   * All mobile join-by-id prepare calls must use this — do not post to join-by-id directly.
   */
  async prepareVideoJoinById(payload: Record<string, unknown>) {
    return this.client.post('/api/v1/video/room/join-by-id', payload);
  }

  /** POST /api/v1/video/room/join-by-id/confirm (after HMS connected). Bearer attached by interceptor. */
  async confirmVideoJoinById(payload: Record<string, unknown>) {
    return this.client.post('/api/v1/video/room/join-by-id/confirm', payload);
  }

  async sendMeetingHeartbeat(
    roomId: number,
    options?: { guestId?: string },
  ): Promise<ApiResponse> {
    try {
      const body = options?.guestId ? { guest_id: options.guestId } : {};
      const response = await this.client.post(`/api/v1/video/room/${roomId}/heartbeat`, body);
      return response.data;
    } catch (error: any) {
      console.error('Send meeting heartbeat failed:', error);
      // Don't throw - heartbeat failures shouldn't break the app
      return { success: false, message: error.response?.data?.message || 'Failed to send heartbeat' };
    }
  }

  /**
   * Leave a Reach meeting. Logged-in users use the mobile leave route; guests use web leave + guest_id.
   */
  async leaveReachMeeting(
    meetingId: string,
    options?: { roomId?: number; guestId?: string },
  ): Promise<void> {
    const trimmedId = meetingId.trim();
    if (options?.guestId && options.roomId) {
      await this.client.post(`/api/v1/video/room/${options.roomId}/leave`, {
        guest_id: options.guestId,
      });
      return;
    }
    await this.client.post(`/api/v1/mobile/meetings/${trimmedId}/leave`);
  }

  // ==================== MEETING ASSETS & WEBHOOKS ====================

  /** Fetch asset content by URL (same as web) – transcript/summary/report/chat. */
  async getVideoAssetContent(assetType: string, url: string): Promise<string> {
    const response = await this.client.get(MOBILE_ENDPOINTS.VIDEO_ASSET_CONTENT, {
      params: { asset_type: assetType, url },
      timeout: 30000,
    });
    const data = response.data as { success?: boolean; content?: string };
    if (data?.success && typeof data.content === 'string') return data.content;
    throw new Error(data?.content ?? 'Failed to load content');
  }

  /** Fetch file content by ID (same as web – /api/v1/web/files/:id/view). */
  async getWebFileContent(fileId: number): Promise<string> {
    const response = await this.client.get(MOBILE_ENDPOINTS.WEB_FILE_VIEW(fileId), {
      responseType: 'text',
      timeout: 30000,
    });
    return response.data as string;
  }

  async getMeetingAssets(): Promise<ApiResponse> {
    const now = Date.now();
    const userId = await currentCachedUserId();
    if (
      meetingAssetsCache &&
      meetingAssetsCache.userId === userId &&
      now - meetingAssetsCache.at < MEETING_ASSETS_CACHE_MS &&
      meetingAssetsCache.response?.success
    ) {
      console.log('📁 Meeting assets served from cache');
      return meetingAssetsCache.response;
    }
    try {
      console.log('📁 Loading meeting assets with local file paths...');
      const response = await this.client.get(MOBILE_ENDPOINTS.MEETING_ASSETS, {
        timeout: 30000 // 30s so second request (e.g. meeting-details) doesn't timeout when server is busy
      });
      console.log('📁 Meeting assets response:', response.data);
      const data = response.data as ApiResponse;
      if (data?.success) {
        meetingAssetsCache = { at: now, userId, response: data };
      }
      return data;
    } catch (error: any) {
      console.error('Get meeting assets failed:', error);
      // On timeout, return cached data if we have it (e.g. from list screen)
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        console.warn('⚠️ Meeting assets request timed out (non-critical)');
        if (
          meetingAssetsCache?.userId === userId &&
          meetingAssetsCache?.response?.success
        ) {
          console.log('📁 Returning cached meeting assets after timeout');
          return meetingAssetsCache.response;
        }
        return { success: false, data: null, message: 'Assets request timed out' };
      }
      throw new Error(error.response?.data?.message || 'Failed to fetch meeting assets');
    }
  }

  async deleteMeetingAssets(meetingId: string): Promise<ApiResponse> {
    try {
      meetingAssetsCache = null; // Invalidate cache so next fetch is fresh
      console.log('🗑️ Deleting all assets for meeting:', meetingId);
      const response = await this.client.delete(MOBILE_ENDPOINTS.MEETING_DELETE_ASSETS(meetingId));
      console.log('✅ Delete meeting assets response:', response.data);
      return response.data;
    } catch (error: any) {
      console.error('Delete meeting assets failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to delete meeting assets');
    }
  }

  async getMeetingTranscript(meetingId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.MEETING_TRANSCRIPT(meetingId));
      return response.data;
    } catch (error: any) {
      console.error('Get meeting transcript failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch meeting transcript');
    }
  }

  async getMeetingSummary(meetingId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.MEETING_SUMMARY(meetingId));
      return response.data;
    } catch (error: any) {
      console.error('Get meeting summary failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch meeting summary');
    }
  }

  async getMeetingChat(meetingId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.MEETING_CHAT(meetingId));
      return response.data;
    } catch (error: any) {
      console.error('Get meeting chat failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch meeting chat');
    }
  }

  async getMeetingReport(meetingId: string): Promise<ApiResponse> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.MEETING_REPORT(meetingId));
      return response.data;
    } catch (error: any) {
      console.error('Get meeting report failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch meeting report');
    }
  }

  /**
   * Public GrabDocs play link (same as web meeting-assets copy). Opens in browser without sign-in.
   */
  async createOrGetRecordingShareUrl(recordingId: number): Promise<string> {
    try {
      const response = await this.client.post(MOBILE_ENDPOINTS.VIDEO_RECORDING_SHARE(recordingId));
      const url = response.data?.share_url;
      if (url && typeof url === 'string') return url;
      throw new Error(response.data?.error || 'No share URL returned');
    } catch (error: any) {
      const msg =
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message ||
        'Failed to get recording share link';
      console.error('Recording share link failed:', error);
      throw new Error(msg);
    }
  }

  async downloadMeetingAsset(meetingId: string, assetType: string): Promise<{ url: string; filename: string }> {
    try {
      const response = await this.client.get(MOBILE_ENDPOINTS.MEETING_DOWNLOAD(meetingId, assetType));
      return {
        url: response.data.downloadUrl || response.data.url,
        filename: response.data.filename || `${meetingId}_${assetType}`
      };
    } catch (error: any) {
      console.error('Download meeting asset failed:', error);
      throw new Error(error.response?.data?.message || 'Failed to download meeting asset');
    }
  }

  // ==================== ERROR LOGGING ====================
  /**
   * Log error to database for debugging
   */
  async logError(error: {
    errorType: string;
    errorMessage: string;
    errorTraceback?: string;
    severity?: 'critical' | 'error' | 'warning';
    screenName?: string;
    userAction?: string;
    platform?: string;
    appVersion?: string;
    deviceInfo?: any;
  }): Promise<void> {
    try {
      const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
      await this.client.post(MOBILE_ENDPOINTS.ERROR_LOG, {
        errorType: error.errorType,
        errorMessage: error.errorMessage,
        errorTraceback: error.errorTraceback,
        severity: error.severity || 'error',
        screenName: error.screenName || 'DocumentViewer',
        userAction: error.userAction || 'view_file',
        platform: error.platform || platform,
        appVersion: Constants.expoConfig?.version || 'unknown',
        deviceInfo: error.deviceInfo || {
          platform: Platform.OS,
          version: Platform.Version
        }
      });
    } catch (logError: any) {
      // Don't throw - error logging should be non-blocking
      console.warn('Failed to log error to backend:', logError);
    }
  }

  // ==================== AI FILE MANAGER (web endpoints, Bearer auth) ====================

  async getAiFileManagerConfig() {
    const { getAiFileManagerConfig: fetch } = await import('./aiFileManagerApi');
    return fetch(this.client);
  }

  async postAiFileManagerPlan(body: import('../types/aiFileManager').PlanRequestBody) {
    const { postAiFileManagerPlan: post } = await import('./aiFileManagerApi');
    return post(this.client, body);
  }

  async postAiFileManagerExecute(body: import('../types/aiFileManager').ExecuteRequestBody) {
    const { postAiFileManagerExecute: post } = await import('./aiFileManagerApi');
    return post(this.client, body);
  }

  async postAiFileManagerSchedule(body: import('../types/aiFileManager').ScheduleRequestBody) {
    const { postAiFileManagerSchedule: post } = await import('./aiFileManagerApi');
    return post(this.client, body);
  }

  async getAiFileManagerHistory(limit = 50) {
    const { getAiFileManagerHistory: fetch } = await import('./aiFileManagerApi');
    return fetch(this.client, limit);
  }

  async abandonAiFileManagerHistory(historyId: number) {
    const { abandonAiFileManagerHistory: abandon } = await import('./aiFileManagerApi');
    return abandon(this.client, historyId);
  }

  async deleteAiFileManagerHistory(historyId: number) {
    const { deleteAiFileManagerHistory: del } = await import('./aiFileManagerApi');
    return del(this.client, historyId);
  }

  async undoAiFileManagerHistory(historyId: number) {
    const { undoAiFileManagerHistory: undo } = await import('./aiFileManagerApi');
    return undo(this.client, historyId);
  }

  async getAiFileManagerScheduled() {
    const { getAiFileManagerScheduled: fetch } = await import('./aiFileManagerApi');
    return fetch(this.client);
  }

  async patchAiFileManagerScheduled(id: number, status: 'active' | 'paused') {
    const { patchAiFileManagerScheduled: patch } = await import('./aiFileManagerApi');
    return patch(this.client, id, status);
  }

  async deleteAiFileManagerScheduled(id: number) {
    const { deleteAiFileManagerScheduled: del } = await import('./aiFileManagerApi');
    return del(this.client, id);
  }

  // ==================== CONFIGURATION ====================
  // Configuration endpoint not available on backend
}

// Create and export singleton instance
export const apiService = new ApiService();
export const apiClient = apiService; // For backward compatibility
export default apiService; 