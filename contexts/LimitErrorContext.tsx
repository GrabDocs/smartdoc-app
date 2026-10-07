/**
 * LimitErrorContext for mobile app.
 * Explains the limit and sends the user to in-app Billing.
 * The plan picker lives only on that page. upgrade_url and action_url are not opened.
 */

import { useRouter } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../hooks/useThemeColors';
import type { LimitErrorData } from '../utils/limitErrorUtils';

interface LimitErrorContextType {
  showLimitError: (data: LimitErrorData) => void;
}

const LimitErrorContext = createContext<LimitErrorContextType | undefined>(undefined);

const noopShowLimitError = () => {};

let reportLimitError: ((data: LimitErrorData) => void) | null = null;

/** For non-React callers such as the file upload store. */
export function notifyLimitError(data: LimitErrorData): boolean {
  if (!reportLimitError) return false;
  reportLimitError(data);
  return true;
}

export function useLimitError(): LimitErrorContextType {
  const ctx = useContext(LimitErrorContext);
  return ctx ?? { showLimitError: noopShowLimitError };
}

export function LimitErrorProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const colors = useThemeColors();
  const [data, setData] = useState<LimitErrorData | null>(null);

  const showLimitError = useCallback((next: LimitErrorData) => {
    setData(next);
  }, []);

  useEffect(() => {
    reportLimitError = showLimitError;
    return () => {
      reportLimitError = null;
    };
  }, [showLimitError]);

  const dismiss = useCallback(() => setData(null), []);

  const openBilling = useCallback(() => {
    setData(null);
    router.push({ pathname: '/billing', params: { tab: 'billing' } } as any);
  }, [router]);

  const extraCapped = data?.errorCode === 'extra_credits_capped';
  const canAddCredits = extraCapped ? data?.details?.can_add_credits !== false : false;
  const adminEmail =
    typeof data?.details?.billing_admin_email === 'string' ? data.details.billing_admin_email : '';

  return (
    <LimitErrorContext.Provider value={{ showLimitError }}>
      {children}
      <Modal visible={!!data} transparent animationType="fade" onRequestClose={dismiss}>
        <View style={styles.backdrop}>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <ScrollView keyboardShouldPersistTaps="handled" bounces={false}>
              <Text style={[styles.title, { color: colors.text }]}>
                {data ? getTitle(data.limitType, data.errorCode) : ''}
              </Text>
              <Text style={[styles.message, { color: colors.text }]}>{data?.message}</Text>
              {data ? <UsageLine data={data} color={colors.textSecondary} /> : null}
              {data && !extraCapped ? (
                <TouchableOpacity style={styles.primaryBtn} onPress={openBilling}>
                  <Text style={styles.primaryBtnText}>Go to Billing</Text>
                </TouchableOpacity>
              ) : null}
              {extraCapped && canAddCredits ? (
                <TouchableOpacity style={styles.primaryBtn} onPress={openBilling}>
                  <Text style={styles.primaryBtnText}>Add Credits</Text>
                </TouchableOpacity>
              ) : null}
              {extraCapped && !canAddCredits ? (
                <Text style={[styles.message, { color: colors.textSecondary, marginTop: 12 }]}>
                  Ask your billing administrator{adminEmail ? ` (${adminEmail})` : ''} to add credits.
                </Text>
              ) : null}
              <TouchableOpacity style={styles.dismissBtn} onPress={dismiss}>
                <Text style={[styles.dismissText, { color: colors.text }]}>Dismiss</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </LimitErrorContext.Provider>
  );
}

function UsageLine({ data, color }: { data: LimitErrorData; color: string }) {
  const details = data.details;
  if (!details) return null;
  if (details.current_usage_mb != null && details.limit_mb != null) {
    return (
      <Text style={[styles.usage, { color }]}>
        Using {Number(details.current_usage_mb).toFixed(1)} MB of {Number(details.limit_mb).toFixed(1)} MB
      </Text>
    );
  }
  const used = details.used ?? details.tokens_used;
  const limit = details.limit ?? details.tokens_limit;
  if (used != null && limit != null) {
    return (
      <Text style={[styles.usage, { color }]}>
        {Number(used).toLocaleString()} of {Number(limit).toLocaleString()} credits used this month
      </Text>
    );
  }
  if (details.meetings_conducted != null && details.max_meetings_per_month != null) {
    return (
      <Text style={[styles.usage, { color }]}>
        {details.meetings_conducted} of {details.max_meetings_per_month} meetings used this month
      </Text>
    );
  }
  return null;
}

function getTitle(limitType?: string, errorCode?: string): string {
  if (errorCode === 'storage_limit_exceeded' || limitType === 'storage') {
    return 'Storage Limit Reached';
  }
  if (errorCode === 'extra_credits_capped') {
    return 'Extra AI Credits used up';
  }
  if (
    errorCode === 'insufficient_tokens' ||
    errorCode === 'monthly_token_limit_exceeded' ||
    errorCode === 'token_limit_exceeded' ||
    limitType === 'tokens'
  ) {
    return 'Credit Limit Exceeded';
  }
  if (errorCode === 'meeting_limit_exceeded' || errorCode === 'participant_limit_exceeded' || limitType === 'meetings') {
    return 'Meeting Limit Reached';
  }
  if (
    errorCode === 'workspace_limit_exceeded' ||
    errorCode === 'workspace_member_limit_exceeded'
  ) {
    return 'Workspace Limit Reached';
  }
  return 'Limit Reached';
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    maxHeight: '90%',
  },
  title: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  message: { fontSize: 14, lineHeight: 20 },
  usage: { fontSize: 13, marginTop: 8 },
  primaryBtn: {
    marginTop: 14,
    backgroundColor: '#2563EB',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  dismissBtn: {
    marginTop: 12,
    paddingVertical: 10,
    alignSelf: 'flex-start',
  },
  dismissText: { fontSize: 14, fontWeight: '600' },
});
