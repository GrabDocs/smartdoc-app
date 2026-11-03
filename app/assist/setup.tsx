import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { useThemeColors } from '../../hooks/useThemeColors';
import { completeAssistSetup, getAssistStatus, getAssistTaxonomy } from '../../services/assistApi';
import {
  listInboxConnections,
  type InboxConnection,
} from '../../services/emailSyncApi';

const LOOKBACKS = [
  { id: '1w', label: '1 week' },
  { id: '1y', label: '1 year' },
  { id: '5y', label: '5 years' },
  { id: 'all', label: 'All history' },
  { id: 'custom', label: 'From' },
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatFromLocal(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function parseBriefTime(hhmm: string): Date {
  const d = new Date();
  const [hRaw, mRaw] = (hhmm || '06:00').split(':');
  const h = Number(hRaw);
  const m = Number(mRaw);
  d.setHours(Number.isFinite(h) ? h : 6, Number.isFinite(m) ? m : 0, 0, 0);
  return d;
}

function formatBriefTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function displayBriefTime(hhmm: string): string {
  return parseBriefTime(hhmm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function platformLabel(platform: string): string {
  return platform === 'outlook_inbox' ? 'Outlook' : 'Gmail';
}

export default function AssistSetupScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const [connections, setConnections] = useState<InboxConnection[]>([]);
  const [loadingConns, setLoadingConns] = useState(true);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [lookback, setLookback] = useState('1y');
  const [fromAt, setFromAt] = useState<Date | null>(null);
  const [showIosFrom, setShowIosFrom] = useState(false);
  const [briefTime, setBriefTime] = useState('06:00');
  const [showIosBrief, setShowIosBrief] = useState(false);
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [saving, setSaving] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [fallbackFolder, setFallbackFolder] = useState('');
  const [callsEnabled, setCallsEnabled] = useState(false);
  const hydratedRef = React.useRef(false);
  const dirtyRef = React.useRef(false);

  const applySavedSettings = useCallback((saved: any) => {
    if (!saved) return;
    if (saved.lookback_mode) setLookback(String(saved.lookback_mode));
    if (saved.brief_local_time) {
      const t = String(saved.brief_local_time);
      setBriefTime(t.length >= 5 ? t.slice(0, 5) : t);
    }
    if (saved.timezone) setTimezone(String(saved.timezone));
    if (saved.lookback_since) {
      const d = new Date(saved.lookback_since);
      if (!Number.isNaN(d.getTime())) {
        setFromAt(d);
        // Custom From is authoritative when a stored timestamp exists.
        if (String(saved.lookback_mode || '') === 'custom') {
          setLookback('custom');
        }
      }
    }
  }, []);

  const loadConnections = useCallback(async () => {
    setLoadingConns(true);
    try {
      const [list, tax, status] = await Promise.all([
        listInboxConnections(),
        getAssistTaxonomy().catch(() => null),
        getAssistStatus().catch(() => null),
      ]);
      const usable = (list || []).filter((c) => c.is_active !== false && !c.needs_reconnect);
      setConnections(usable);
      setFolders(tax?.folders || []);
      setFallbackFolder(tax?.fallback || '');
      setCallsEnabled(Boolean(status?.calls_enabled));
      const saved = status?.settings;
      const preferred = saved?.connection_id ? Number(saved.connection_id) : null;
      setConnectionId((prev) => {
        if (preferred && usable.some((c) => c.id === preferred)) return preferred;
        if (prev && usable.some((c) => c.id === prev)) return prev;
        return usable[0]?.id ?? null;
      });
      // Never overwrite an in-progress From date (async load / focus race).
      if (saved && !hydratedRef.current && !dirtyRef.current) {
        hydratedRef.current = true;
        applySavedSettings(saved);
      }
    } catch {
      setConnections([]);
      setFolders([]);
    } finally {
      setLoadingConns(false);
    }
  }, [applySavedSettings]);

  useFocusEffect(
    useCallback(() => {
      void loadConnections();
    }, [loadConnections]),
  );

  const applyFrom = (date: Date) => {
    if (date.getTime() > Date.now() + 5 * 60 * 1000) {
      Alert.alert('Start date', 'Choose today or an earlier date.');
      return;
    }
    dirtyRef.current = true;
    setLookback('custom');
    setFromAt(date);
  };

  const defaultFromAt = () => {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    weekAgo.setHours(0, 0, 0, 0);
    return weekAgo;
  };

  const openFromPicker = (seed?: Date | null) => {
    const current =
      seed && !Number.isNaN(seed.getTime())
        ? seed
        : fromAt && !Number.isNaN(fromAt.getTime())
          ? fromAt
          : defaultFromAt();
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: current,
        mode: 'date',
        maximumDate: new Date(),
        onChange: (event, date) => {
          if (event?.type !== 'set' || !date) return;
          DateTimePickerAndroid.open({
            value: date,
            mode: 'time',
            is24Hour: true,
            onChange: (timeEvent, time) => {
              const merged = new Date(date);
              if (timeEvent?.type === 'set' && time) {
                merged.setHours(time.getHours(), time.getMinutes(), 0, 0);
              } else {
                merged.setHours(0, 0, 0, 0);
              }
              applyFrom(merged);
            },
          });
        },
      });
      return;
    }
    setShowIosFrom(true);
  };

  const openBriefPicker = () => {
    const current = parseBriefTime(briefTime);
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: current,
        mode: 'time',
        onChange: (event, date) => {
          if (event?.type === 'set' && date) setBriefTime(formatBriefTime(date));
        },
      });
      return;
    }
    setShowIosBrief(true);
  };

  const finish = async () => {
    if (!connectionId) {
      Alert.alert(
        'Mailbox required',
        'Connect a Gmail or Outlook mailbox (same screen as Email Replies), then return here.',
      );
      return;
    }
    if (lookback === 'custom' && !fromAt) {
      Alert.alert('Start date', 'Choose the date and time the archive should start from.');
      return;
    }
    setSaving(true);
    try {
      const res = await completeAssistSetup({
        connection_id: connectionId,
        lookback_mode: lookback,
        lookback_from: lookback === 'custom' && fromAt ? formatFromLocal(fromAt) : undefined,
        brief_local_time: briefTime,
        timezone,
      });
      dirtyRef.current = false;
      hydratedRef.current = true;
      if (res?.settings) applySavedSettings(res.settings);
      Alert.alert(
        'Assist is ready',
        'Archive backfill has started. Your first Daily Brief is created in the next hourly check.',
      );
      router.replace('/assist' as any);
    } catch (e: any) {
      Alert.alert(
        'Setup failed',
        e?.response?.data?.message || e?.response?.data?.error || 'Could not complete setup',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Assist setup</AppHeaderTitle>
        <View style={{ width: 40 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={[styles.label, { color: colors.text }]}>Mailbox</Text>
        <Text style={{ color: colors.textSecondary, marginBottom: 8, fontSize: 12 }}>
          Same Gmail/Outlook connection and account page as Email Replies. Connect or manage it there,
          then pick it below.
        </Text>
        {loadingConns ? (
          <ActivityIndicator color="#0284C7" />
        ) : connections.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={{ color: colors.textSecondary, marginBottom: 10 }}>
              No mailbox connected yet.
            </Text>
            <TouchableOpacity
              style={styles.linkBtn}
              onPress={() => router.push('/email-sync/mailbox' as any)}
            >
              <Text style={styles.linkBtnText}>Open Email Replies mailbox</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            {connections.map((c) => {
              const on = connectionId === c.id;
              return (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.connRow, on && styles.connRowOn]}
                  onPress={() => setConnectionId(c.id)}
                >
                  <Text style={{ color: on ? '#fff' : colors.text, fontWeight: '600' }}>
                    {platformLabel(c.platform)} · {c.account_name || `Connection ${c.id}`}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity onPress={() => router.push('/email-sync/mailbox' as any)}>
              <Text style={{ color: '#0284C7', fontWeight: '600', marginTop: 4 }}>
                Manage mailbox connection
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={[styles.label, { color: colors.text }]}>Look-back</Text>
        <View style={styles.chips}>
          {LOOKBACKS.map((l) => (
            <TouchableOpacity
              key={l.id}
              style={[styles.chip, lookback === l.id && styles.chipOn]}
              onPress={() => {
                dirtyRef.current = true;
                setLookback(l.id);
                if (l.id === 'custom') {
                  const next =
                    fromAt && !Number.isNaN(fromAt.getTime()) ? fromAt : defaultFromAt();
                  setFromAt(next);
                  openFromPicker(next);
                }
              }}
            >
              <Text style={{ color: lookback === l.id ? '#fff' : colors.text }}>{l.label}</Text>
            </TouchableOpacity>
          ))}
          {lookback === 'custom' ? (
            <TouchableOpacity
              style={[styles.chip, { backgroundColor: '#fff', borderWidth: 1, borderColor: '#CBD5E1' }]}
              onPress={openFromPicker}
            >
              <Text style={{ color: colors.text }}>
                {fromAt ? formatFromLocal(fromAt).replace('T', ' ') : 'mm/dd/yyyy'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {lookback === 'custom' ? (
          <View style={{ marginTop: 8 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
              Uses the timezone below. Mail on or after this moment is imported.
            </Text>
            {showIosFrom && Platform.OS === 'ios' ? (
              <View>
                <DateTimePicker
                  value={fromAt || new Date()}
                  mode="datetime"
                  maximumDate={new Date()}
                  onChange={(_event, date) => {
                    if (date) applyFrom(date);
                  }}
                />
                <TouchableOpacity onPress={() => setShowIosFrom(false)}>
                  <Text style={{ color: '#0284C7', fontWeight: '700', marginTop: 6 }}>Done</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ) : null}

        <Text style={[styles.label, { color: colors.text }]}>Smart filing folders</Text>
        <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 6 }}>
          Assist files attachments into this list. You do not pick a folder. Unclear documents go to{' '}
          {fallbackFolder || 'Assist / Needs review'}. Email Replies folder selection stays as it is.
        </Text>
        {folders.map((name) => (
          <Text key={name} style={{ color: colors.text, fontSize: 13 }}>
            {name}
          </Text>
        ))}
        {callsEnabled ? (
          <Text style={{ color: colors.textSecondary, marginTop: 10, fontSize: 13 }}>
            Calls setup can wait. Finish here to start the archive and Daily Brief, then add your ring
            number in Settings and place a test call.
          </Text>
        ) : null}

        <Text style={[styles.label, { color: colors.text }]}>Daily Brief time</Text>
        <TouchableOpacity
          style={[styles.input, { borderColor: colors.border, justifyContent: 'center' }]}
          onPress={openBriefPicker}
        >
          <Text style={{ color: colors.text }}>{displayBriefTime(briefTime)}</Text>
        </TouchableOpacity>
        <Text style={{ color: colors.textSecondary, marginTop: 6, fontSize: 12 }}>
          Ready each day after this time in the timezone below. Your phone shows AM/PM or 24-hour
          based on its settings.
        </Text>
        {showIosBrief && Platform.OS === 'ios' ? (
          <View style={{ marginTop: 8 }}>
            <DateTimePicker
              value={parseBriefTime(briefTime)}
              mode="time"
              onChange={(_event, date) => {
                if (date) setBriefTime(formatBriefTime(date));
              }}
            />
            <TouchableOpacity onPress={() => setShowIosBrief(false)}>
              <Text style={{ color: '#0284C7', fontWeight: '700', marginTop: 6 }}>Done</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <Text style={[styles.label, { color: colors.text }]}>Timezone</Text>
        <TextInput
          value={timezone}
          onChangeText={setTimezone}
          style={[styles.input, { color: colors.text, borderColor: colors.border }]}
        />

        <Text style={{ color: colors.textSecondary, marginVertical: 12, fontSize: 13 }}>
          Setup creates a dedicated Assist workspace for this account. Invite helpers only into that
          workspace. Attachments are LLM-filed into a fixed folder list. Completing setup also enables
          Email Replies for this mailbox (it will not auto-send mail).
        </Text>

        <TouchableOpacity style={styles.btn} onPress={() => void finish()} disabled={saving}>
          <Text style={styles.btnText}>{saving ? 'Saving…' : 'Finish setup'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  label: { fontWeight: '700', marginTop: 14, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#E2E8F0',
  },
  chipOn: { backgroundColor: '#0284C7' },
  emptyBox: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 14,
  },
  linkBtn: {
    backgroundColor: '#0284C7',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  linkBtnText: { color: '#fff', fontWeight: '700' },
  connRow: {
    borderRadius: 10,
    padding: 12,
    backgroundColor: '#E2E8F0',
  },
  connRowOn: { backgroundColor: '#0284C7' },
  btn: {
    backgroundColor: '#0284C7',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
