import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import GeneralFileViewerModal from '../../components/GeneralFileViewerModal';
import MinimizableBottomSheet from '../../components/MinimizableBottomSheet';
import { API_BASE_URL } from '../../constants/Config';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  addBriefItemToCalendar,
  archiveCursorsActive,
  generateTodayBrief,
  getBriefItemSource,
  getTodayBrief,
  patchBriefItem,
  summarizeArchiveSync,
  type AssistBriefItem,
} from '../../services/assistApi';
import { isNetworkError } from '../../utils/networkErrors';
import { trackRecentApp } from '../../utils/recentApps';

function itemHasOpenableSource(item: AssistBriefItem): boolean {
  return (item.source_refs || []).some((r) =>
    ['email', 'call', 'file'].includes(String(r?.kind || '')),
  );
}

function briefGenerateErrorMessage(error: any): string {
  if (isNetworkError(error)) {
    return 'No connection. Connect to the internet and try again.';
  }
  const reason = error?.response?.data?.reason || error?.response?.data?.error;
  if (reason === 'paused_credits') return 'Not enough AI credits to build today’s brief.';
  if (reason === 'llm_unavailable' || reason === 'llm_failed') {
    return 'Could not build the brief right now. Try again in a moment.';
  }
  if (reason === 'setup_incomplete') return 'Finish Assist setup before generating a brief.';
  return error?.response?.data?.message || 'Could not generate today’s brief.';
}

const LIST_PREVIEW = 5;

const TYPE_STYLES: Record<string, { bg: string; fg: string }> = {
  todo: { bg: '#E0F2FE', fg: '#075985' },
  appointment: { bg: '#EDE9FE', fg: '#5B21B6' },
  commitment_by_me: { bg: '#FEF3C7', fg: '#92400E' },
  commitment_to_me: { bg: '#FFEDD5', fg: '#9A3412' },
  bill_payment: { bg: '#D1FAE5', fg: '#065F46' },
  call_followup: { bg: '#FFE4E6', fg: '#9F1239' },
};

type SectionKey = 'new_today' | 'still_open' | 'done' | 'dismissed';

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
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [syncActive, setSyncActive] = useState(false);
  const [setupCompleted, setSetupCompleted] = useState(true);
  const [canGenerateBrief, setCanGenerateBrief] = useState(false);
  const [canRegenerateBrief, setCanRegenerateBrief] = useState(false);
  const [needsBriefRefresh, setNeedsBriefRefresh] = useState(false);
  const [generatingBrief, setGeneratingBrief] = useState(false);
  const [counts, setCounts] = useState({ new_today: 0, still_open: 0, done: 0 });
  const [newToday, setNewToday] = useState<AssistBriefItem[]>([]);
  const [stillOpen, setStillOpen] = useState<AssistBriefItem[]>([]);
  const [done, setDone] = useState<AssistBriefItem[]>([]);
  const [dismissed, setDismissed] = useState<AssistBriefItem[]>([]);
  const [doneOpen, setDoneOpen] = useState(false);
  const [dismissedOpen, setDismissedOpen] = useState(false);
  const [callsEnabled, setCallsEnabled] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sectionPanel, setSectionPanel] = useState<{
    key: SectionKey;
    title: string;
    items: AssistBriefItem[];
  } | null>(null);
  const [sourcePanel, setSourcePanel] = useState<AssistSourceContent | null>(null);
  const [fileViewer, setFileViewer] = useState<{
    visible: boolean;
    fileId: number;
    title: string;
    pdfUri: string | null;
    expandNonce: number;
  }>({ visible: false, fileId: 0, title: 'Document', pdfUri: null, expandNonce: 0 });
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
    setSyncStatus(summarizeArchiveSync(cursors));
    setSyncActive(archiveCursorsActive(cursors));
    setSetupCompleted(Boolean(brief?.setup_completed));
    setCallsEnabled(Boolean(brief?.calls_enabled));
    setCanGenerateBrief(Boolean(brief?.can_generate) && !brief?.brief);
    setCanRegenerateBrief(Boolean(brief?.can_regenerate) && Boolean(brief?.brief));
    setNeedsBriefRefresh(Boolean(brief?.needs_refresh));
  }, []);

  const loadBrief = useCallback(async () => {
    const brief = await getTodayBrief(ownerId);
    applyBriefShell(brief);
    // Only clear when the API explicitly says setup is incomplete (avoid zeroing Done on partial/odd payloads).
    if (brief && brief.setup_completed === false) {
      setNewToday([]);
      setStillOpen([]);
      setDone([]);
      setDismissed([]);
      setCounts({ new_today: 0, still_open: 0, done: 0 });
      return brief;
    }
    setCounts(brief?.counts || { new_today: 0, still_open: 0, done: 0 });
    setNewToday(brief?.items?.new_today || []);
    setStillOpen(brief?.items?.still_open || []);
    setDone(brief?.items?.done || []);
    setDismissed(brief?.items?.dismissed || []);
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
        Alert.alert('Daily Brief', briefGenerateErrorMessage({ response: { data: res } }));
        return;
      }
      await loadBrief();
    } catch (e: any) {
      Alert.alert('Daily Brief', briefGenerateErrorMessage(e));
    } finally {
      setGeneratingBrief(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    if (!setupCompleted || !syncActive || ownerId) return undefined;
    const timer = setInterval(() => {
      void loadBrief().catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, [setupCompleted, syncActive, ownerId, loadBrief]);

  const allItems = useMemo(
    () => [...newToday, ...stillOpen, ...done, ...dismissed],
    [newToday, stillOpen, done, dismissed],
  );

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
  const filteredDismissed = useMemo(() => filterItems(dismissed), [filterItems, dismissed]);

  const removeFromSectionPanel = (id: number) => {
    setSectionPanel((prev) =>
      prev ? { ...prev, items: prev.items.filter((i) => i.id !== id) } : null,
    );
  };

  const reopenItem = async (item: AssistBriefItem) => {
    try {
      await patchBriefItem(item.id, { status: 'open' }, ownerId);
      setSectionPanel((prev) =>
        prev ? { ...prev, items: prev.items.filter((i) => i.id !== item.id) } : null,
      );
      await loadBrief();
    } catch {
      Alert.alert('Daily Brief', 'Could not reopen that item.');
    }
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
      // Prefer the email body in-app over opening an attachment download in Chrome.
      const email = sources.find((s: any) => s.kind === 'email');
      if (email) {
        setSourcePanel({ type: 'email', email });
        return;
      }
      const file = sources.find((s: any) => s.kind === 'file' && (s.file_url || s.id));
      if (file?.file_url || file?.id) {
        const path = String(file.file_url || '');
        const pdfUri = path
          ? path.startsWith('http')
            ? path
            : `${String(API_BASE_URL || '').replace(/\/$/, '')}${path}`
          : null;
        setFileViewer((prev) => ({
          visible: true,
          fileId: Number(file.id) || 0,
          title: file.filename || item.title || 'Document',
          pdfUri,
          expandNonce: prev.expandNonce + 1,
        }));
        return;
      }
      setSourcePanel({
        type: 'message',
        title: item.title || 'Source',
        body: 'No email or call is linked to this item.',
      });
    } catch (e: any) {
      setSourcePanel({
        type: 'message',
        title: 'Source',
        body: isNetworkError(e)
          ? 'No connection. Connect to the internet and try again.'
          : 'Could not load the source for this item.',
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
    if (!editTitle.trim()) {
      Alert.alert('Edit item', 'Title is required.');
      return;
    }
    try {
      await patchBriefItem(
        editing.id,
        {
          title: editTitle.trim(),
          detail: editDetail,
          due_at: editDue.trim() ? editDue.trim() : null,
        },
        ownerId,
      );
      setEditing(null);
      await loadBrief();
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        (e?.response?.data?.error === 'title_required' ? 'Title is required.' : null) ||
        'Could not save the edit.';
      Alert.alert('Assist', msg);
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
                {itemHasOpenableSource(item) ? (
                  <TouchableOpacity onPress={() => void openSource(item)}>
                    <Text style={styles.action}>Source</Text>
                  </TouchableOpacity>
                ) : null}
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
              <>
                {item.status === 'done' || item.status === 'dismissed' ? (
                  <TouchableOpacity onPress={() => void reopenItem(item)}>
                    <Text style={styles.action}>
                      {item.status === 'dismissed' ? 'Undo dismiss' : 'Reopen'}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {itemHasOpenableSource(item) ? (
                  <TouchableOpacity onPress={() => void openSource(item)}>
                    <Text style={styles.action}>Source</Text>
                  </TouchableOpacity>
                ) : null}
              </>
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
    const open = key === 'dismissed' ? dismissedOpen : doneOpen;
    const setOpen = key === 'dismissed' ? setDismissedOpen : setDoneOpen;
    const collapsed = collapsible && !open;
    const preview = items.slice(0, LIST_PREVIEW);
    const hasMore = items.length > LIST_PREVIEW;

    return (
      <View style={{ marginBottom: 8 }}>
        <View style={styles.sectionHeader}>
          {collapsible ? (
            <TouchableOpacity onPress={() => setOpen((v) => !v)} style={{ flex: 1 }}>
              <Text style={[styles.section, { color: colors.text }]}>
                {title} {open ? '▾' : '▸'} ({items.length})
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
          {syncStatus ? (
            <View
              style={{
                backgroundColor: syncActive ? '#F0F9FF' : '#ECFDF5',
                borderRadius: 12,
                padding: 12,
                marginBottom: 12,
                borderWidth: 1,
                borderColor: syncActive ? '#BAE6FD' : '#A7F3D0',
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '700', marginBottom: 4 }}>
                {syncActive ? 'Syncing mailbox' : 'Mailbox connected'}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{syncStatus}</Text>
            </View>
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
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 12 }}>
            {canGenerateBrief
              ? 'Open items stay visible until today’s brief runs. New finds appear after sync or Generate.'
              : 'Counts are for today’s Daily Brief (account timezone).'}
          </Text>

          <View style={styles.navRow}>
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

          {canGenerateBrief || canRegenerateBrief ? (
            <View style={{ marginBottom: 16 }}>
              <Text style={{ color: colors.textSecondary, marginBottom: 8 }}>
                {canGenerateBrief
                  ? syncActive
                    ? 'Today’s brief is not ready yet. Your open items stay listed below while archive sync continues — generate now, or wait for the scheduled brief.'
                    : 'Today’s brief is not ready yet. Your open items stay listed below — generate now to pull new finds from mail, calls, and calendar, or wait for the scheduled brief.'
                  : needsBriefRefresh
                    ? 'Mailbox changed since this brief was built. Regenerate to pull follow-ups from the current mailbox.'
                    : 'Refresh today’s brief from yesterday and today’s archived mail, calls, and calendar.'}
              </Text>
              <TouchableOpacity
                style={[styles.primaryBtn, generatingBrief ? { opacity: 0.6 } : null]}
                disabled={generatingBrief}
                onPress={() => void runGenerateBrief()}
              >
                {generatingBrief ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>
                    {canGenerateBrief ? 'Generate today’s brief' : 'Regenerate today’s brief'}
                  </Text>
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
          {renderSection('done', 'Done', filteredDone, 'No checked-off items yet.', true)}
          {renderSection(
            'dismissed',
            'Dismissed',
            filteredDismissed,
            'No dismissed items.',
            true,
          )}
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

      <GeneralFileViewerModal
        visible={fileViewer.visible}
        expandNonce={fileViewer.expandNonce}
        fileId={fileViewer.fileId}
        title={fileViewer.title}
        pdfUri={fileViewer.pdfUri}
        onClose={() => setFileViewer((s) => ({ ...s, visible: false }))}
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
