import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderIcon, { appHeaderActionsStyle, appHeaderButtonStyle } from '../../components/AppHeaderIcon';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  addBriefItemToCalendar,
  generateTodayBrief,
  getAssistStatus,
  getBriefItemSource,
  getTodayBrief,
  patchBriefItem,
  type AssistBriefItem,
} from '../../services/assistApi';
import { trackRecentApp } from '../../utils/recentApps';

function suggestedCalendarStart(dueAt?: string | null): Date {
  if (dueAt) {
    const d = new Date(dueAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(0);
  d.setHours(d.getHours() + 1);
  return d;
}

function formatWhenLabel(date: Date): string {
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function AssistTodayScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ owner_user_id?: string }>();
  const ownerId = params.owner_user_id ? Number(params.owner_user_id) : undefined;
  const colors = useThemeColors();
  const [loading, setLoading] = useState(true);
  const [mailboxIssue, setMailboxIssue] = useState<string | null>(null);
  const [setupCompleted, setSetupCompleted] = useState(true);
  const [canGenerateBrief, setCanGenerateBrief] = useState(false);
  const [generatingBrief, setGeneratingBrief] = useState(false);
  const [counts, setCounts] = useState({ new_today: 0, still_open: 0, done: 0 });
  const [newToday, setNewToday] = useState<AssistBriefItem[]>([]);
  const [stillOpen, setStillOpen] = useState<AssistBriefItem[]>([]);
  const [done, setDone] = useState<AssistBriefItem[]>([]);
  const [doneOpen, setDoneOpen] = useState(false);
  const [callsEnabled, setCallsEnabled] = useState(false);
  const [editing, setEditing] = useState<AssistBriefItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDetail, setEditDetail] = useState('');
  const [editDue, setEditDue] = useState('');
  const [calendarItem, setCalendarItem] = useState<AssistBriefItem | null>(null);
  const [calStart, setCalStart] = useState(() => suggestedCalendarStart());
  const [calEnd, setCalEnd] = useState(() => {
    const s = suggestedCalendarStart();
    return new Date(s.getTime() + 60 * 60 * 1000);
  });
  const [calAllDay, setCalAllDay] = useState(false);
  const [calSaving, setCalSaving] = useState(false);
  const [showIosCalStart, setShowIosCalStart] = useState(false);
  const [showIosCalEnd, setShowIosCalEnd] = useState(false);
  const [calDueHint, setCalDueHint] = useState(false);

  useEffect(() => {
    void trackRecentApp('assist');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const status = await getAssistStatus(ownerId);
      const cursors = status?.cursors || [];
      const bad = cursors.find((c: any) =>
        ['paused_disconnected', 'error_auth'].includes(c.status),
      );
      setMailboxIssue(
        bad?.status === 'error_auth'
          ? 'Mailbox needs reconnect before Assist can keep syncing.'
          : bad
            ? 'Mailbox is disconnected. Assist archive is kept. Reconnect on the Email Replies mailbox page.'
            : null,
      );
      setSetupCompleted(Boolean(status?.setup_completed));
      setCallsEnabled(Boolean(status?.calls_enabled));
      if (!status?.setup_completed) {
        setNewToday([]);
        setStillOpen([]);
        setDone([]);
        setCanGenerateBrief(false);
        return;
      }
      const brief = await getTodayBrief(ownerId);
      setCounts(brief?.counts || { new_today: 0, still_open: 0, done: 0 });
      setNewToday(brief?.items?.new_today || []);
      setStillOpen(brief?.items?.still_open || []);
      setDone(brief?.items?.done || []);
      setCanGenerateBrief(Boolean(brief?.can_generate) && !brief?.brief);
    } catch {
      /* keep */
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  const runGenerateBrief = async () => {
    if (generatingBrief || ownerId) return;
    setGeneratingBrief(true);
    try {
      const res = await generateTodayBrief();
      if (res?.ok === false) {
        const reason = res?.reason || 'failed';
        Alert.alert(
          'Daily Brief',
          reason === 'paused_credits'
            ? 'Not enough AI credits to build today’s brief.'
            : reason === 'llm_unavailable' || reason === 'llm_failed'
              ? 'Could not build the brief right now. Try again in a moment.'
              : 'Could not generate today’s brief.',
        );
        return;
      }
      await load();
    } catch {
      Alert.alert('Daily Brief', 'Could not generate today’s brief.');
    } finally {
      setGeneratingBrief(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const markDone = async (item: AssistBriefItem) => {
    try {
      await patchBriefItem(item.id, { status: 'done' }, ownerId);
      await load();
    } catch {
      /* ignore */
    }
  };

  const dismiss = async (item: AssistBriefItem) => {
    try {
      await patchBriefItem(item.id, { status: 'dismissed' }, ownerId);
      await load();
    } catch {
      Alert.alert('Assist', 'Could not dismiss this item.');
    }
  };

  const openSource = async (item: AssistBriefItem) => {
    try {
      const res = await getBriefItemSource(item.id, ownerId);
      const sources = res?.sources || [];
      if (!sources.length) {
        Alert.alert('No source', 'This item does not have an email or call attached.');
        return;
      }
      const call = sources.find((s: any) => s.kind === 'call');
      if (call?.id) {
        router.push(`/assist/calls/${call.id}` as any);
        return;
      }
      const file = sources.find((s: any) => s.kind === 'file' && s.file_url);
      if (file?.file_url) {
        const base = String(apiClient.client.defaults.baseURL || '').replace(/\/$/, '');
        await Linking.openURL(`${base}${file.file_url}`);
        return;
      }
      const email = sources.find((s: any) => s.kind === 'email');
      if (email) {
        Alert.alert(email.subject || 'Email', (email.body_text || 'No body stored.').slice(0, 800));
      }
    } catch {
      Alert.alert('Assist', 'Could not open the source.');
    }
  };

  const openCalendarSheet = (item: AssistBriefItem) => {
    const start = suggestedCalendarStart(item.due_at);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    setCalStart(start);
    setCalEnd(end);
    setCalAllDay(false);
    setCalDueHint(Boolean(item.due_at));
    setShowIosCalStart(false);
    setShowIosCalEnd(false);
    setCalendarItem(item);
  };

  const openCalPicker = (which: 'start' | 'end') => {
    const current = which === 'start' ? calStart : calEnd;
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: current,
        mode: 'date',
        onChange: (event, date) => {
          if (event?.type !== 'set' || !date) return;
          DateTimePickerAndroid.open({
            value: date,
            mode: 'time',
            is24Hour: false,
            onChange: (timeEvent, time) => {
              const merged = new Date(date);
              if (timeEvent?.type === 'set' && time) {
                merged.setHours(time.getHours(), time.getMinutes(), 0, 0);
              }
              if (which === 'start') {
                setCalStart(merged);
                setCalEnd((prev) => (prev <= merged ? new Date(merged.getTime() + 60 * 60 * 1000) : prev));
              } else {
                setCalEnd(merged);
              }
            },
          });
        },
      });
      return;
    }
    if (which === 'start') setShowIosCalStart(true);
    else setShowIosCalEnd(true);
  };

  const confirmCalendar = async () => {
    if (!calendarItem || calSaving) return;
    if (!calAllDay && calEnd <= calStart) {
      Alert.alert('Calendar', 'End must be after start.');
      return;
    }
    setCalSaving(true);
    try {
      const end = calAllDay ? calStart : calEnd;
      const res = await addBriefItemToCalendar(calendarItem.id, ownerId, {
        start_time: calStart.toISOString(),
        end_time: end.toISOString(),
        all_day: calAllDay,
      });
      setCalendarItem(null);
      Alert.alert(
        'Calendar',
        res?.deduped
          ? res?.message || 'This item is already on your calendar for that date and time.'
          : 'Added to your calendar.',
      );
      await load();
    } catch (e: any) {
      const code = e?.response?.data?.error;
      const message = e?.response?.data?.message || 'Could not add this item.';
      if (code === 'calendar_connect_required' || code === 'calendar_unavailable') {
        Alert.alert('Calendar', message, [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open calendar', onPress: () => router.push('/calendar' as any) },
        ]);
        return;
      }
      Alert.alert('Calendar', message);
    } finally {
      setCalSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await patchBriefItem(editing.id, {
        title: editTitle,
        detail: editDetail,
        due_at: editDue.trim() ? editDue.trim() : null,
      }, ownerId);
      setEditing(null);
      await load();
    } catch {
      Alert.alert('Assist', 'Could not save the edit.');
    }
  };

  const renderItem = (item: AssistBriefItem) => (
    <View key={item.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.type, { color: colors.textSecondary }]}>{item.item_type}</Text>
        <Text style={[styles.title, { color: colors.text }]}>{item.title}</Text>
        {!!item.detail && (
          <Text style={[styles.detail, { color: colors.textSecondary }]} numberOfLines={3}>
            {item.detail}
          </Text>
        )}
        {item.status === 'open' ? (
          <View style={styles.actionRow}>
            <TouchableOpacity onPress={() => void markDone(item)}>
              <Text style={styles.action}>Check off</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void dismiss(item)}>
              <Text style={styles.action}>Dismiss</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void openSource(item)}>
              <Text style={styles.action}>Source</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setEditing(item);
                setEditTitle(item.title);
                setEditDetail(item.detail || '');
                setEditDue(item.due_at || '');
              }}
            >
              <Text style={styles.action}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => openCalendarSheet(item)}>
              <Text style={styles.action}>Add to calendar</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle title="Assist" />
        <View style={appHeaderActionsStyle}>
          <AppHeaderIcon
            name="chatbubbles-outline"
            onPress={() =>
              router.push(
                (ownerId ? { pathname: '/assist/ask', params: { owner_user_id: String(ownerId) } } : '/assist/ask') as any,
              )
            }
            style={appHeaderButtonStyle}
          />
          {ownerId ? null : (
            <AppHeaderIcon
              name="settings-outline"
              onPress={() => router.push('/assist/settings' as any)}
              style={appHeaderButtonStyle}
            />
          )}
        </View>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#0284C7" />
      ) : !setupCompleted ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>Finish Assist setup</Text>
          <Text style={{ color: colors.textSecondary, marginBottom: 16, textAlign: 'center' }}>
            Connect your mailbox, pick a look-back period, and turn on Daily Brief.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.push('/assist/setup' as any)}
          >
            <Text style={styles.primaryBtnText}>Continue setup</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
        >
          {mailboxIssue ? (
            <TouchableOpacity
              disabled={Boolean(ownerId)}
              onPress={() => router.push('/email-sync/mailbox' as any)}
              style={{ backgroundColor: '#FEF3C7', borderRadius: 12, padding: 12, marginBottom: 12 }}
            >
              <Text style={{ color: '#92400E', fontWeight: '700' }}>{mailboxIssue}</Text>
              {ownerId ? null : (
                <Text style={{ color: '#92400E', marginTop: 4 }}>Open mailbox</Text>
              )}
            </TouchableOpacity>
          ) : null}
          <View style={styles.strip}>
            <View style={styles.stat}>
              <Text style={styles.statNum}>{counts.new_today}</Text>
              <Text style={styles.statLabel}>New today</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statNum}>{counts.still_open}</Text>
              <Text style={styles.statLabel}>Still open</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statNum}>{counts.done}</Text>
              <Text style={styles.statLabel}>Done</Text>
            </View>
          </View>

          <View style={styles.navRow}>
            <TouchableOpacity
              style={styles.navChip}
              onPress={() =>
                router.push(
                  (ownerId
                    ? { pathname: '/assist/ask', params: { owner_user_id: String(ownerId) } }
                    : '/assist/ask') as any,
                )
              }
            >
              <Text style={styles.navChipText}>Ask</Text>
            </TouchableOpacity>
            {callsEnabled ? (
              <TouchableOpacity
                style={styles.navChip}
                onPress={() =>
                  router.push(
                    (ownerId
                      ? { pathname: '/assist/calls', params: { owner_user_id: String(ownerId) } }
                      : '/assist/calls') as any,
                  )
                }
              >
                <Text style={styles.navChipText}>Calls</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.navChip} onPress={() => router.push('/assist/people' as any)}>
              <Text style={styles.navChipText}>People</Text>
            </TouchableOpacity>
          </View>

          {canGenerateBrief ? (
            <View style={{ marginBottom: 16 }}>
              <Text style={{ color: colors.textSecondary, marginBottom: 8 }}>
                Today’s brief is not ready yet. Build it from yesterday and today’s archived mail,
                calls, and calendar.
              </Text>
              <TouchableOpacity
                style={[styles.primaryBtn, generatingBrief ? { opacity: 0.6 } : null]}
                disabled={generatingBrief}
                onPress={() => void runGenerateBrief()}
              >
                {generatingBrief ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>Generate today’s brief</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : null}

          <Text style={[styles.section, { color: colors.text }]}>New today</Text>
          {newToday.length === 0 ? (
            <Text style={{ color: colors.textSecondary, marginBottom: 12 }}>Nothing new yet.</Text>
          ) : (
            newToday.map(renderItem)
          )}

          <Text style={[styles.section, { color: colors.text }]}>Still open</Text>
          {stillOpen.length === 0 ? (
            <Text style={{ color: colors.textSecondary, marginBottom: 12 }}>All clear.</Text>
          ) : (
            stillOpen.map(renderItem)
          )}

          <TouchableOpacity onPress={() => setDoneOpen((v) => !v)}>
            <Text style={[styles.section, { color: colors.text }]}>
              Done {doneOpen ? '▾' : '▸'} ({done.length})
            </Text>
          </TouchableOpacity>
          {doneOpen ? done.map(renderItem) : null}
        </ScrollView>
      )}
      {editing ? (
        <View style={[styles.editor, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 8 }}>Edit item</Text>
          <TextInput
            value={editTitle}
            onChangeText={setEditTitle}
            placeholder="Title"
            placeholderTextColor={colors.textSecondary}
            style={[styles.editInput, { color: colors.text, borderColor: colors.border }]}
          />
          <TextInput
            value={editDetail}
            onChangeText={setEditDetail}
            placeholder="Description"
            placeholderTextColor={colors.textSecondary}
            multiline
            style={[styles.editInput, { color: colors.text, borderColor: colors.border, minHeight: 72 }]}
          />
          <TextInput
            value={editDue}
            onChangeText={setEditDue}
            placeholder="Date (YYYY-MM-DD or leave blank)"
            placeholderTextColor={colors.textSecondary}
            style={[styles.editInput, { color: colors.text, borderColor: colors.border }]}
          />
          <View style={styles.actionRow}>
            <TouchableOpacity onPress={() => void saveEdit()}>
              <Text style={styles.action}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEditing(null)}>
              <Text style={styles.action}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
      {calendarItem ? (
        <View style={[styles.editor, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 4 }}>Add to calendar</Text>
          <Text style={{ color: colors.text, marginBottom: 8 }} numberOfLines={2}>
            {calendarItem.title}
          </Text>
          {calDueHint ? (
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 8 }}>
              Suggested from the item due date — change if needed.
            </Text>
          ) : (
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 8 }}>
              Choose when this should appear on your calendar.
            </Text>
          )}
          <View style={styles.calRow}>
            <Text style={{ color: colors.text, flex: 1 }}>All day</Text>
            <Switch value={calAllDay} onValueChange={setCalAllDay} />
          </View>
          <TouchableOpacity
            style={[styles.editInput, { borderColor: colors.border }]}
            onPress={() => openCalPicker('start')}
          >
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Starts</Text>
            <Text style={{ color: colors.text, fontWeight: '600' }}>{formatWhenLabel(calStart)}</Text>
          </TouchableOpacity>
          {showIosCalStart && Platform.OS === 'ios' ? (
            <DateTimePicker
              value={calStart}
              mode="datetime"
              onChange={(_e, date) => {
                if (!date) return;
                setCalStart(date);
                setCalEnd((prev) => (prev <= date ? new Date(date.getTime() + 60 * 60 * 1000) : prev));
              }}
            />
          ) : null}
          {!calAllDay ? (
            <>
              <TouchableOpacity
                style={[styles.editInput, { borderColor: colors.border }]}
                onPress={() => openCalPicker('end')}
              >
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Ends</Text>
                <Text style={{ color: colors.text, fontWeight: '600' }}>{formatWhenLabel(calEnd)}</Text>
              </TouchableOpacity>
              {showIosCalEnd && Platform.OS === 'ios' ? (
                <DateTimePicker
                  value={calEnd}
                  mode="datetime"
                  onChange={(_e, date) => {
                    if (date) setCalEnd(date);
                  }}
                />
              ) : null}
            </>
          ) : null}
          <View style={styles.actionRow}>
            <TouchableOpacity disabled={calSaving} onPress={() => void confirmCalendar()}>
              {calSaving ? (
                <ActivityIndicator color="#0284C7" />
              ) : (
                <Text style={styles.action}>Add event</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity disabled={calSaving} onPress={() => setCalendarItem(null)}>
              <Text style={styles.action}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    justifyContent: 'space-between',
  },
  strip: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  stat: {
    flex: 1,
    backgroundColor: '#E0F2FE',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
  },
  statNum: { fontSize: 22, fontWeight: '700', color: '#0369A1' },
  statLabel: { fontSize: 12, color: '#0369A1', marginTop: 2 },
  navRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  navChip: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  navChipText: { color: '#fff', fontWeight: '600' },
  section: { fontSize: 17, fontWeight: '700', marginTop: 8, marginBottom: 8 },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
  },
  type: { fontSize: 11, textTransform: 'uppercase', marginBottom: 2 },
  title: { fontSize: 16, fontWeight: '600' },
  detail: { fontSize: 13, marginTop: 4 },
  checkBtn: { padding: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  primaryBtn: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700' },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 },
  action: { color: '#0284C7', fontWeight: '700', fontSize: 13 },
  editor: { borderTopWidth: 1, padding: 16 },
  editInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  calRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
});
