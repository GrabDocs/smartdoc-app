/**
 * Limit error utilities for mobile app.
 * Matches backend format from limit_error_utils.py and mobile_routes.py.
 * Use to detect and display subscription limit errors (storage, tokens, meetings, etc.)
 */

export interface LimitErrorDetails {
  current_usage_mb?: number;
  limit_mb?: number;
  file_size_mb?: number;
  available_space_mb?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  tokens_used?: number;
  tokens_limit?: number;
  meetings_conducted?: number;
  max_meetings_per_month?: number;
  [key: string]: unknown;
}

export interface LimitErrorData {
  errorCode?: string;
  message: string;
  limitType?: string;
  details?: LimitErrorDetails;
  actionUrl?: string;
}

const LIMIT_ERROR_CODES = [
  'storage_limit_exceeded',
  'insufficient_tokens',
  'extra_credits_capped',
  'meeting_limit_exceeded',
  'workspace_limit_exceeded',
  'workspace_member_limit_exceeded',
  'monthly_token_limit_exceeded',
  'token_limit_exceeded',
  'participant_limit_exceeded',
] as const;

function isLimitCode(value: string): boolean {
  return LIMIT_ERROR_CODES.includes(value as (typeof LIMIT_ERROR_CODES)[number]);
}

function matchedLimitCode(d: Record<string, unknown>): string | undefined {
  for (const key of ['error_code', 'code', 'error', 'message'] as const) {
    const value = d[key];
    if (typeof value === 'string' && isLimitCode(value)) return value;
  }
  return undefined;
}

function readableLimitText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || isLimitCode(text) || /^[a-z0-9_]+$/.test(text)) return null;
  return text;
}

function limitMessage(d: Record<string, unknown>): string {
  return readableLimitText(d.message) || readableLimitText(d.error) || 'A subscription limit has been reached.';
}

/**
 * Check if API response data indicates a subscription/limit error.
 * Email draft failures put the code in `code` and the sentence in `error`.
 */
export function isLimitErrorResponse(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.upgrade_required === true || d.add_credits_required === true || d.token_limit_exceeded === true) return true;
  return matchedLimitCode(d) != null;
}

/**
 * Extract limit error data from API response for use with showLimitError
 */
export function extractLimitErrorData(data: unknown): LimitErrorData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (!isLimitErrorResponse(data)) return null;
  const nested = (d.usage_info ?? d.details) as Record<string, unknown> | undefined;
  const nestedCode =
    nested && typeof nested === 'object' ? matchedLimitCode(nested) : undefined;
  const errorCode =
    (nestedCode === 'extra_credits_capped' ? nestedCode : undefined) ??
    matchedLimitCode(d) ??
    (d.token_limit_exceeded === true ? 'insufficient_tokens' : undefined) ??
    (typeof d.error_code === 'string' ? d.error_code : undefined);
  let limitType = (d.limit_type ?? d.limitType) as string | undefined;
  if (
    !limitType &&
    (errorCode === 'insufficient_tokens' ||
      errorCode === 'monthly_token_limit_exceeded' ||
      errorCode === 'token_limit_exceeded' ||
      errorCode === 'extra_credits_capped')
  ) {
    limitType = 'tokens';
  }
  if (
    !limitType &&
    (errorCode === 'meeting_limit_exceeded' || errorCode === 'participant_limit_exceeded')
  ) {
    limitType = 'meetings';
  }
  const details = (d.details ?? d.usage_info ?? d.member_info) as LimitErrorDetails | undefined;
  const actionUrl = (d.action_url ?? d.actionUrl) as string | undefined;
  return {
    errorCode,
    message: limitMessage(d),
    limitType,
    details,
    actionUrl,
  };
}

/**
 * Limit payload from a caught request. Also accepts a 429 whose body
 * describes a credit or token limit but has no standard error code.
 */
export function limitErrorFromCaught(error: unknown): LimitErrorData | null {
  const data = getErrorResponseData(error);
  const extracted = extractLimitErrorData(data);
  if (extracted) return extracted;
  if (!data) return null;
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status !== 429) return null;
  const raw = data.message ?? data.error;
  if (typeof raw !== 'string') return null;
  const lower = raw.toLowerCase();
  if (!lower.includes('credit') && !lower.includes('token')) return null;
  return {
    errorCode: 'monthly_token_limit_exceeded',
    message: raw,
    limitType: 'tokens',
  };
}

/**
 * Get response data from a caught error (axios or custom)
 */
export function getErrorResponseData(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  // Axios: error.response.data
  const axiosData = (e.response as Record<string, unknown>)?.data;
  if (axiosData && typeof axiosData === 'object') {
    return axiosData as Record<string, unknown>;
  }
  // Custom: error.responseData (when we attach it)
  const customData = e.responseData;
  if (customData && typeof customData === 'object') {
    return customData as Record<string, unknown>;
  }
  return null;
}
