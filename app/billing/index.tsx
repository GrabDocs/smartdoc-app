import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  barColorForPercent,
  cancelSubscription,
  createTopupIntent,
  formatCreditsLabel,
  getBillingInvoices,
  getSettingsUsageStats,
  getTopupPacks,
  openStripePortal,
  PRICING_URL,
  STRIPE_PORTAL_RETURN_URL,
  syncSubscription,
  topupPackPriceUsd,
  usagePercent,
  type BillingInvoice,
  type ExtraAiCreditsInfo,
  type SettingsUsageStatsResponse,
  type TopupPack,
} from '../../services/subscriptionApi';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import ExtraAiCreditsBanner from '../../components/ExtraAiCreditsBanner';

type Segment = 'usage' | 'billing';

type TransformedUsage = {
  planName: string;
  planDisplayName: string;
  nextResetDate?: string;
  subscriptionActive: boolean;
  nextPlanDisplayName?: string | null;
  isCompanyUsage: boolean;
  canManageBilling: boolean;
  isBillingAdmin: boolean;
  billingStatus?: string | null;
  billingAdminEmail?: string | null;
  billingStatusMessage?: string | null;
  memberBreakdown: NonNullable<SettingsUsageStatsResponse['member_breakdown']>;
  extraAi: ExtraAiCreditsInfo | null;
  subscription?: SettingsUsageStatsResponse['subscription'];
  metrics: {
    key: string;
    title: string;
    subtitle: string;
    used: number;
    limit: number;
    unit: string;
    baseColor: string;
    showBar: boolean;
    formatUsed?: (n: number) => string;
    formatLimit?: (n: number) => string;
  }[];
};

function transformStats(data: SettingsUsageStatsResponse): TransformedUsage {
  const stats = data.usage_stats || {};
  const ai = stats.ai_tokens || {};
  const storage = stats.file_storage || {};
  const meetings = stats.meetings || {};
  const meetingMinutes = stats.meeting_minutes || {};
  const transcription = stats.transcription || {};
  const workspaces = stats.workspaces || {};
  const docs = stats.documents_extracted || {};

  return {
    planName: (data.plan_name || 'free').toLowerCase(),
    planDisplayName: data.plan_display_name || data.subscription?.plan?.display_name || 'Free Plan',
    nextResetDate: data.next_reset_date || data.end_date,
    subscriptionActive: !!data.subscription_active,
    nextPlanDisplayName: data.next_plan_display_name,
    isCompanyUsage: !!data.is_company_usage,
    canManageBilling: data.can_manage_billing !== false,
    isBillingAdmin: !!data.is_billing_admin,
    billingStatus: data.billing_status,
    billingAdminEmail: data.billing_admin_email,
    billingStatusMessage: data.billing_status_message,
    memberBreakdown: Array.isArray(data.member_breakdown) ? data.member_breakdown : [],
    extraAi: data.extra_ai_credits || null,
    subscription: data.subscription
      ? {
          ...data.subscription,
          plan: { display_name: data.plan_display_name || data.subscription.plan?.display_name },
          is_active: data.subscription.is_active ?? data.subscription_active,
        }
      : {
          plan: { display_name: data.plan_display_name || 'Free Plan' },
          is_active: !!data.subscription_active,
          expires_at: null,
          canceled_at: null,
        },
    metrics: [
      {
        key: 'ai',
        title: 'AI Credit',
        subtitle: data.is_company_usage ? 'Company-wide monthly credits' : 'Monthly credit usage',
        used: ai.used || 0,
        limit: ai.limit ?? 5000,
        unit: 'credits',
        baseColor: '#9333EA',
        showBar: true,
      },
      {
        key: 'storage',
        title: 'File Storage',
        subtitle: 'Storage usage',
        used: storage.used || 0,
        limit: storage.limit ?? 100,
        unit: 'MB',
        baseColor: '#2563EB',
        showBar: true,
        formatUsed: (n) => `${Number(n).toFixed(2)} MB`,
        formatLimit: (n) => (n === -1 ? 'Unlimited' : `${Math.round(n)} MB`),
      },
      {
        key: 'meetings',
        title: 'Meetings',
        subtitle: 'Video meetings this month',
        used: meetings.used || 0,
        limit: meetings.limit ?? 3,
        unit: '',
        baseColor: '#16A34A',
        showBar: true,
      },
      {
        key: 'meeting_minutes',
        title: 'Meeting minutes',
        subtitle: 'Max duration / minutes used',
        used: meetingMinutes.used || 0,
        limit: meetingMinutes.limit ?? -1,
        unit: 'min',
        baseColor: '#0D9488',
        showBar: false,
      },
      {
        key: 'transcription',
        title: 'Transcription',
        subtitle: 'Transcription minutes',
        used: transcription.used || 0,
        limit: transcription.limit ?? 30,
        unit: 'min',
        baseColor: '#CA8A04',
        showBar: true,
      },
      {
        key: 'workspaces',
        title: 'Workspaces',
        subtitle: 'Workspace count',
        used: workspaces.used || 0,
        limit: workspaces.limit ?? 2,
        unit: '',
        baseColor: '#EA580C',
        showBar: true,
      },
      {
        key: 'documents',
        title: 'Documents extracted',
        subtitle: 'AI document extractions this month',
        used: docs.used || 0,
        limit: docs.limit ?? -1,
        unit: '',
        baseColor: '#0891B2',
        showBar: true,
      },
    ],
  };
}

function invoiceMonthOptions(): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [{ value: '', label: 'All time' }];
  for (let i = 0; i < 12; i++) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    opts.push({
      value: `${y}-${m}`,
      label: d.toLocaleString('default', { month: 'long', year: 'numeric' }),
    });
  }
  return opts;
}

export default function BillingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ topup_success?: string; tab?: string }>();
  const { user } = useAuth();
  const colors = useThemeColors();

  const [segment, setSegment] = useState<Segment>(
    params.tab === 'billing' ? 'billing' : 'usage',
  );

  React.useEffect(() => {
    if (params.tab === 'billing' || params.tab === 'usage') {
      setSegment(params.tab);
    }
  }, [params.tab]);
  const [usage, setUsage] = useState<TransformedUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [packs, setPacks] = useState<TopupPack[]>([]);
  const [packsLoading, setPacksLoading] = useState(false);
  const [topupBusy, setTopupBusy] = useState<string | null>(null);

  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesMonth, setInvoicesMonth] = useState('');
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);

  const [portalLoading, setPortalLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);

  const pendingSyncRef = useRef(false);
  const isAdmin = !!(user as any)?.is_admin || !!(user as any)?.is_system_admin;

  const canViewUsage = useMemo(() => {
    if (!usage) return true;
    if (!usage.isCompanyUsage) return true;
    if (usage.isBillingAdmin) return true;
    if (isAdmin) return true;
    return false;
  }, [usage, isAdmin]);

  const loadUsage = useCallback(async () => {
    try {
      setError(null);
      const data = await getSettingsUsageStats('month');
      if (data?.success === false && data?.error) {
        throw new Error(data.error);
      }
      setUsage(transformStats(data));
      setLastUpdated(new Date());
    } catch (e: any) {
      setError(e?.message || 'Failed to load usage data');
    } finally {
      setUsageLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadBillingExtras = useCallback(async () => {
    setPacksLoading(true);
    setInvoicesLoading(true);
    try {
      const [p, inv] = await Promise.all([
        getTopupPacks().catch(() => [] as TopupPack[]),
        getBillingInvoices(invoicesMonth || undefined).catch(() => [] as BillingInvoice[]),
      ]);
      setPacks(p);
      setInvoices(inv);
    } finally {
      setPacksLoading(false);
      setInvoicesLoading(false);
    }
  }, [invoicesMonth]);

  const syncAndReload = useCallback(async () => {
    try {
      await syncSubscription().catch(() => null);
    } finally {
      pendingSyncRef.current = false;
      await Promise.all([loadUsage(), loadBillingExtras()]);
    }
  }, [loadUsage, loadBillingExtras]);

  const markPendingExternalCheckout = useCallback(() => {
    pendingSyncRef.current = true;
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        if (params.topup_success === '1' || pendingSyncRef.current) {
          setUsageLoading(true);
          await syncAndReload();
          return;
        }
        if (!cancelled) {
          setUsageLoading(true);
          await loadUsage();
          if (segment === 'billing') await loadBillingExtras();
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [loadUsage, loadBillingExtras, segment, params.topup_success, syncAndReload]),
  );

  React.useEffect(() => {
    if (segment === 'billing') {
      loadBillingExtras();
    }
  }, [segment, invoicesMonth, loadBillingExtras]);

  React.useEffect(() => {
    if (canViewUsage === false && segment === 'usage') {
      setSegment('billing');
    }
  }, [canViewUsage, segment]);

  React.useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'active' && pendingSyncRef.current) {
        syncAndReload();
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [syncAndReload]);

  React.useEffect(() => {
    const handleUrl = ({ url }: { url: string }) => {
      if (!url) return;
      if (url.startsWith('grabdocs://billing') || url.includes('/billing')) {
        pendingSyncRef.current = true;
        syncAndReload();
      }
    };
    const sub = Linking.addEventListener('url', handleUrl);
    Linking.getInitialURL().then((url) => {
      if (url) handleUrl({ url });
    });
    return () => sub.remove();
  }, [syncAndReload]);

  const onRefresh = async () => {
    setRefreshing(true);
    await syncAndReload();
  };

  const openPricing = () => {
    markPendingExternalCheckout();
    Linking.openURL(PRICING_URL).catch(() => {});
  };

  const handlePortal = async () => {
    setPortalLoading(true);
    try {
      markPendingExternalCheckout();
      const { url } = await openStripePortal(STRIPE_PORTAL_RETURN_URL);
      if (!url) {
        Alert.alert('Billing', 'Could not open billing portal');
        return;
      }
      await WebBrowser.openBrowserAsync(url);
      await syncAndReload();
    } catch (e: any) {
      Alert.alert('Billing', e?.message || 'Could not open billing portal');
    } finally {
      setPortalLoading(false);
    }
  };

  const handleCancel = () => {
    const until = usage?.subscription?.expires_at
      ? new Date(usage.subscription.expires_at).toLocaleDateString()
      : 'end of billing period';
    Alert.alert(
      'Cancel subscription?',
      `You will lose access to premium features at the end of your current billing period.\n\nAccess continues until: ${until}`,
      [
        { text: 'Keep subscription', style: 'cancel' },
        {
          text: 'Cancel anyway',
          style: 'destructive',
          onPress: async () => {
            setCancelLoading(true);
            try {
              const res = await cancelSubscription();
              if (res.success === false) {
                Alert.alert('Error', res.error || 'Failed to cancel subscription');
              } else {
                Alert.alert(
                  'Subscription cancelled',
                  res.message || 'Subscription will end at the close of the billing period.',
                );
                await loadUsage();
              }
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Failed to cancel subscription');
            } finally {
              setCancelLoading(false);
            }
          },
        },
      ],
    );
  };

  const handleBuyTopup = async (packId: string) => {
    setTopupBusy(packId);
    try {
      markPendingExternalCheckout();
      const res = await createTopupIntent(packId);
      if (!res.redirect_url) {
        Alert.alert('Top-up', 'Could not start checkout');
        return;
      }
      await WebBrowser.openBrowserAsync(res.redirect_url);
      await syncAndReload();
    } catch (e: any) {
      Alert.alert('Top-up', e?.message || 'Failed to start top-up');
    } finally {
      setTopupBusy(null);
    }
  };

  const handleBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/settings' as any);
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 4,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          backgroundColor: colors.headerBackground,
        },
        headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
        headerTitle: {
          flex: 1,
          textAlign: 'left',
          fontSize: 17,
          fontWeight: '600',
          color: colors.text,
        },
        segments: {
          flexDirection: 'row',
          margin: 16,
          padding: 4,
          borderRadius: 10,
          backgroundColor: colors.surface,
        },
        segmentBtn: {
          flex: 1,
          paddingVertical: 8,
          borderRadius: 8,
          alignItems: 'center',
        },
        segmentActive: { backgroundColor: colors.card },
        segmentText: { fontSize: 14, fontWeight: '500', color: colors.textSecondary },
        segmentTextActive: { color: colors.text, fontWeight: '600' },
        content: { paddingHorizontal: 16, paddingBottom: 40 },
        card: {
          backgroundColor: colors.card,
          borderRadius: 12,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          padding: 16,
          marginBottom: 12,
        },
        banner: {
          borderRadius: 12,
          borderWidth: 1,
          borderColor: '#F59E0B',
          backgroundColor: colors.isDark ? 'rgba(245,158,11,0.15)' : '#FFFBEB',
          padding: 14,
          marginBottom: 12,
        },
        bannerBlue: {
          borderRadius: 12,
          borderWidth: 1,
          borderColor: '#3B82F6',
          backgroundColor: colors.isDark ? 'rgba(59,130,246,0.15)' : '#EFF6FF',
          padding: 14,
          marginBottom: 12,
        },
        title: { fontSize: 18, fontWeight: '600', color: colors.text, marginBottom: 4 },
        subtitle: { fontSize: 13, color: colors.textSecondary, marginBottom: 8 },
        rowBetween: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        },
        metricTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
        metricSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
        barTrack: {
          height: 8,
          borderRadius: 4,
          backgroundColor: colors.border,
          overflow: 'hidden',
          marginTop: 8,
        },
        barFill: { height: 8, borderRadius: 4 },
        primaryBtn: {
          backgroundColor: '#2563EB',
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: 8,
          alignSelf: 'flex-start',
          marginTop: 8,
        },
        primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
        linkBtn: { paddingVertical: 8 },
        linkText: { color: '#2563EB', fontSize: 14, fontWeight: '500' },
        dangerLink: { color: colors.textSecondary, fontSize: 13, textDecorationLine: 'underline' },
        packRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        buyBtn: {
          backgroundColor: '#2563EB',
          minWidth: 72,
          height: 32,
          borderRadius: 8,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 12,
        },
        buyBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
        invoiceRow: {
          paddingVertical: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        empty: { color: colors.textSecondary, fontSize: 14, marginTop: 8 },
        memberRow: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingVertical: 8,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        chip: {
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border,
          marginRight: 8,
          marginBottom: 8,
        },
        chipActive: { borderColor: '#2563EB', backgroundColor: colors.isDark ? 'rgba(37,99,235,0.2)' : '#EFF6FF' },
      }),
    [colors],
  );

  const renderMetric = (m: TransformedUsage['metrics'][0]) => {
    const pct = usagePercent(m.used, m.limit);
    const usedLabel = m.formatUsed ? m.formatUsed(m.used) : `${m.used.toLocaleString()}${m.unit ? ` ${m.unit}` : ''}`;
    const limitLabel =
      m.limit === -1
        ? 'Unlimited'
        : m.formatLimit
          ? m.formatLimit(m.limit)
          : `${m.limit.toLocaleString()}${m.unit ? ` ${m.unit}` : ''}`;
    return (
      <View key={m.key} style={styles.card}>
        <Text style={styles.metricTitle}>{m.title}</Text>
        <Text style={styles.metricSub}>{m.subtitle}</Text>
        <View style={styles.rowBetween}>
          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Used</Text>
          <Text style={{ color: colors.text, fontSize: 13 }}>
            {usedLabel} / {limitLabel}
          </Text>
        </View>
        {m.showBar && m.limit !== -1 && (
          <>
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.barFill,
                  {
                    width: `${Math.min(pct, 100)}%`,
                    backgroundColor: barColorForPercent(pct, m.baseColor),
                  },
                ]}
              />
            </View>
            <Text style={[styles.metricSub, { marginTop: 6 }]}>
              {Math.max(0, m.limit - m.used).toLocaleString()} remaining
            </Text>
          </>
        )}
      </View>
    );
  };

  const renderUsage = () => {
    if (usageLoading && !usage) {
      return (
        <View style={{ padding: 40, alignItems: 'center' }}>
          <ActivityIndicator color="#2563EB" />
          <Text style={[styles.empty, { marginTop: 12 }]}>Loading usage data...</Text>
        </View>
      );
    }
    if (!canViewUsage) {
      return (
        <View style={styles.banner}>
          <Text style={{ color: colors.text, fontSize: 14 }}>
            Usage details are available to company administrators.
          </Text>
        </View>
      );
    }
    if (error && !usage) {
      return (
        <View style={styles.card}>
          <Text style={{ color: '#DC2626', marginBottom: 8 }}>{error}</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={loadUsage}>
            <Text style={styles.primaryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (!usage) return <Text style={styles.empty}>No usage data available.</Text>;

    const sub = usage.subscription;
    const statusLabel =
      sub?.canceled_at && sub?.expires_at
        ? `Cancelled — access until ${new Date(sub.expires_at).toLocaleDateString()}`
        : sub?.is_active
          ? 'Active'
          : 'Inactive';

    return (
      <>
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={styles.title}>
                {usage.isCompanyUsage ? 'Company plan: ' : ''}
                {usage.planDisplayName}
              </Text>
              <Text style={styles.subtitle}>{statusLabel}</Text>
              {usage.nextResetDate ? (
                <Text style={styles.subtitle}>
                  Next reset: {new Date(usage.nextResetDate).toLocaleDateString()}
                </Text>
              ) : null}
              {lastUpdated ? (
                <Text style={[styles.subtitle, { fontSize: 11 }]}>
                  Last updated: {lastUpdated.toLocaleTimeString()}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={onRefresh} disabled={usageLoading || refreshing}>
              <Ionicons
                name="refresh"
                size={22}
                color={usageLoading || refreshing ? colors.textSecondary : '#2563EB'}
              />
            </TouchableOpacity>
          </View>
          {usage.isCompanyUsage ? (
            <Text style={[styles.subtitle, { marginBottom: 0 }]}>
              Shared AI credits across all company members
            </Text>
          ) : null}
        </View>

        <ExtraAiCreditsBanner
          extraAi={usage.extraAi}
          canManageBilling={usage.canManageBilling}
          billingAdminEmail={usage.billingAdminEmail}
          persistent
          userId={user?.id}
        />

        {usage.metrics.map(renderMetric)}

        {usage.isCompanyUsage && usage.memberBreakdown.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.title}>Member breakdown</Text>
            <Text style={styles.subtitle}>Credits used by company members</Text>
            {usage.memberBreakdown.map((row, idx) => {
              const name = row.display_name || row.name || row.username || 'Member';
              const credits = row.credits_used ?? row.tokens_used ?? 0;
              return (
                <View key={`${row.user_id ?? idx}`} style={styles.memberRow}>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <Text style={{ color: colors.text, fontSize: 14 }}>{name}</Text>
                    {row.email ? (
                      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{row.email}</Text>
                    ) : null}
                  </View>
                  <Text style={{ color: colors.text, fontSize: 14 }}>{credits.toLocaleString()}</Text>
                </View>
              );
            })}
          </View>
        ) : null}
      </>
    );
  };

  const renderBilling = () => {
    if (usageLoading && !usage) {
      return (
        <View style={{ padding: 40, alignItems: 'center' }}>
          <ActivityIndicator color="#2563EB" />
        </View>
      );
    }

    const canManage = usage?.canManageBilling !== false;
    const planName = usage?.planName || 'free';

    return (
      <>
        {usage?.isCompanyUsage && !canManage ? (
          <View style={styles.banner}>
            <Text style={{ color: colors.text, fontSize: 14 }}>
              {usage.billingStatusMessage ||
                (usage.billingAdminEmail
                  ? `Billing is managed by ${usage.billingAdminEmail}. Contact your billing administrator to subscribe or add credits.`
                  : 'Company billing is managed by your billing administrator.')}
            </Text>
          </View>
        ) : null}

        {usage?.isCompanyUsage &&
        canManage &&
        usage.billingStatus === 'INACTIVE' &&
        usage.billingStatusMessage ? (
          <View style={styles.banner}>
            <Text style={{ color: colors.text, fontSize: 14 }}>{usage.billingStatusMessage}</Text>
          </View>
        ) : null}

        {canManage && planName === 'free' ? (
          <View style={styles.bannerBlue}>
            <Text style={{ color: colors.text, fontSize: 14, marginBottom: 4 }}>
              Upgrade to a paid plan to add credits, unlock more features, and get more AI usage.
            </Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={openPricing}>
              <Text style={styles.primaryBtnText}>Subscribe</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {canManage && planName !== 'free' && usage?.nextPlanDisplayName ? (
          <View style={styles.bannerBlue}>
            <Text style={{ color: colors.text, fontSize: 14, marginBottom: 4 }}>
              Get more features and higher limits by upgrading to {usage.nextPlanDisplayName}.
            </Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={openPricing}>
              <Text style={styles.primaryBtnText}>Upgrade to {usage.nextPlanDisplayName}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {canManage ? (
          <View style={styles.card}>
            <TouchableOpacity style={styles.linkBtn} onPress={handlePortal} disabled={portalLoading}>
              <Text style={styles.linkText}>
                {portalLoading ? 'Opening Stripe…' : 'Manage subscription in Stripe'}
              </Text>
            </TouchableOpacity>
            <Text style={styles.subtitle}>Cancel, update payment method, or view billing history.</Text>
            {usage?.subscription?.is_active &&
            !usage?.subscription?.canceled_at &&
            planName !== 'free' ? (
              <TouchableOpacity onPress={handleCancel} disabled={cancelLoading} style={{ marginTop: 4 }}>
                <Text style={styles.dangerLink}>
                  {cancelLoading ? 'Cancelling…' : 'Cancel subscription'}
                </Text>
              </TouchableOpacity>
            ) : null}
            {usage?.subscription?.canceled_at && usage?.subscription?.expires_at ? (
              <Text style={{ color: '#D97706', fontSize: 12, marginTop: 8 }}>
                Cancelled — access until {new Date(usage.subscription.expires_at).toLocaleDateString()}.{' '}
                <Text style={{ textDecorationLine: 'underline' }} onPress={() => Linking.openURL('https://grabdocs.com')}>
                  Reactivate on website
                </Text>
              </Text>
            ) : null}
          </View>
        ) : null}

        {canManage ? (
          <View style={styles.card}>
            <Text style={styles.title}>Add credits</Text>
            <Text style={styles.subtitle}>
              Buy extra AI credits. Available on paid plans only; top-up tokens expire if your subscription
              expires without a renewal in place.
            </Text>
            {packsLoading ? (
              <ActivityIndicator color="#2563EB" />
            ) : packs.length === 0 ? (
              <Text style={styles.empty}>No credit packs available right now.</Text>
            ) : (
              packs.map((pack) => {
                const label = pack.pack_id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
                const price = topupPackPriceUsd(pack.pack_id);
                return (
                  <View key={pack.pack_id} style={styles.packRow}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text style={{ color: colors.text, fontWeight: '600' }}>{label}</Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                        {formatCreditsLabel(pack.tokens || 0)} credits
                        {price != null ? ` · $${price}` : ''}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.buyBtn}
                      disabled={!!topupBusy}
                      onPress={() => handleBuyTopup(pack.pack_id)}
                    >
                      {topupBusy === pack.pack_id ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.buyBtnText}>Buy</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                );
              })
            )}
          </View>
        ) : null}

        {canManage ? (
          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>Invoices</Text>
                <Text style={styles.subtitle}>View and download your billing receipts.</Text>
              </View>
              <TouchableOpacity onPress={onRefresh} disabled={refreshing || invoicesLoading}>
                <Ionicons name="refresh" size={22} color="#2563EB" />
              </TouchableOpacity>
            </View>

            <Text style={[styles.subtitle, { marginBottom: 4 }]}>Month</Text>
            <TouchableOpacity
              style={[styles.chip, monthPickerOpen && styles.chipActive, { alignSelf: 'flex-start' }]}
              onPress={() => setMonthPickerOpen((v) => !v)}
            >
              <Text style={{ color: colors.text, fontSize: 13 }}>
                {invoiceMonthOptions().find((o) => o.value === invoicesMonth)?.label || 'All time'}
              </Text>
            </TouchableOpacity>
            {monthPickerOpen ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 }}>
                {invoiceMonthOptions().map((opt) => (
                  <TouchableOpacity
                    key={opt.value || 'all'}
                    style={[styles.chip, invoicesMonth === opt.value && styles.chipActive]}
                    onPress={() => {
                      setInvoicesMonth(opt.value);
                      setMonthPickerOpen(false);
                    }}
                  >
                    <Text style={{ color: colors.text, fontSize: 12 }}>{opt.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}

            {invoicesLoading ? (
              <ActivityIndicator color="#2563EB" />
            ) : invoices.length === 0 ? (
              <Text style={styles.empty}>No invoices for this period.</Text>
            ) : (
              invoices.map((inv, idx) => {
                const statusKey = (inv.stripe_status || inv.status || '').toLowerCase();
                const statusColor =
                  statusKey === 'paid'
                    ? '#15803D'
                    : statusKey === 'open' || inv.status === 'Unpaid'
                      ? '#B45309'
                      : statusKey === 'uncollectible'
                        ? '#B91C1C'
                        : colors.textSecondary;
                return (
                  <View key={`${inv.id ?? idx}`} style={styles.invoiceRow}>
                    <Text style={{ color: colors.text, fontWeight: '500' }}>{inv.date || '—'}</Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 2 }}>
                      {inv.description || '—'}
                    </Text>
                    <View style={[styles.rowBetween, { marginTop: 6, marginBottom: 0 }]}>
                      <Text style={{ color: statusColor, fontSize: 13 }}>{inv.status || '—'}</Text>
                      <Text style={{ color: colors.text, fontSize: 13 }}>
                        {typeof inv.amount === 'number'
                          ? `${inv.amount.toFixed(2)} ${inv.currency || 'USD'}`
                          : '—'}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 16, marginTop: 6 }}>
                      {inv.can_pay && inv.invoice_url ? (
                        <TouchableOpacity onPress={() => Linking.openURL(inv.invoice_url!)}>
                          <Text style={{ color: '#B45309', fontWeight: '600' }}>Pay</Text>
                        </TouchableOpacity>
                      ) : null}
                      {inv.invoice_url && !inv.can_pay ? (
                        <TouchableOpacity onPress={() => Linking.openURL(inv.invoice_url!)}>
                          <Text style={styles.linkText}>View</Text>
                        </TouchableOpacity>
                      ) : null}
                      {inv.invoice_pdf_url && inv.invoice_pdf_url !== inv.invoice_url ? (
                        <TouchableOpacity onPress={() => Linking.openURL(inv.invoice_pdf_url!)}>
                          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>PDF</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                );
              })
            )}
          </View>
        ) : null}

        <TouchableOpacity style={styles.linkBtn} onPress={() => Linking.openURL(PRICING_URL)}>
          <Text style={styles.linkText}>View plans on grabdocs.com/pricing</Text>
        </TouchableOpacity>
      </>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton onPress={handleBack} />
        <AppHeaderTitle>Billing & Usage</AppHeaderTitle>
        <View style={styles.headerBtn} />
      </View>

      <View style={styles.segments}>
        {canViewUsage ? (
          <TouchableOpacity
            style={[styles.segmentBtn, segment === 'usage' && styles.segmentActive]}
            onPress={() => setSegment('usage')}
          >
            <Text style={[styles.segmentText, segment === 'usage' && styles.segmentTextActive]}>
              Usage
            </Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.segmentBtn, segment === 'billing' && styles.segmentActive]}
          onPress={() => setSegment('billing')}
        >
          <Text style={[styles.segmentText, segment === 'billing' && styles.segmentTextActive]}>
            Billing
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        keyboardShouldPersistTaps="handled"
      >
        {segment === 'usage' ? renderUsage() : renderBilling()}
      </ScrollView>
    </SafeAreaView>
  );
}
