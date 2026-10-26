import { apiClient } from './api';

const client = () => apiClient.client;

export const STRIPE_PORTAL_RETURN_URL = 'grabdocs://billing';

export const PLAN_CHANGE_KEYS = ['starter', 'pro', 'premium'] as const;
export const PLAN_CHANGE_CYCLES = ['monthly', 'yearly'] as const;

export type PlanChangeKey = (typeof PLAN_CHANGE_KEYS)[number];
export type PlanChangeCycle = (typeof PLAN_CHANGE_CYCLES)[number];

export type ExtraAiCreditsInfo = {
  in_extra_credits?: boolean;
  used?: number;
  tokens_overage?: number;
  next_bill_cents?: number;
  overage_amount_cents?: number;
  rate?: number;
  can_add_credits?: boolean;
  remaining_included?: number | null;
};

export type UsageMetric = {
  used?: number;
  limit?: number;
  tokens_top_up?: number;
};

export type MemberBreakdownRow = {
  user_id?: number;
  display_name?: string;
  name?: string;
  email?: string;
  username?: string;
  tokens_used?: number;
  credits_used?: number;
};

export type SettingsUsageStatsResponse = {
  success?: boolean;
  period?: string;
  start_date?: string;
  end_date?: string;
  next_reset_date?: string;
  plan_name?: string;
  plan_display_name?: string;
  subscription_active?: boolean;
  next_plan_display_name?: string | null;
  next_plan_name?: string | null;
  usage_stats?: {
    ai_tokens?: UsageMetric;
    file_storage?: UsageMetric;
    meetings?: UsageMetric;
    meeting_minutes?: UsageMetric;
    transcription?: UsageMetric;
    workspaces?: UsageMetric;
    documents_extracted?: UsageMetric;
  };
  is_company_usage?: boolean;
  company_id?: number;
  entitlement_source?: string;
  member_breakdown?: MemberBreakdownRow[];
  billing_status?: string | null;
  billing_reason?: string | null;
  billing_admin_email?: string | null;
  billing_status_message?: string | null;
  is_billing_admin?: boolean;
  can_manage_billing?: boolean;
  extra_ai_credits?: ExtraAiCreditsInfo | null;
  billing_cycle?: PlanChangeCycle;
  can_undo_cancel?: boolean;
  can_undo_downgrade?: boolean;
  billing_period_start?: string | null;
  debug_info?: { user_id?: number };
  subscription?: {
    plan?: { display_name?: string };
    is_active?: boolean;
    expires_at?: string | null;
    canceled_at?: string | null;
  };
  error?: string;
};

export type TopupPack = {
  pack_id: string;
  tokens: number;
};

export type BillingInvoice = {
  id?: string | number;
  date?: string;
  description?: string;
  status?: string;
  stripe_status?: string;
  amount?: number;
  currency?: string;
  invoice_url?: string;
  invoice_pdf_url?: string;
  can_pay?: boolean;
  type?: string;
};

function apiErrorMessage(error: any, fallback: string): string {
  return (
    error?.response?.data?.error ||
    error?.response?.data?.message ||
    error?.message ||
    fallback
  );
}

export async function getSettingsUsageStats(period = 'month'): Promise<SettingsUsageStatsResponse> {
  try {
    const { data } = await client().get<SettingsUsageStatsResponse>(
      `/api/subscription/settings-usage-stats`,
      { params: { period } },
    );
    return data;
  } catch (error: any) {
    throw new Error(apiErrorMessage(error, 'Failed to load usage stats'));
  }
}

export async function getMyPlan(): Promise<any> {
  try {
    const { data } = await client().get('/api/subscription/my-plan');
    return data;
  } catch (error: any) {
    throw new Error(apiErrorMessage(error, 'Failed to load plan'));
  }
}

export async function getTopupPacks(): Promise<TopupPack[]> {
  try {
    const { data } = await client().get('/api/subscription/topup-packs');
    return Array.isArray(data?.packs) ? data.packs : [];
  } catch (error: any) {
    throw new Error(apiErrorMessage(error, 'Failed to load credit packs'));
  }
}

export async function createTopupIntent(packId: string): Promise<{ intent_id?: string; redirect_url?: string }> {
  try {
    const { data } = await client().post('/api/subscription/topup-intents', { pack_id: packId });
    return data;
  } catch (error: any) {
    throw new Error(apiErrorMessage(error, 'Failed to start top-up'));
  }
}

export type PlanChangeIntentOptions = {
  source?: 'billing' | 'undo_cancel' | 'undo_downgrade';
  reason?: 'credits_exhausted';
};

/** Create the website payment row at tap time. Server derives action. */
export async function createPlanChangeIntent(
  planKey: PlanChangeKey,
  billingCycle: PlanChangeCycle,
  options?: PlanChangeIntentOptions,
): Promise<{ intent_id?: string; redirect_url?: string; action?: string }> {
  try {
    const { data } = await client().post('/api/subscription/plan-change-intents', {
      plan_key: planKey,
      billing_cycle: billingCycle,
      source: options?.source || 'billing',
      ...(options?.reason ? { reason: options.reason } : {}),
    });
    return data;
  } catch (error: any) {
    throw new Error(apiErrorMessage(error, 'Could not start checkout'));
  }
}

export async function getBillingInvoices(month?: string): Promise<BillingInvoice[]> {
  try {
    const { data } = await client().get('/api/subscription/invoices', {
      params: month ? { month } : undefined,
    });
    return data?.success && Array.isArray(data.invoices) ? data.invoices : [];
  } catch (error: any) {
    throw new Error(apiErrorMessage(error, 'Failed to load invoices'));
  }
}

export async function openStripePortal(
  returnUrl: string = STRIPE_PORTAL_RETURN_URL,
): Promise<{ url?: string }> {
  try {
    const { data } = await client().post('/api/subscription/stripe-portal', {
      return_url: returnUrl,
    });
    return data;
  } catch (error: any) {
    throw new Error(apiErrorMessage(error, 'Could not open billing portal'));
  }
}

export async function cancelSubscription(): Promise<{
  success?: boolean;
  message?: string;
  access_until?: string;
  error?: string;
}> {
  try {
    const { data } = await client().post('/api/subscription/cancel');
    return data;
  } catch (error: any) {
    throw new Error(apiErrorMessage(error, 'Failed to cancel subscription'));
  }
}

export async function syncSubscription(): Promise<{ success?: boolean; synced?: boolean }> {
  try {
    const { data } = await client().post('/api/subscription/sync');
    return data;
  } catch (error: any) {
    throw new Error(apiErrorMessage(error, 'Failed to sync subscription'));
  }
}

/** Sync until billing_cycle_start advances. Page return is not a credit reset. */
export async function waitForBillingCycleSync(
  previousPeriodStart?: string | null,
  attempts = 6,
  delayMs = 1000,
): Promise<SettingsUsageStatsResponse | null> {
  let last: SettingsUsageStatsResponse | null = null;
  for (let i = 0; i < attempts; i++) {
    await syncSubscription().catch(() => null);
    try {
      last = await getSettingsUsageStats('month');
    } catch {
      last = null;
    }
    const next = last?.billing_period_start || null;
    // Only a known previous period advancing counts as rotation.
    // Missing periodBefore must not treat any existing billing_period_start as done.
    if (previousPeriodStart && next && next !== previousPeriodStart) {
      return last;
    }
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return last;
}

export function topupPackPriceUsd(packId: string): number | null {
  if (packId === 'starter_pack') return 7;
  if (packId === 'growth_pack') return 25;
  if (packId === 'enterprise_pack') return 75;
  return null;
}

export function formatCreditsLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return tokens.toLocaleString();
}

export function usagePercent(used: number, limit: number): number {
  if (limit === -1 || limit <= 0) return 0;
  return (used / limit) * 100;
}

export function barColorForPercent(pct: number, base: string): string {
  if (pct > 80) return '#DC2626';
  if (pct > 60) return '#CA8A04';
  return base;
}
