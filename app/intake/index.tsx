import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import { intakesListScreenKey } from '../../services/userScopedCache';
import { screenCache } from '../../utils/screenCache';
import { parseUtcMs } from '../../utils/timeFormatting';
import {
  INTAKE_DUE_BADGE_LABELS,
  INTAKE_SCHEDULE_STATUS_COLORS,
  INTAKE_SCHEDULE_STATUS_LABELS,
  INTAKE_STATUS_LABELS,
  type Intake,
  type IntakeScheduleListItem,
  type IntakeStatus,
  type IntakeTemplate,
} from '../../types/intake';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

/** In-memory TTL — soft-refresh still runs on focus. */
const INTAKES_LIST_CACHE_MS = 30_000;
/** Disk cache keeps empty/list results for instant paint across cold starts. */
const INTAKES_DISK_CACHE_MS = 24 * 60 * 60_000;
const INTAKES_PAGE_SIZE = 20;

const ANDROID_TEXT_INPUT_PROPS =
  Platform.OS === 'android' ? { underlineColorAndroid: 'transparent' as const } : {};

type ListTab = 'active' | 'schedules' | 'archived' | 'templates';

const ACTIVE_STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'waiting_for_client', label: 'Waiting' },
  { value: 'in_review', label: 'In Review' },
  { value: 'completed', label: 'Completed' },
] as const;

const DUE_FILTERS = [
  { value: '', label: 'Any due' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'due_tomorrow', label: 'Tomorrow' },
  { value: 'on_track', label: 'On track' },
] as const;

const KIND_FILTERS = [
  { value: '', label: 'All types' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'one_time', label: 'One-time' },
] as const;

const SCHEDULE_STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Ended' },
] as const;

type PaginatedIntakesCache = {
  items: Intake[];
  hasMore: boolean;
  page: number;
  savedAt?: number;
};

const STATUS_COLORS: Record<IntakeStatus, { bg: string; text: string }> = {
  draft: { bg: '#E5E7EB', text: '#374151' },
  waiting_for_client: { bg: '#DBEAFE', text: '#1D4ED8' },
  in_review: { bg: '#FEF3C7', text: '#92400E' },
  completed: { bg: '#D1FAE5', text: '#065F46' },
  archived: { bg: '#E5E7EB', text: '#6B7280' },
};

const DUE_BADGE_COLORS: Record<string, { bg: string; text: string }> = {
  on_track: { bg: '#ECFDF5', text: '#047857' },
  due_tomorrow: { bg: '#FFFBEB', text: '#B45309' },
  overdue: { bg: '#FEF2F2', text: '#B91C1C' },
};

function diskCacheKey(cacheKey: string | null): string | null {
  return cacheKey ? `disk:${cacheKey}` : null;
}

async function readDiskIntakesCache(cacheKey: string | null): Promise<PaginatedIntakesCache | null> {
  const key = diskCacheKey(cacheKey);
  if (!key) return null;
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PaginatedIntakesCache;
    if (!parsed || !Array.isArray(parsed.items)) return null;
    const savedAt = parsed.savedAt ?? 0;
    if (savedAt && Date.now() - savedAt > INTAKES_DISK_CACHE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDiskIntakesCache(cacheKey: string | null, data: PaginatedIntakesCache) {
  const key = diskCacheKey(cacheKey);
  if (!key) return;
  try {
    await AsyncStorage.setItem(
      key,
      JSON.stringify({ ...data, savedAt: Date.now() }),
    );
  } catch {
    /* non-fatal */
  }
}

function timeAgo(dateString?: string | null): string | null {
  if (!dateString) return null;
  const then = parseUtcMs(dateString);
  if (isNaN(then)) return null;
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

export default function IntakeListScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const [intakes, setIntakes] = useState<Intake[]>([]);
  /** True after first successful hydrate or network response (including empty). */
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [activeTab, setActiveTab] = useState<ListTab>('active');
  const [templates, setTemplates] = useState<IntakeTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState<number | null>(null);
  const [schedules, setSchedules] = useState<IntakeScheduleListItem[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [scheduleBusyId, setScheduleBusyId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dueFilter, setDueFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');

  const showArchived = activeTab === 'archived';

  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const pageRef = useRef(1);
  const onEndReachedCalledDuringMomentumRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const inFlightRef = useRef(false);
  const loadSeqRef = useRef(0);
  const skipFilterReloadRef = useRef(true);
  const searchQueryRef = useRef('');
  const statusFilterRef = useRef('');
  const dueFilterRef = useRef('');
  const kindFilterRef = useRef('');
  searchQueryRef.current = searchQuery;
  statusFilterRef.current = statusFilter;
  dueFilterRef.current = dueFilter;
  kindFilterRef.current = kindFilter;

  const listCacheKey = intakesListScreenKey(user?.id, showArchived);

  const applyCachePayload = useCallback((cached: PaginatedIntakesCache) => {
    setIntakes(cached.items);
    setHasMore(cached.hasMore);
    hasMoreRef.current = cached.hasMore;
    pageRef.current = cached.page;
    hasLoadedRef.current = true;
    setHasLoaded(true);
    setLoading(false);
  }, []);

  const loadIntakes = useCallback(async (archived: boolean, forceRefresh = false, append = false) => {
    if (!user) {
      setLoading(false);
      return;
    }
    if (append && (!hasMoreRef.current || loadingMoreRef.current)) return;

    const q = searchQueryRef.current;
    const status = statusFilterRef.current;
    const due = dueFilterRef.current;
    const kind = kindFilterRef.current;
    const hasFilters = Boolean(
      q || (!archived && status) || (!archived && due) || (!archived && kind)
    );
    const cacheKey = hasFilters ? null : intakesListScreenKey(user.id, archived);

    // Instant paint from memory (fresh) or disk (stale-while-revalidate).
    if (!forceRefresh && !append && cacheKey) {
      const mem = screenCache.get<PaginatedIntakesCache>(cacheKey, INTAKES_LIST_CACHE_MS);
      if (mem) {
        applyCachePayload(mem);
        setRefreshing(false);
        return;
      }
      const disk = await readDiskIntakesCache(cacheKey);
      if (disk) {
        applyCachePayload(disk);
        screenCache.set(cacheKey, disk);
        // Continue to soft-revalidate below without a blocking spinner.
      }
    }

    if (append) {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else if (forceRefresh) {
      // pull-to-refresh uses `refreshing`
    } else if (!hasLoadedRef.current) {
      setLoading(true);
    }

    if (!append && inFlightRef.current) return;
    if (!append) inFlightRef.current = true;

    const seq = ++loadSeqRef.current;
    const fetchPage = append ? pageRef.current + 1 : 1;

    try {
      const response = await apiService.getIntakes(
        archived ? 'archived' : (status || undefined),
        fetchPage,
        INTAKES_PAGE_SIZE,
        {
          q: q || undefined,
          due: archived ? undefined : (due || undefined),
          kind: archived ? undefined : (kind || undefined),
        },
      );
      if (seq !== loadSeqRef.current) return;
      if (response.success) {
        const rows = (response.intakes || []) as Intake[];
        const pagination = response.pagination;
        const hasMorePage =
          pagination?.has_more === true ||
          (pagination?.has_more !== false && rows.length >= INTAKES_PAGE_SIZE);

        setIntakes((prev) => {
          const merged = append ? [...prev, ...rows] : rows;
          pageRef.current = fetchPage;
          if (!append && cacheKey) {
            const payload: PaginatedIntakesCache = {
              items: merged,
              hasMore: hasMorePage,
              page: fetchPage,
            };
            screenCache.set(cacheKey, payload);
            void writeDiskIntakesCache(cacheKey, payload);
          }
          return merged;
        });
        setHasMore(hasMorePage);
        hasMoreRef.current = hasMorePage;
        hasLoadedRef.current = true;
        setHasLoaded(true);
      } else if (!append && !hasLoadedRef.current) {
        Alert.alert('Error', response.message || 'Failed to load Intakes');
      }
    } catch (error: any) {
      if (seq !== loadSeqRef.current) return;
      console.error('Load intakes error:', error);
      if (!append && !hasLoadedRef.current) {
        Alert.alert('Error', error.message || 'Failed to load Intakes');
      }
    } finally {
      if (seq !== loadSeqRef.current) return;
      if (!append) inFlightRef.current = false;
      setLoading(false);
      setRefreshing(false);
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [user, applyCachePayload]);

  const loadTemplates = useCallback(async () => {
    if (!user) return;
    setTemplatesLoading(true);
    try {
      const response = await apiService.getIntakeTemplates();
      if (response.success) {
        setTemplates(response.templates || []);
      }
    } catch (error: any) {
      console.error('Load intake templates error:', error);
    } finally {
      setTemplatesLoading(false);
    }
  }, [user]);

  const loadSchedules = useCallback(async () => {
    if (!user) return;
    setSchedulesLoading(true);
    try {
      const response = await apiService.getIntakeSchedules();
      if (response.success) {
        setSchedules((response.schedules || []) as IntakeScheduleListItem[]);
        setSchedulesLoaded(true);
      } else {
        Alert.alert('Error', response.message || 'Failed to load schedules');
      }
    } catch (error: any) {
      console.error('Load intake schedules error:', error);
      Alert.alert('Error', error.message || 'Failed to load schedules');
    } finally {
      setSchedulesLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  const patchScheduleStatus = useCallback(
    async (scheduleId: number, status: 'active' | 'paused' | 'completed') => {
      const run = async () => {
        setScheduleBusyId(scheduleId);
        try {
          const res = await apiService.patchIntakeSchedule(scheduleId, { status });
          if (res.success) {
            await loadSchedules();
          } else {
            Alert.alert('Error', res.message || 'Could not update schedule');
          }
        } catch (e: any) {
          Alert.alert('Error', e.message || 'Could not update schedule');
        } finally {
          setScheduleBusyId(null);
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
    },
    [loadSchedules]
  );

  const loadMoreIntakes = useCallback(() => {
    if (loading || refreshing || loadingMoreRef.current || !hasMoreRef.current) return;
    void loadIntakes(showArchived, false, true);
  }, [loading, refreshing, showArchived, loadIntakes]);

  const lastLoadTimeRef = useRef<number>(0);
  const RELOAD_DEBOUNCE_MS = 2000;

  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const hasListFilters = Boolean(
    searchQuery || statusFilter || (activeTab !== 'schedules' && (dueFilter || kindFilter))
  );

  const filteredSchedules = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return schedules.filter((s) => {
      if (statusFilter && s.status !== statusFilter) return false;
      if (!q) return true;
      const hay = [s.title, s.client_name, s.client_primary_email, s.cadence_summary, s.frequency]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [schedules, searchQuery, statusFilter]);

  const resetListFilters = useCallback((opts?: { skipReload?: boolean }) => {
    const had =
      searchQueryRef.current || statusFilterRef.current || dueFilterRef.current || kindFilterRef.current;
    searchQueryRef.current = '';
    statusFilterRef.current = '';
    dueFilterRef.current = '';
    kindFilterRef.current = '';
    setSearchInput('');
    setSearchQuery('');
    setStatusFilter('');
    setDueFilter('');
    setKindFilter('');
    if (opts?.skipReload && had) skipFilterReloadRef.current = true;
  }, []);

  useEffect(() => {
    if (skipFilterReloadRef.current) {
      skipFilterReloadRef.current = false;
      return;
    }
    if (activeTab !== 'active' && activeTab !== 'archived') return;
    if (!user) return;
    pageRef.current = 1;
    hasMoreRef.current = true;
    inFlightRef.current = false;
    void loadIntakes(showArchived, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when filter values change
  }, [searchQuery, statusFilter, dueFilter, kindFilter]);

  useFocusEffect(
    useCallback(() => {
      if (!user) {
        setLoading(false);
        return;
      }
      const now = Date.now();
      if (now - lastLoadTimeRef.current > RELOAD_DEBOUNCE_MS) {
        lastLoadTimeRef.current = now;
        if (activeTab === 'templates') {
          loadTemplates();
        } else if (activeTab === 'schedules') {
          void loadSchedules();
        } else {
          void loadIntakes(showArchived);
        }
      }
    }, [user, activeTab, showArchived, loadIntakes, loadTemplates, loadSchedules])
  );

  const handleRefresh = () => {
    if (!user) return;
    setRefreshing(true);
    if (activeTab === 'templates') {
      loadTemplates().finally(() => setRefreshing(false));
      return;
    }
    if (activeTab === 'schedules') {
      void loadSchedules();
      return;
    }
    pageRef.current = 1;
    hasMoreRef.current = true;
    if (listCacheKey) screenCache.invalidate(listCacheKey);
    void loadIntakes(showArchived, true);
  };

  const handleTabChange = (tab: ListTab) => {
    resetListFilters({ skipReload: true });
    setActiveTab(tab);
    if (tab === 'templates') {
      loadTemplates();
      return;
    }
    if (tab === 'schedules') {
      setSchedulesLoaded(false);
      void loadSchedules();
      return;
    }
    const archived = tab === 'archived';
    pageRef.current = 1;
    hasMoreRef.current = true;
    setHasMore(true);

    const cacheKey = user?.id != null ? intakesListScreenKey(user.id, archived) : null;
    const mem = cacheKey
      ? screenCache.get<PaginatedIntakesCache>(cacheKey, INTAKES_LIST_CACHE_MS)
      : null;
    if (mem) {
      applyCachePayload(mem);
      return;
    }

    hasLoadedRef.current = false;
    setHasLoaded(false);
    setIntakes([]);
    setLoading(true);
    void loadIntakes(archived);
  };
  const handleDeleteTemplate = (template: IntakeTemplate) => {
    Alert.alert(
      'Delete template',
      `Delete "${template.name}"? Existing intakes are not affected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingTemplateId(template.id);
            try {
              const response = await apiService.deleteIntakeTemplate(template.id);
              if (response.success) {
                setTemplates((prev) => prev.filter((t) => t.id !== template.id));
              } else {
                Alert.alert('Error', response.message || 'Failed to delete template');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to delete template');
            } finally {
              setDeletingTemplateId(null);
            }
          },
        },
      ],
    );
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 16,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
    },
    placeholder: {
      width: 24,
    },
    tabsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
      gap: 8,
    },
    tabButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 16,
      backgroundColor: colors.surface,
    },
    tabButtonActive: {
      backgroundColor: colors.isDark ? 'rgba(59, 130, 246, 0.24)' : '#DBEAFE',
    },
    tabButtonText: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.textSecondary,
    },
    tabButtonTextActive: {
      color: '#1D4ED8',
      fontWeight: '600',
    },
    searchContainer: {
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 6,
    },
    searchInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    searchIcon: {
      marginRight: 8,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: colors.text,
      padding: 0,
      backgroundColor: 'transparent',
    },
    filterChipsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingBottom: 8,
      gap: 8,
    },
    filterChip: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 16,
      backgroundColor: colors.surface,
    },
    filterChipActive: {
      backgroundColor: colors.isDark ? 'rgba(59, 130, 246, 0.24)' : '#DBEAFE',
    },
    filterChipText: {
      fontSize: 12,
      fontWeight: '500',
      color: colors.textSecondary,
    },
    filterChipTextActive: {
      color: '#1D4ED8',
      fontWeight: '600',
    },
    clearFiltersBtn: {
      paddingHorizontal: 16,
      paddingBottom: 8,
    },
    clearFiltersText: {
      fontSize: 13,
      fontWeight: '600',
      color: '#007AFF',
    },
    centerContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      fontSize: 16,
      color: colors.textSecondary,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    emptyTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: colors.text,
      marginTop: 16,
      marginBottom: 8,
      textAlign: 'center',
    },
    emptyDescription: {
      fontSize: 15,
      color: colors.textSecondary,
      textAlign: 'center',
      marginBottom: 24,
    },
    createButton: {
      backgroundColor: '#007AFF',
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 8,
    },
    createButtonText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
    },
    listContainer: {
      padding: 16,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 3,
    },
    cardTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: 4,
    },
    cardTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      flexShrink: 1,
    },
    badge: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 12,
    },
    badgeText: {
      fontSize: 11,
      fontWeight: '600',
    },
    clientName: {
      fontSize: 13,
      color: colors.textSecondary,
      marginBottom: 8,
    },
    progressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 6,
    },
    progressBarBg: {
      flex: 1,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.surface,
      marginRight: 10,
    },
    progressBarFill: {
      height: 6,
      borderRadius: 3,
      backgroundColor: '#007AFF',
    },
    progressLabel: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    metaRow: {
      flexDirection: 'row',
      gap: 12,
    },
    metaText: {
      fontSize: 11,
      color: colors.textLight,
    },
    templateCard: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 3,
    },
    templateName: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
    },
    templateMeta: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 4,
    },
    templatePreview: {
      fontSize: 11,
      color: colors.textLight,
      marginTop: 4,
    },
    templateActions: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 12,
    },
    templateActionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: colors.surface,
      gap: 4,
    },
    templateActionPrimary: {
      backgroundColor: '#007AFF',
    },
    templateActionText: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.text,
    },
    templateActionTextPrimary: {
      color: '#fff',
    },
  }), [colors]);

  const renderIntake = ({ item }: { item: Intake }) => {
    const statusColor = STATUS_COLORS[item.status] || STATUS_COLORS.draft;
    const dueColor = item.due_badge ? DUE_BADGE_COLORS[item.due_badge] : null;
    const lastFile = timeAgo(item.last_file_received_at);
    const scheduleStatus = item.schedule?.status;
    const scheduleColor = scheduleStatus
      ? INTAKE_SCHEDULE_STATUS_COLORS[scheduleStatus] || INTAKE_SCHEDULE_STATUS_COLORS.active
      : null;
    const scheduleLabel = scheduleStatus
      ? `Scheduled · ${INTAKE_SCHEDULE_STATUS_LABELS[scheduleStatus] || scheduleStatus}`
      : null;
    const subtitle = [item.client_name, item.schedule?.cadence_summary].filter(Boolean).join(' · ');

    return (
      <TouchableOpacity style={dynamicStyles.card} onPress={() => router.push(`/intake/${item.id}`)}>
        <View style={dynamicStyles.cardTitleRow}>
          <Text style={dynamicStyles.cardTitle} numberOfLines={1} ellipsizeMode="tail">{item.title}</Text>
          <View style={[dynamicStyles.badge, { backgroundColor: statusColor.bg }]}>
            <Text style={[dynamicStyles.badgeText, { color: statusColor.text }]}>
              {INTAKE_STATUS_LABELS[item.status]}
            </Text>
          </View>
          {item.due_badge && dueColor && (
            <View style={[dynamicStyles.badge, { backgroundColor: dueColor.bg }]}>
              <Text style={[dynamicStyles.badgeText, { color: dueColor.text }]}>
                {INTAKE_DUE_BADGE_LABELS[item.due_badge]}
              </Text>
            </View>
          )}
          {scheduleLabel && scheduleColor ? (
            <View style={[dynamicStyles.badge, { backgroundColor: scheduleColor.bg }]}>
              <Text style={[dynamicStyles.badgeText, { color: scheduleColor.text }]}>
                {scheduleLabel}
              </Text>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Text style={dynamicStyles.clientName} numberOfLines={1}>{subtitle}</Text>
        ) : null}
        <View style={dynamicStyles.progressRow}>
          <View style={dynamicStyles.progressBarBg}>
            <View style={[dynamicStyles.progressBarFill, { width: `${item.progress?.percent ?? 0}%` }]} />
          </View>
          <Text style={dynamicStyles.progressLabel}>
            {item.progress?.received ?? 0}/{item.progress?.total ?? 0} &middot; {item.progress?.percent ?? 0}%
          </Text>
        </View>
        {lastFile && (
          <View style={dynamicStyles.metaRow}>
            <Text style={dynamicStyles.metaText}>Last file: {lastFile}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderSchedule = ({ item }: { item: IntakeScheduleListItem }) => {
    const statusColor =
      INTAKE_SCHEDULE_STATUS_COLORS[item.status] || INTAKE_SCHEDULE_STATUS_COLORS.completed;
    const current = item.current_collection;
    const nextLabel = item.next_run_at
      ? (() => {
          const ms = parseUtcMs(item.next_run_at);
          if (Number.isNaN(ms)) return null;
          try {
            return new Date(ms).toLocaleString();
          } catch {
            return null;
          }
        })()
      : null;
    const busy = scheduleBusyId === item.id;

    return (
      <TouchableOpacity
        style={dynamicStyles.card}
        onPress={() => router.push(`/intake/schedules/${item.id}` as any)}
      >
        <View style={dynamicStyles.cardTitleRow}>
          <Text style={dynamicStyles.cardTitle} numberOfLines={1} ellipsizeMode="tail">
            {item.title}
          </Text>
          <View style={[dynamicStyles.badge, { backgroundColor: statusColor.bg }]}>
            <Text style={[dynamicStyles.badgeText, { color: statusColor.text }]}>
              {INTAKE_SCHEDULE_STATUS_LABELS[item.status] || item.status}
            </Text>
          </View>
        </View>
        <Text style={dynamicStyles.clientName} numberOfLines={2}>
          {item.cadence_summary || item.frequency}
          {item.client_name ? ` · ${item.client_name}` : ''}
        </Text>
        {current ? (
          <Text style={dynamicStyles.metaText}>
            Current: {current.period_label || current.title}
            {current.progress ? ` — ${current.progress.percent}%` : ''}
            {current.status ? ` (${current.status})` : ''}
          </Text>
        ) : null}
        <Text style={[dynamicStyles.metaText, { marginTop: 4 }]}>
          {item.collections_count ?? 0} collection{(item.collections_count ?? 0) === 1 ? '' : 's'}
          {nextLabel ? ` · Next ${nextLabel}` : ''}
        </Text>
        {item.status !== 'completed' ? (
          <View style={dynamicStyles.templateActions}>
            {item.status === 'active' ? (
              <FeedbackTouchable
                style={dynamicStyles.templateActionBtn}
                onPress={() => void patchScheduleStatus(item.id, 'paused')}
                disabled={busy}
                loading={busy}
              >
                <Text style={dynamicStyles.templateActionText}>Pause</Text>
              </FeedbackTouchable>
            ) : null}
            {item.status === 'paused' ? (
              <FeedbackTouchable
                style={[dynamicStyles.templateActionBtn, dynamicStyles.templateActionPrimary]}
                onPress={() => void patchScheduleStatus(item.id, 'active')}
                disabled={busy}
                loading={busy}
                spinnerColor="#fff"
              >
                <Text style={[dynamicStyles.templateActionText, dynamicStyles.templateActionTextPrimary]}>
                  Resume
                </Text>
              </FeedbackTouchable>
            ) : null}
            <FeedbackTouchable
              style={dynamicStyles.templateActionBtn}
              onPress={() => void patchScheduleStatus(item.id, 'completed')}
              disabled={busy}
            >
              <Text style={[dynamicStyles.templateActionText, { color: '#B91C1C' }]}>End</Text>
            </FeedbackTouchable>
          </View>
        ) : null}
      </TouchableOpacity>
    );
  };

  const renderTemplate = ({ item }: { item: IntakeTemplate }) => (
    <View style={dynamicStyles.templateCard}>
      <Text style={dynamicStyles.templateName}>{item.name}</Text>
      {item.industry_tag && (
        <Text style={dynamicStyles.templateMeta}>{item.industry_tag}</Text>
      )}
      <Text style={dynamicStyles.templateMeta}>
        {item.items?.length ?? 0} item{(item.items?.length ?? 0) === 1 ? '' : 's'}
      </Text>
      {item.items && item.items.length > 0 && (
        <Text style={dynamicStyles.templatePreview} numberOfLines={1}>
          {item.items.slice(0, 4).map((i) => i.label).join(' · ')}
          {item.items.length > 4 ? ' …' : ''}
        </Text>
      )}
      <View style={dynamicStyles.templateActions}>
        <TouchableOpacity
          style={[dynamicStyles.templateActionBtn, dynamicStyles.templateActionPrimary]}
          onPress={() => router.push(`/intake/create?template=${item.id}`)}
        >
          <Text style={[dynamicStyles.templateActionText, dynamicStyles.templateActionTextPrimary]}>Use</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={dynamicStyles.templateActionBtn}
          onPress={() => router.push(`/intake/template/${item.id}`)}
        >
          <Ionicons name="pencil" size={14} color={colors.text} />
          <Text style={dynamicStyles.templateActionText}>Edit</Text>
        </TouchableOpacity>
        <FeedbackTouchable
          style={dynamicStyles.templateActionBtn}
          onPress={() => handleDeleteTemplate(item)}
          disabled={deletingTemplateId === item.id}
          loading={deletingTemplateId === item.id}
          spinnerColor="#FF3B30"
        >
          <Ionicons name="trash-outline" size={14} color="#FF3B30" />
        </FeedbackTouchable>
      </View>
    </View>
  );

  if (loading && !hasLoaded && activeTab !== 'templates' && activeTab !== 'schedules') {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.header}>
          <AppBackButton />
          <AppHeaderTitle>Intake</AppHeaderTitle>
          <TouchableOpacity onPress={() => router.push('/intake/create')}>
            <Ionicons name="add" size={24} color="#007AFF" />
          </TouchableOpacity>
        </View>
        <View style={dynamicStyles.tabsRow}>
          <View style={[dynamicStyles.tabButton, dynamicStyles.tabButtonActive]}>
            <Text style={[dynamicStyles.tabButtonText, dynamicStyles.tabButtonTextActive]}>Active</Text>
          </View>
        </View>
        <View style={dynamicStyles.centerContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={[dynamicStyles.loadingText, { marginTop: 12 }]}>Loading Intakes...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <View style={dynamicStyles.header}>
        <AppBackButton />
        <AppHeaderTitle>Intake</AppHeaderTitle>
        <TouchableOpacity onPress={() => router.push('/intake/create')}>
          <Ionicons name="add" size={24} color="#007AFF" />
        </TouchableOpacity>
      </View>

      <View style={dynamicStyles.tabsRow}>
        <TouchableOpacity
          style={[dynamicStyles.tabButton, activeTab === 'active' && dynamicStyles.tabButtonActive]}
          onPress={() => handleTabChange('active')}
        >
          <Text style={[dynamicStyles.tabButtonText, activeTab === 'active' && dynamicStyles.tabButtonTextActive]}>
            Active
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[dynamicStyles.tabButton, activeTab === 'schedules' && dynamicStyles.tabButtonActive]}
          onPress={() => handleTabChange('schedules')}
        >
          <Text style={[dynamicStyles.tabButtonText, activeTab === 'schedules' && dynamicStyles.tabButtonTextActive]}>
            Schedules
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[dynamicStyles.tabButton, activeTab === 'archived' && dynamicStyles.tabButtonActive]}
          onPress={() => handleTabChange('archived')}
        >
          <Text style={[dynamicStyles.tabButtonText, activeTab === 'archived' && dynamicStyles.tabButtonTextActive]}>
            Archived
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[dynamicStyles.tabButton, activeTab === 'templates' && dynamicStyles.tabButtonActive]}
          onPress={() => handleTabChange('templates')}
        >
          <Text style={[dynamicStyles.tabButtonText, activeTab === 'templates' && dynamicStyles.tabButtonTextActive]}>
            Templates
          </Text>
        </TouchableOpacity>
      </View>

      {activeTab !== 'templates' ? (
        <View>
          <View style={dynamicStyles.searchContainer}>
            <View style={dynamicStyles.searchInputContainer}>
              <Ionicons name="search" size={18} color={colors.textSecondary} style={dynamicStyles.searchIcon} />
              <TextInput
                {...ANDROID_TEXT_INPUT_PROPS}
                style={dynamicStyles.searchInput}
                placeholder={
                  activeTab === 'schedules'
                    ? 'Filter schedules by title or client…'
                    : 'Filter by title, client, or upload code…'
                }
                placeholderTextColor={colors.textSecondary}
                value={searchInput}
                onChangeText={setSearchInput}
                returnKeyType="search"
                onSubmitEditing={() => Keyboard.dismiss()}
              />
              {searchInput.length > 0 ? (
                <TouchableOpacity
                  onPress={() => {
                    setSearchInput('');
                    setSearchQuery('');
                    searchQueryRef.current = '';
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
          {activeTab === 'schedules' ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={dynamicStyles.filterChipsRow}
            >
              {SCHEDULE_STATUS_FILTERS.map((opt) => {
                const selected = statusFilter === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value || 'all'}
                    style={[dynamicStyles.filterChip, selected && dynamicStyles.filterChipActive]}
                    onPress={() => setStatusFilter(opt.value)}
                  >
                    <Text style={[dynamicStyles.filterChipText, selected && dynamicStyles.filterChipTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : activeTab === 'active' ? (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={dynamicStyles.filterChipsRow}
              >
                {ACTIVE_STATUS_FILTERS.map((opt) => {
                  const selected = statusFilter === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value || 'all'}
                      style={[dynamicStyles.filterChip, selected && dynamicStyles.filterChipActive]}
                      onPress={() => setStatusFilter(opt.value)}
                    >
                      <Text style={[dynamicStyles.filterChipText, selected && dynamicStyles.filterChipTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={dynamicStyles.filterChipsRow}
              >
                {DUE_FILTERS.map((opt) => {
                  const selected = dueFilter === opt.value;
                  return (
                    <TouchableOpacity
                      key={`due-${opt.value || 'all'}`}
                      style={[dynamicStyles.filterChip, selected && dynamicStyles.filterChipActive]}
                      onPress={() => setDueFilter(opt.value)}
                    >
                      <Text style={[dynamicStyles.filterChipText, selected && dynamicStyles.filterChipTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                {KIND_FILTERS.map((opt) => {
                  const selected = kindFilter === opt.value;
                  return (
                    <TouchableOpacity
                      key={`kind-${opt.value || 'all'}`}
                      style={[dynamicStyles.filterChip, selected && dynamicStyles.filterChipActive]}
                      onPress={() => setKindFilter(opt.value)}
                    >
                      <Text style={[dynamicStyles.filterChipText, selected && dynamicStyles.filterChipTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </>
          ) : null}
          {hasListFilters ? (
            <TouchableOpacity style={dynamicStyles.clearFiltersBtn} onPress={() => resetListFilters()}>
              <Text style={dynamicStyles.clearFiltersText}>Clear filters</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {activeTab === 'templates' ? (
        templatesLoading && templates.length === 0 ? (
          <View style={dynamicStyles.centerContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
          </View>
        ) : templates.length === 0 ? (
          <View style={dynamicStyles.emptyContainer}>
            <Ionicons name="documents-outline" size={64} color={colors.textLight} />
            <Text style={dynamicStyles.emptyTitle}>No saved templates yet</Text>
            <Text style={dynamicStyles.emptyDescription}>
              Build a checklist on New Intake or an existing intake, then choose Template.
            </Text>
            <TouchableOpacity
              style={dynamicStyles.createButton}
              onPress={() => router.push('/intake/create')}
            >
              <Text style={dynamicStyles.createButtonText}>New Intake</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={templates}
            renderItem={renderTemplate}
            keyExtractor={(item) => `template-${item.id}`}
            contentContainerStyle={dynamicStyles.listContainer}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#007AFF" />
            }
            showsVerticalScrollIndicator={false}
          />
        )
      ) : activeTab === 'schedules' ? (
        schedulesLoading && !schedulesLoaded ? (
          <View style={dynamicStyles.centerContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={[dynamicStyles.loadingText, { marginTop: 12 }]}>Loading schedules...</Text>
          </View>
        ) : schedules.length === 0 ? (
          <View style={dynamicStyles.emptyContainer}>
            <Ionicons name="calendar-outline" size={64} color={colors.textLight} />
            <Text style={dynamicStyles.emptyTitle}>No schedules yet</Text>
            <Text style={dynamicStyles.emptyDescription}>
              Create an Intake with Repeat or a future Start date to schedule recurring Collections.
            </Text>
            <TouchableOpacity
              style={dynamicStyles.createButton}
              onPress={() => router.push('/intake/create')}
            >
              <Text style={dynamicStyles.createButtonText}>New Intake</Text>
            </TouchableOpacity>
          </View>
        ) : filteredSchedules.length === 0 ? (
          <View style={dynamicStyles.emptyContainer}>
            <Ionicons name="calendar-outline" size={64} color={colors.textLight} />
            <Text style={dynamicStyles.emptyTitle}>No matching schedules</Text>
            <Text style={dynamicStyles.emptyDescription}>
              Try a different search or clear the filters.
            </Text>
            <TouchableOpacity style={dynamicStyles.createButton} onPress={() => resetListFilters()}>
              <Text style={dynamicStyles.createButtonText}>Clear filters</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={filteredSchedules}
            renderItem={renderSchedule}
            keyExtractor={(item) => `schedule-${item.id}`}
            contentContainerStyle={dynamicStyles.listContainer}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#007AFF" />
            }
            showsVerticalScrollIndicator={false}
          />
        )
      ) : !hasLoaded && loading ? (
        <View style={dynamicStyles.centerContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={[dynamicStyles.loadingText, { marginTop: 12 }]}>Loading Intakes...</Text>
        </View>
      ) : intakes.length === 0 ? (
        <View style={dynamicStyles.emptyContainer}>
          <Ionicons name="clipboard-outline" size={64} color={colors.textLight} />
          <Text style={dynamicStyles.emptyTitle}>
            {hasListFilters
              ? 'No matching Intakes'
              : showArchived
                ? 'No archived Intakes'
                : 'No Intakes yet'}
          </Text>
          {hasListFilters ? (
            <>
              <Text style={dynamicStyles.emptyDescription}>
                Try a different search or clear the filters.
              </Text>
              <TouchableOpacity style={dynamicStyles.createButton} onPress={() => resetListFilters()}>
                <Text style={dynamicStyles.createButtonText}>Clear filters</Text>
              </TouchableOpacity>
            </>
          ) : !showArchived ? (
            <>
              <Text style={dynamicStyles.emptyDescription}>
                Create a checklist, send the link, and let GrabDocs chase the missing documents for you.
              </Text>
              <TouchableOpacity
                style={dynamicStyles.createButton}
                onPress={() => router.push('/intake/create')}
              >
                <Text style={dynamicStyles.createButtonText}>Create Your First Intake</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={intakes}
          renderItem={renderIntake}
          keyExtractor={(item) => `intake-${item.id}`}
          contentContainerStyle={dynamicStyles.listContainer}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#007AFF" />
          }
          onEndReached={loadMoreIntakes}
          onEndReachedThreshold={0.4}
          onMomentumScrollBegin={() => {
            onEndReachedCalledDuringMomentumRef.current = false;
          }}
          ListFooterComponent={
            loadingMore ? (
              <View style={{ paddingVertical: 16 }}>
                <ActivityIndicator size="small" color="#007AFF" />
              </View>
            ) : null
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}
