import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { apiService } from '../../../services/api';
import {
  INTAKE_SCHEDULE_STATUS_COLORS,
  INTAKE_SCHEDULE_STATUS_LABELS,
  INTAKE_STATUS_LABELS,
  INTAKE_WEEKDAY_OPTIONS,
  type IntakeScheduleDetail,
  type IntakeScheduleFrequency,
  type IntakeWeekday,
} from '../../../types/intake';
import { truncateAppHeaderTitle } from '../../../utils/chatTitleDisplay';
import { parseUtcMs } from '../../../utils/timeFormatting';

const FREQ_OPTIONS: { value: IntakeScheduleFrequency; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

function formatWhen(iso?: string | null): string {
  if (!iso) return '—';
  const ms = parseUtcMs(iso);
  if (Number.isNaN(ms)) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
}

export default function IntakeScheduleDetailScreen() {
  const router = useRouter();
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const scheduleId = Number(idParam);
  const colors = useThemeColors();

  const [schedule, setSchedule] = useState<IntakeScheduleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const [editFreq, setEditFreq] = useState<IntakeScheduleFrequency>('monthly');
  const [editInterval, setEditInterval] = useState(1);
  const [editByWeekday, setEditByWeekday] = useState<IntakeWeekday>('MO');
  const [editByMonthDay, setEditByMonthDay] = useState(1);
  const [editByMonth, setEditByMonth] = useState(1);
  const [editDueAfter, setEditDueAfter] = useState(14);
  const [editReminderMax, setEditReminderMax] = useState(30);
  const [editTimezone, setEditTimezone] = useState('UTC');

  const load = useCallback(async (soft = false) => {
    if (!Number.isFinite(scheduleId) || scheduleId <= 0) {
      setLoading(false);
      return;
    }
    if (!soft) setLoading(true);
    try {
      const res = await apiService.getIntakeSchedule(scheduleId);
      if (res.success && res.schedule) {
        const s = res.schedule as IntakeScheduleDetail;
        setSchedule(s);
        setEditFreq((s.frequency as IntakeScheduleFrequency) || 'monthly');
        setEditInterval(Math.max(1, s.interval_count || 1));
        setEditByWeekday((s.by_weekday as IntakeWeekday) || 'MO');
        setEditByMonthDay(s.by_month_day ?? 1);
        setEditByMonth(s.by_month ?? 1);
        setEditDueAfter(s.due_after_days ?? 14);
        setEditReminderMax(s.reminder_max_days ?? 30);
        setEditTimezone(s.timezone || 'UTC');
      } else if (!soft) {
        Alert.alert('Error', res.message || 'Schedule not found');
      }
    } catch (e: any) {
      if (!soft) Alert.alert('Error', e.message || 'Failed to load schedule');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [scheduleId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const patchStatus = async (status: 'active' | 'paused' | 'completed') => {
    if (!schedule || busy) return;
    const run = async () => {
      setBusy(true);
      try {
        const res = await apiService.patchIntakeSchedule(schedule.id, { status });
        if (res.success && res.schedule) {
          setSchedule(res.schedule as IntakeScheduleDetail);
        } else {
          Alert.alert('Error', res.message || 'Could not update schedule');
        }
      } catch (e: any) {
        Alert.alert('Error', e.message || 'Could not update schedule');
      } finally {
        setBusy(false);
      }
    };
    if (status === 'completed') {
      Alert.alert('End schedule?', 'No more Collections will be created.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'End', style: 'destructive', onPress: () => void run() },
      ]);
      return;
    }
    await run();
  };

  const saveCadence = async () => {
    if (!schedule || busy) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        frequency: editFreq,
        interval_count: Math.max(1, editInterval),
        due_after_days: Math.max(1, editDueAfter),
        reminder_max_days: Math.max(1, editReminderMax),
        timezone: editTimezone.trim() || 'UTC',
      };
      if (editFreq === 'weekly') {
        payload.by_weekday = editByWeekday;
        payload.by_month_day = null;
        payload.by_month = null;
      } else if (editFreq === 'yearly') {
        payload.by_month_day = editByMonthDay;
        payload.by_month = editByMonth;
        payload.by_weekday = null;
      } else if (editFreq === 'once') {
        payload.by_month_day = null;
        payload.by_month = null;
        payload.by_weekday = null;
      } else {
        payload.by_month_day = editByMonthDay;
        payload.by_month = null;
        payload.by_weekday = null;
      }
      const res = await apiService.patchIntakeSchedule(schedule.id, payload);
      if (res.success && res.schedule) {
        setSchedule(res.schedule as IntakeScheduleDetail);
        setEditing(false);
      } else {
        Alert.alert('Error', res.message || 'Could not save cadence');
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not save cadence');
    } finally {
      setBusy(false);
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          padding: 16,
          backgroundColor: colors.headerBackground,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        },
        center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
        card: {
          backgroundColor: colors.card,
          marginTop: 8,
          padding: 16,
        },
        eyebrow: {
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: '#0F766E',
          marginBottom: 4,
        },
        title: { fontSize: 20, fontWeight: '700', color: colors.text },
        subtitle: { fontSize: 14, color: colors.textSecondary, marginTop: 4 },
        badge: {
          alignSelf: 'flex-start',
          marginTop: 10,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 12,
        },
        badgeText: { fontSize: 11, fontWeight: '600' },
        metaGrid: { marginTop: 16, gap: 12 },
        metaLabel: { fontSize: 11, color: colors.textSecondary, marginBottom: 2 },
        metaValue: { fontSize: 14, fontWeight: '600', color: colors.text },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
        actionBtn: {
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        },
        actionBtnPrimary: { backgroundColor: '#0D9488', borderColor: '#0D9488' },
        actionBtnDanger: { borderColor: '#FECACA', backgroundColor: '#FEF2F2' },
        actionText: { fontSize: 13, fontWeight: '600', color: colors.text },
        actionTextPrimary: { color: '#fff' },
        actionTextDanger: { color: '#B91C1C' },
        sectionTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 10 },
        collectionRow: {
          paddingVertical: 12,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
        },
        collectionTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
        collectionMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
        chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
        chip: {
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 8,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
        },
        chipActive: { backgroundColor: '#CCFBF1', borderColor: '#0D9488' },
        chipText: { fontSize: 12, fontWeight: '600', color: colors.text },
        input: {
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          color: colors.text,
          marginBottom: 10,
          backgroundColor: colors.background,
        },
        label: { fontSize: 13, fontWeight: '500', color: colors.text, marginBottom: 4 },
      }),
    [colors]
  );

  if (!Number.isFinite(scheduleId) || scheduleId <= 0) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <AppBackButton />
          <AppHeaderTitle>Schedule</AppHeaderTitle>
        </View>
        <View style={styles.center}>
          <Text style={{ color: colors.text }}>Invalid schedule</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loading && !schedule) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <AppBackButton />
          <AppHeaderTitle>Schedule</AppHeaderTitle>
        </View>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0D9488" />
        </View>
      </SafeAreaView>
    );
  }

  if (!schedule) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <AppBackButton />
          <AppHeaderTitle>Schedule</AppHeaderTitle>
        </View>
        <View style={styles.center}>
          <Text style={{ color: colors.text }}>Schedule not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const statusColor =
    INTAKE_SCHEDULE_STATUS_COLORS[schedule.status] || INTAKE_SCHEDULE_STATUS_COLORS.completed;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle shrink={false}>
          {truncateAppHeaderTitle(schedule.title || 'Schedule')}
        </AppHeaderTitle>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load(true);
            }}
            tintColor="#0D9488"
          />
        }
      >
        <View style={styles.card}>
          <Text style={styles.eyebrow}>Scheduled</Text>
          <Text style={styles.title}>{schedule.title}</Text>
          <Text style={styles.subtitle}>{schedule.cadence_summary || schedule.frequency}</Text>
          <View style={[styles.badge, { backgroundColor: statusColor.bg }]}>
            <Text style={[styles.badgeText, { color: statusColor.text }]}>
              {INTAKE_SCHEDULE_STATUS_LABELS[schedule.status] || schedule.status}
            </Text>
          </View>

          <View style={styles.metaGrid}>
            <View>
              <Text style={styles.metaLabel}>Next request</Text>
              <Text style={styles.metaValue}>
                {schedule.next_run_at
                  ? formatWhen(schedule.next_run_at)
                  : schedule.status === 'completed'
                    ? 'Ended'
                    : '—'}
              </Text>
            </View>
            <View>
              <Text style={styles.metaLabel}>Reminder cadence</Text>
              <Text style={styles.metaValue}>
                {schedule.reminder_preset || 'standard'}
                {schedule.reminder_max_days ? ` · stop after ${schedule.reminder_max_days}d` : ''}
              </Text>
            </View>
            <View>
              <Text style={styles.metaLabel}>Due</Text>
              <Text style={styles.metaValue}>
                {schedule.due_after_days || 14} days after we send
                {schedule.estimated_next_due_at
                  ? `\nEst. next due ${formatWhen(schedule.estimated_next_due_at)}`
                  : ''}
              </Text>
            </View>
            <View>
              <Text style={styles.metaLabel}>Client</Text>
              <Text style={styles.metaValue}>
                {schedule.client_name || schedule.client_primary_email || '—'}
              </Text>
            </View>
            <View>
              <Text style={styles.metaLabel}>Timezone</Text>
              <Text style={styles.metaValue}>{schedule.timezone || 'UTC'}</Text>
            </View>
          </View>

          <View style={styles.actions}>
            {schedule.status === 'active' ? (
              <FeedbackTouchable
                style={styles.actionBtn}
                onPress={() => void patchStatus('paused')}
                disabled={busy}
                loading={busy}
              >
                <Text style={styles.actionText}>Pause</Text>
              </FeedbackTouchable>
            ) : null}
            {schedule.status === 'paused' ? (
              <FeedbackTouchable
                style={[styles.actionBtn, styles.actionBtnPrimary]}
                onPress={() => void patchStatus('active')}
                disabled={busy}
                loading={busy}
                spinnerColor="#fff"
              >
                <Text style={[styles.actionText, styles.actionTextPrimary]}>Resume</Text>
              </FeedbackTouchable>
            ) : null}
            {schedule.status !== 'completed' ? (
              <>
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => setEditing((v) => !v)}
                  disabled={busy}
                >
                  <Text style={styles.actionText}>{editing ? 'Cancel edit' : 'Edit cadence'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.actionBtnDanger]}
                  onPress={() => void patchStatus('completed')}
                  disabled={busy}
                >
                  <Text style={[styles.actionText, styles.actionTextDanger]}>End</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        </View>

        {editing ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Edit cadence</Text>
            <Text style={styles.label}>Frequency</Text>
            <View style={styles.chipRow}>
              {FREQ_OPTIONS.map((o) => (
                <TouchableOpacity
                  key={o.value}
                  style={[styles.chip, editFreq === o.value && styles.chipActive]}
                  onPress={() => setEditFreq(o.value)}
                >
                  <Text style={styles.chipText}>{o.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {editFreq !== 'once' ? (
              <>
                <Text style={styles.label}>Every N</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="number-pad"
                  value={String(editInterval)}
                  onChangeText={(v) => setEditInterval(Math.max(1, parseInt(v, 10) || 1))}
                />
              </>
            ) : null}
            {editFreq === 'weekly' ? (
              <>
                <Text style={styles.label}>Weekday</Text>
                <View style={styles.chipRow}>
                  {INTAKE_WEEKDAY_OPTIONS.map((o) => (
                    <TouchableOpacity
                      key={o.value}
                      style={[styles.chip, editByWeekday === o.value && styles.chipActive]}
                      onPress={() => setEditByWeekday(o.value)}
                    >
                      <Text style={styles.chipText}>{o.label.slice(0, 3)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}
            {editFreq === 'monthly' || editFreq === 'quarterly' || editFreq === 'yearly' ? (
              <>
                <Text style={styles.label}>Day of month (1–28 or -1 last)</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="numbers-and-punctuation"
                  value={String(editByMonthDay)}
                  onChangeText={(v) => {
                    const n = parseInt(v, 10);
                    if (v === '-' || v === '') setEditByMonthDay(v === '-' ? -1 : 1);
                    else if (!Number.isNaN(n)) setEditByMonthDay(n);
                  }}
                />
              </>
            ) : null}
            {editFreq === 'yearly' ? (
              <>
                <Text style={styles.label}>Month (1–12)</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="number-pad"
                  value={String(editByMonth)}
                  onChangeText={(v) => setEditByMonth(Math.min(12, Math.max(1, parseInt(v, 10) || 1)))}
                />
              </>
            ) : null}
            <Text style={styles.label}>Due after (days)</Text>
            <TextInput
              style={styles.input}
              keyboardType="number-pad"
              value={String(editDueAfter)}
              onChangeText={(v) => setEditDueAfter(Math.max(1, parseInt(v, 10) || 1))}
            />
            <Text style={styles.label}>Stop reminding after (days)</Text>
            <TextInput
              style={styles.input}
              keyboardType="number-pad"
              value={String(editReminderMax)}
              onChangeText={(v) => setEditReminderMax(Math.max(1, parseInt(v, 10) || 1))}
            />
            <Text style={styles.label}>Timezone</Text>
            <TextInput
              style={styles.input}
              value={editTimezone}
              onChangeText={setEditTimezone}
              autoCapitalize="none"
            />
            <FeedbackTouchable
              style={[styles.actionBtn, styles.actionBtnPrimary, { alignSelf: 'flex-start' }]}
              onPress={() => void saveCadence()}
              disabled={busy}
              loading={busy}
              spinnerColor="#fff"
            >
              <Text style={[styles.actionText, styles.actionTextPrimary]}>Save cadence</Text>
            </FeedbackTouchable>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            Collections ({schedule.collections?.length ?? 0})
          </Text>
          {(schedule.collections || []).length === 0 ? (
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              No Collections yet. The next request will create one.
            </Text>
          ) : (
            (schedule.collections || []).map((c) => {
              const pct = c.progress?.percent ?? 0;
              const statusLabel =
                (INTAKE_STATUS_LABELS as Record<string, string>)[c.status] || c.status;
              return (
                <TouchableOpacity
                  key={c.id}
                  style={styles.collectionRow}
                  onPress={() => router.push(`/intake/${c.id}` as any)}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.collectionTitle} numberOfLines={1}>
                      {c.period_label || c.title}
                    </Text>
                    <Ionicons name="chevron-forward" size={16} color={colors.textLight} />
                  </View>
                  <Text style={styles.collectionMeta}>
                    {statusLabel}
                    {c.progress ? ` · ${pct}%` : ''}
                    {!c.sent_at ? ' · not sent yet' : ''}
                  </Text>
                </TouchableOpacity>
              );
            })
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
