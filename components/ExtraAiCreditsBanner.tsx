import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { STORAGE_KEYS } from '../constants/Config';
import { useThemeColors } from '../hooks/useThemeColors';
import {
  getSettingsUsageStats,
  type ExtraAiCreditsInfo,
} from '../services/subscriptionApi';

const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

type ExtraAiCreditsBannerProps = {
  extraAi?: ExtraAiCreditsInfo | null;
  canManageBilling?: boolean;
  billingAdminEmail?: string | null;
  persistent?: boolean;
  userId?: number | string | null;
};

function dismissStorageKey(userId?: number | string | null): string {
  const id = userId != null && String(userId) !== '' ? String(userId) : 'anon';
  return `${STORAGE_KEYS.EXTRA_AI_BANNER_DISMISS}:${id}`;
}

async function readDismissUntil(userId?: number | string | null): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(dismissStorageKey(userId));
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function writeDismissUntil(userId?: number | string | null): Promise<number> {
  const until = Date.now() + SNOOZE_MS;
  try {
    await AsyncStorage.setItem(dismissStorageKey(userId), String(until));
  } catch {
    /* ignore */
  }
  return until;
}

export default function ExtraAiCreditsBanner({
  extraAi,
  canManageBilling = true,
  billingAdminEmail,
  persistent = false,
  userId,
}: ExtraAiCreditsBannerProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const [fetched, setFetched] = useState<ExtraAiCreditsInfo | null>(extraAi ?? null);
  const [fetchedBilling, setFetchedBilling] = useState<{ canManage?: boolean; email?: string | null }>({});
  const [fetchedUserId, setFetchedUserId] = useState<number | string | null>(userId ?? null);
  const [dismissUntil, setDismissUntil] = useState<number | null>(persistent ? 0 : null);

  useEffect(() => {
    if (extraAi !== undefined) {
      setFetched(extraAi);
      return;
    }
    let cancelled = false;
    getSettingsUsageStats('month')
      .then((data) => {
        if (cancelled) return;
        setFetched(data?.extra_ai_credits || null);
        setFetchedBilling({
          canManage: data?.can_manage_billing !== false,
          email: data?.billing_admin_email || null,
        });
        const id = data?.debug_info?.user_id;
        if (id != null) setFetchedUserId(id);
      })
      .catch(() => {
        if (!cancelled) setFetched(null);
      });
    return () => {
      cancelled = true;
    };
  }, [extraAi]);

  useEffect(() => {
    if (userId != null) setFetchedUserId(userId);
  }, [userId]);

  useEffect(() => {
    if (persistent) {
      setDismissUntil(0);
      return;
    }
    let cancelled = false;
    readDismissUntil(fetchedUserId ?? userId).then((until) => {
      if (!cancelled) setDismissUntil(until);
    });
    return () => {
      cancelled = true;
    };
  }, [persistent, fetchedUserId, userId]);

  const handleDismiss = useCallback(() => {
    void writeDismissUntil(fetchedUserId ?? userId).then(setDismissUntil);
  }, [fetchedUserId, userId]);

  const info = extraAi !== undefined ? extraAi : fetched;
  const used = info?.used ?? info?.tokens_overage ?? 0;
  const inExtra = Boolean(info?.in_extra_credits) || used > 0;
  if (!inExtra) return null;
  if (!persistent && dismissUntil === null) return null;
  if (!persistent && Date.now() < (dismissUntil || 0)) return null;

  const cents = info?.next_bill_cents ?? info?.overage_amount_cents ?? 0;
  const dollars = (cents / 100).toFixed(2);
  const canManage = extraAi !== undefined ? canManageBilling : (fetchedBilling.canManage ?? canManageBilling);
  const adminEmail = extraAi !== undefined ? billingAdminEmail : (fetchedBilling.email ?? billingAdminEmail);
  const canAdd = info?.can_add_credits !== false && canManage;

  return (
    <View
      style={[
        styles.banner,
        {
          borderColor: colors.isDark ? '#92400E' : '#FDE68A',
          backgroundColor: colors.isDark ? 'rgba(245,158,11,0.15)' : '#FFFBEB',
        },
      ]}
    >
      <View style={styles.row}>
        <Text style={[styles.text, { color: colors.isDark ? '#FDE68A' : '#78350F' }]}>
          Included AI credits are used. You&apos;re currently using extra credits
          {cents ? (
            <>
              : <Text style={styles.amount}>${dollars} this period</Text>, billed on your next invoice.
            </>
          ) : (
            ', billed on your next invoice.'
          )}
        </Text>
        {!persistent ? (
          <TouchableOpacity
            onPress={handleDismiss}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss extra credits notice"
          >
            <Ionicons name="close" size={18} color={colors.isDark ? '#FDE68A' : '#92400E'} />
          </TouchableOpacity>
        ) : null}
      </View>
      {canAdd ? (
        <TouchableOpacity onPress={() => router.push('/billing?tab=billing' as any)}>
          <Text style={styles.link}>Add Credits</Text>
        </TouchableOpacity>
      ) : (
        <Text style={[styles.adminHint, { color: colors.isDark ? '#FCD34D' : '#92400E' }]}>
          Ask your billing administrator{adminEmail ? ` (${adminEmail})` : ''} to Add Credits.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  text: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  amount: {
    fontWeight: '700',
  },
  link: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  adminHint: {
    marginTop: 8,
    fontSize: 13,
  },
});
