import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import AskHistoryPanel from '../../components/assist/AskHistoryPanel';
import AssistSourceSheet, {
  type AssistSourceContent,
} from '../../components/assist/AssistSourceSheet';
import MinimizableBottomSheet from '../../components/MinimizableBottomSheet';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import {
  addBriefItemToCalendar,
  generateTodayBrief,
  getBriefItemSource,
  getTodayBrief,
  patchBriefItem,
  type AssistBriefItem,
} from '../../services/assistApi';
import { trackRecentApp } from '../../utils/recentApps';

const LIST_PREVIEW = 5;

const TYPE_STYLES: Record<string, { bg: string; fg: string }> = {
  todo: { bg: '#E0F2FE', fg: '#075985' },
  appointment: { bg: '#EDE9FE', fg: '#5B21B6' },
  commitment_by_me: { bg: '#FEF3C7', fg: '#92400E' },
  commitment_to_me: { bg: '#FFEDD5', fg: '#9A3412' },
  bill_payment: { bg: '#D1FAE5', fg: '#065F46' },
  call_followup: { bg: '#FFE4E6', fg: '#9F1239' },
};

type SectionKey = 'new_today' | 'still_open' | 'done';

function typeLabel(raw: string): string {
  return (raw || 'todo').replace(/_/g, ' ');
}

function typeStyle(raw: string) {
  return TYPE_STYLES[raw] || { bg: '#F3F4F6', fg: '#374151' };
}

function formatDue(due?: string | null): string | null {
  if (!due) return null;
  try {
    const d = new Date(due);
    if (Number.isNaN(d.getTime())) return String(due).slice(0, 10);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return String(due).slice(0, 10);
  }
}

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

function dueInputValue(due?: string | null): string {
  if (!due) return '';
  try {
    const d = new Date(due);
    if (Number.isNaN(d.getTime())) return String(due).slice(0, 10);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  } catch {
    return String(due).slice(0, 10);
  }
}

export default function AssistTodayScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ owner_user_id?: string; ask?: string }>();
  const ownerId = params.owner_user_id ? Number(params.owner_user_id) : undefined;
  const colors = useThemeColors();
  const [askOpen, setAskOpen] = useState(false);
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
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sectionPanel, setSectionPanel] = useState<{
    key: SectionKey;
    title: string;
    items: AssistBriefItem[];
  } | null>(null);
  const [sourcePanel, setSourcePanel] = useState<AssistSourceContent | null>(null);
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

  useEffect(() => {
    if (params.ask === '1' || params.ask === 'true') {
      setAskOpen(true);
      router.setParams({ ask: undefined } as any);
    }
  }, [params.ask]);

  const applyBriefShell = useCallback((brief: any) => {
    const cursors = brief?.cursors || [];
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
    setSetupCompleted(Boolean(brief?.setup_completed));
    setCallsEnabled(Boolean(brief?.calls_enabled));
    setCanGenerateBrief(Boolean(brief?.can_generate) && !brief?.brief);
  }, []);

  const loadBrief = useCallback(async () => {
    const brief = await getTodayBrief(ownerId);
    applyBriefShell(brief);
    if (!brief?.setup_completed) {
      setNewToday([]);
      setStillOpen([]);
      setDone([]);
      setCounts({ new_today: 0, still_open: 0, done: 0 });
      return brief;
    }
    setCounts(brief?.counts || { new_today: 0, still_open: 0, done: 0 });
    setNewToday(brief?.items?.new_today || []);
    setStillOpen(brief?.items?.still_open || []);
    setDone(brief?.items?.done || []);
    return brief;
  }, [applyBriefShell, ownerId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await loadBrief();
    } catch {
      /* keep */
    } finally {
      setLoading(false);
    }
  }, [loadBrief]);

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
      await loadBrief();
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

  const allItems = useMemo(() => [...newToday, ...stillOpen, ...done], [newToday, stillOpen, done]);

  const availableTypes = useMemo(() => {
    const set = new Set<string>();
    for (const it of allItems) {
      if (it.item_type) set.add(it.item_type);
    }
    return Array.from(set).sort();
  }, [allItems]);

  const filterItems = useCallback(
    (items: AssistBriefItem[]) =>
      typeFilter === 'all' ? items : items.filter((i) => i.item_type === typeFilter),
    [typeFilter],
  );

  const filteredNew = useMemo(() => filterItems(newToday), [filterItems, newToday]);
  const filteredOpen = useMemo(() => filterItems(stillOpen), [filterItems, stillOpen]);
  const filteredDone = useMemo(() => filterItems(done), [filterItems, done]);

  const removeFromSectionPanel = (id: number) => {
    setSectionPanel((prev) =>
      prev ? { ...prev, items: prev.items.filter((i) => i.id !== id) } : null,
    );
  };

  const markDone = async (item: AssistBriefItem) => {
    try {
      await patchBriefItem(item.id, { status: 'done' }, ownerId);
      removeFromSectionPanel(item.id);
      await loadBrief();
    } catch {
      /* ignore */
    }
  };

  const dismiss = async (item: AssistBriefItem) => {
    try {
      await patchBriefItem(item.id, { status: 'dismissed' }, ownerId);
      removeFromSectionPanel(item.id);
      await loadBrief();
    } catch {
      Alert.alert('Assist', 'Could not dismiss this item.');
    }
  };

  const openSource = async (item: AssistBriefItem) => {
    try {
      const res = await getBriefItemSource(item.id, ownerId);
      const sources = res?.sources || [];
      const call = sources.find((s: any) => s.kind === 'call');
      if (call?.id) {
        router.push(
          (ownerId
            ? { pathname: `/assist/calls/${call.id}`, params: { owner_user_id: String(ownerId) } }
            : `/assist/calls/${call.id}`) as any,
        );
        return;
      }
      const file = sources.find((s: any) => s.kind === 'file' && s.file_url);
      if (file?.file_url) {
        const base = String(apiClient.client.defaults.baseURL || '').replace(/\/$/, '');
        const url = String(file.file_url).startsWith('http')
          ? String(file.file_url)
          : `${base}${file.file_url}`;
        await Linking.openURL(url);
        return;
      }
      const email = sources.find((s: any) => s.kind === 'email');
      if (email) {
        setSourcePanel({ type: 'email', email });
        return;
      }
      setSourcePanel({
        type: 'message',
        title: item.title || 'Source',
        body: 'This item does not have an email or call attached.',
      });
    } catch {
      setSourcePanel({
        type: 'message',
        title: 'Source',
        body: 'Could not load the source for this item.',
      });
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

  const openEdit = (item: AssistBriefItem) => {
    setEditing(item);
    setEditTitle(item.title);
    setEditDetail(item.detail || '');
    setEditDue(dueInputValue(item.due_at));
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
      await loadBrief();
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
      await patchBriefItem(
        editing.id,
        {
          title: editTitle,
          detail: editDetail,
          due_at: editDue.trim() ? editDue.trim() : null,
        },
        ownerId,
      );
      setEditing(null);
      await loadBrief();
    } catch {
      Alert.alert('Assist', 'Could not save the edit.');
    }
  };

  const renderItem = (item: AssistBriefItem) => {
    const due = formatDue(item.due_at);
    const chip = typeStyle(item.item_type);
    return (
      <View
        key={item.id}
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.cardTop}>
          <View style={styles.cardLeft}>
            <View style={styles.chipRow}>
              <View style={[styles.chip, { backgroundColor: chip.bg }]}>
                <Text style={[styles.chipText, { color: chip.fg }]}>{typeLabel(item.item_type)}</Text>
              </View>
              {due ? (
                <Text style={[styles.due, { color: colors.textSecondary }]}>Due {due}</Text>
              ) : null}
            </View>
            <Text style={[styles.title, { color: colors.text }]}>{item.title}</Text>
            {!!item.detail && (
              <Text style={[styles.detail, { color: colors.textSecondary }]}>{item.detail}</Text>
            )}
          </View>
          <View style={styles.actionCol}>
            {item.status === 'open' ? (
              <>
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
                  accessibilityLabel="Edit"
                  accessibilityHint="Change this item’s title, notes, or due date. Does not edit the original email."
                  onPress={() => openEdit(item)}
                >
                  <Text style={styles.action}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => openCalendarSheet(item)}>
                  <Text style={styles.action}>Add to calendar</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity onPress={() => void openSource(item)}>
                <Text style={styles.action}>Source</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  };

  const renderSection = (
    key: SectionKey,
    title: string,
    items: AssistBriefItem[],
    empty: string,
    collapsible = false,
  ) => {
    const collapsed = collapsible && !doneOpen;
    const preview = items.slice(0, LIST_PREVIEW);
    const hasMore = items.length > LIST_PREVIEW;

    return (
      <View style={{ marginBottom: 8 }}>
        <View style={styles.sectionHeader}>
          {collapsible ? (
            <TouchableOpacity onPress={() => setDoneOpen((v) => !v)} style={{ flex: 1 }}>
              <Text style={[styles.section, { color: colors.text }]}>
                {title} {doneOpen ? '▾' : '▸'} ({items.length})
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={[styles.section, { color: colors.text, flex: 1 }]}>
              {title}{' '}
              <Text style={{ fontWeight: '500', color: colors.textSecondary }}>({items.length})</Text>
            </Text>
          )}
          {hasMore && !collapsed ? (
            <TouchableOpacity onPress={() => setSectionPanel({ key, title, items })}>
              <Text style={styles.viewAll}>View all</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {collapsed ? null : items.length ? (
          <>
            {preview.map(renderItem)}
            {hasMore ? (
              <TouchableOpacity
                style={styles.viewAllBtn}
                onPress={() => setSectionPanel({ key, title, items })}
              >
                <Text style={styles.viewAll}>View all {items.length} items</Text>
              </TouchableOpacity>
            ) : null}
          </>
        ) : (
          <Text style={{ color: colors.textSecondary, marginBottom: 12 }}>{empty}</Text>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Assist</AppHeaderTitle>
        <View style={appHeaderActionsStyle}>
          <TouchableOpacity
            style={appHeaderButtonStyle}
            onPress={() => setAskOpen(true)}
            accessibilityLabel="Ask"
            accessibilityRole="button"
          >
            <AppHeaderIcon name="chatbubbles-outline" color="#007AFF" />
          </TouchableOpacity>
          {ownerId ? null : (
            <TouchableOpacity
              style={appHeaderButtonStyle}
              onPress={() => router.push('/assist/settings' as any)}
              accessibilityLabel="Settings"
              accessibilityRole="button"
            >
              <AppHeaderIcon name="settings-outline" color="#007AFF" />
            </TouchableOpacity>
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
            <TouchableOpacity style={styles.navChip} onPress={() => setAskOpen(true)}>
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

          {availableTypes.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterRow}
              style={{ marginBottom: 12 }}
            >
              <TouchableOpacity
                onPress={() => setTypeFilter('all')}
                style={[
                  styles.filterChip,
                  typeFilter === 'all' ? styles.filterChipActive : { backgroundColor: colors.card },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: typeFilter === 'all' ? '#fff' : colors.text },
                  ]}
                >
                  All
                </Text>
              </TouchableOpacity>
              {availableTypes.map((t) => {
                const active = typeFilter === t;
                const chip = typeStyle(t);
                return (
                  <TouchableOpacity
                    key={t}
                    onPress={() => setTypeFilter(t)}
                    style={[
                      styles.filterChip,
                      active ? styles.filterChipActive : { backgroundColor: chip.bg },
                    ]}
                  >
                    <Text
                      style={[
                        styles.filterChipText,
                        { color: active ? '#fff' : chip.fg, textTransform: 'capitalize' },
                      ]}
                    >
                      {typeLabel(t)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : null}

          {renderSection('new_today', 'New today', filteredNew, 'Nothing new yet.')}
          {renderSection('still_open', 'Still open', filteredOpen, 'All clear.')}
          {renderSection('done', 'Done', filteredDone, 'No completed items yet.', true)}
        </ScrollView>
      )}

      <MinimizableBottomSheet
        visible={Boolean(sectionPanel)}
        onClose={() => setSectionPanel(null)}
        title={sectionPanel?.title || ''}
        subtitle={
          sectionPanel
            ? `${sectionPanel.items.length} item${sectionPanel.items.length === 1 ? '' : 's'}`
            : undefined
        }
        heightRatio={0.9}
        minimizable={false}
      >
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 28 }}>
          {sectionPanel?.items.length ? (
            sectionPanel.items.map(renderItem)
          ) : (
            <Text style={{ color: colors.textSecondary }}>No items left in this list.</Text>
          )}
        </ScrollView>
      </MinimizableBottomSheet>

      <MinimizableBottomSheet
        visible={Boolean(editing)}
        onClose={() => setEditing(null)}
        title="Edit item"
        subtitle="Updates this Assist follow-up only. The source email is unchanged."
        heightRatio={0.72}
        minimizable={false}
      >
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 28 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 4 }}>Title</Text>
          <TextInput
            value={editTitle}
            onChangeText={setEditTitle}
            placeholder="Title"
            placeholderTextColor={colors.textSecondary}
            style={[styles.editInput, { color: colors.text, borderColor: colors.border }]}
          />
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 4 }}>Notes</Text>
          <TextInput
            value={editDetail}
            onChangeText={setEditDetail}
            placeholder="Description"
            placeholderTextColor={colors.textSecondary}
            multiline
            style={[styles.editInput, { color: colors.text, borderColor: colors.border, minHeight: 72 }]}
          />
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 4 }}>Due date</Text>
          <TextInput
            value={editDue}
            onChangeText={setEditDue}
            placeholder="YYYY-MM-DD or leave blank"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Due date"
            accessibilityHint="Optional due date for this follow-up. Used as the suggested start when you add it to calendar."
            style={[styles.editInput, { color: colors.text, borderColor: colors.border }]}
          />
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 12 }}>
            Optional. Suggested date when you add this item to calendar. Leave blank for no due date.
          </Text>
          <View style={styles.actionRow}>
            <TouchableOpacity onPress={() => void saveEdit()}>
              <Text style={styles.action}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEditing(null)}>
              <Text style={styles.action}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </MinimizableBottomSheet>

      <MinimizableBottomSheet
        visible={Boolean(calendarItem)}
        onClose={() => !calSaving && setCalendarItem(null)}
        title="Add to calendar"
        subtitle={calendarItem?.title}
        heightRatio={0.72}
        minimizable={false}
      >
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 28 }}>
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
        </ScrollView>
      </MinimizableBottomSheet>

      <AssistSourceSheet
        visible={Boolean(sourcePanel)}
        content={sourcePanel}
        onClose={() => setSourcePanel(null)}
      />

      <AskHistoryPanel
        visible={askOpen}
        onClose={() => setAskOpen(false)}
        ownerUserId={ownerId}
      />
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
  navRow: { flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
  navChip: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  navChipText: { color: '#fff', fontWeight: '600' },
  filterRow: { gap: 8, paddingRight: 8 },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  filterChipActive: { backgroundColor: '#0284C7' },
  filterChipText: { fontSize: 12, fontWeight: '700' },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    marginBottom: 8,
  },
  section: { fontSize: 17, fontWeight: '700' },
  viewAll: { color: '#0284C7', fontWeight: '700', fontSize: 13 },
  viewAllBtn: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#BAE6FD',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    marginBottom: 8,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardLeft: { flex: 1, minWidth: 0 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 4 },
  chip: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  chipText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  due: { fontSize: 12 },
  title: { fontSize: 16, fontWeight: '600' },
  detail: { fontSize: 13, marginTop: 4 },
  actionCol: { alignItems: 'flex-end', gap: 8, flexShrink: 0, maxWidth: '42%' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  primaryBtn: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700' },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 8 },
  action: { color: '#0284C7', fontWeight: '700', fontSize: 13 },
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
