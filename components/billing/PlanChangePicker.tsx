import * as WebBrowser from 'expo-web-browser';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  createPlanChangeIntent,
  syncSubscription,
  PLAN_CHANGE_CYCLES,
  PLAN_CHANGE_KEYS,
  type PlanChangeCycle,
  type PlanChangeKey,
} from '../../services/subscriptionApi';

const PLAN_LABELS: Record<PlanChangeKey, string> = {
  starter: 'Starter',
  pro: 'Pro',
  premium: 'Premium',
};

const CYCLE_LABELS: Record<PlanChangeCycle, string> = {
  monthly: 'Monthly',
  yearly: 'Yearly',
};

type PlanChangePickerProps = {
  intro?: string;
  onOpening?: () => void;
  onReturned?: () => void | Promise<void>;
};

export default function PlanChangePicker({ intro, onOpening, onReturned }: PlanChangePickerProps) {
  const colors = useThemeColors();
  const [planKey, setPlanKey] = useState<PlanChangeKey>('pro');
  const [billingCycle, setBillingCycle] = useState<PlanChangeCycle>('monthly');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          borderRadius: 12,
          borderWidth: 1,
          borderColor: '#3B82F6',
          backgroundColor: colors.isDark ? 'rgba(59,130,246,0.15)' : '#EFF6FF',
          padding: 14,
        },
        intro: { color: colors.text, fontSize: 14, marginBottom: 10, lineHeight: 20 },
        row: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
        chip: {
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.card,
          marginRight: 8,
          marginBottom: 8,
        },
        chipOn: { borderColor: '#2563EB', backgroundColor: '#2563EB' },
        chipText: { color: colors.text, fontSize: 14, fontWeight: '500' },
        chipTextOn: { color: '#fff' },
        error: { color: '#DC2626', fontSize: 13, marginBottom: 8 },
        button: {
          backgroundColor: '#2563EB',
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: 8,
          alignSelf: 'flex-start',
          minWidth: 180,
          alignItems: 'center',
        },
        buttonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
      }),
    [colors],
  );

  const continueToPayment = async () => {
    setLoading(true);
    setError('');
    onOpening?.();
    try {
      const res = await createPlanChangeIntent(planKey, billingCycle);
      if (!res.redirect_url) {
        setError('Could not start checkout');
        return;
      }
      await WebBrowser.openBrowserAsync(res.redirect_url);
      if (onReturned) await onReturned();
      else await syncSubscription().catch(() => null);
    } catch (e: any) {
      setError(e?.message || 'Could not start checkout');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.wrap}>
      {intro ? <Text style={styles.intro}>{intro}</Text> : null}
      <View style={styles.row}>
        {PLAN_CHANGE_KEYS.map((key) => {
          const selected = planKey === key;
          return (
            <TouchableOpacity
              key={key}
              style={[styles.chip, selected && styles.chipOn]}
              onPress={() => setPlanKey(key)}
              disabled={loading}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.chipText, selected && styles.chipTextOn]}>{PLAN_LABELS[key]}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={styles.row}>
        {PLAN_CHANGE_CYCLES.map((cycle) => {
          const selected = billingCycle === cycle;
          return (
            <TouchableOpacity
              key={cycle}
              style={[styles.chip, selected && styles.chipOn]}
              onPress={() => setBillingCycle(cycle)}
              disabled={loading}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.chipText, selected && styles.chipTextOn]}>{CYCLE_LABELS[cycle]}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity
        style={[styles.button, loading && { opacity: 0.6 }]}
        onPress={continueToPayment}
        disabled={loading}
        accessibilityRole="button"
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Continue to payment</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}
