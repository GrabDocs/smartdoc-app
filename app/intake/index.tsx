import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
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
  INTAKE_STATUS_LABELS,
  type Intake,
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

type ListTab = 'active' | 'archived' | 'templates';

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

  const showArchived = activeTab === 'archived';

  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const pageRef = useRef(1);
  const onEndReachedCalledDuringMomentumRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const inFlightRef = useRef(false);

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

    const cacheKey = intakesListScreenKey(user.id, archived);

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

    const fetchPage = append ? pageRef.current + 1 : 1;

    try {
      const response = await apiService.getIntakes(
        archived ? 'archived' : undefined,
        fetchPage,
        INTAKES_PAGE_SIZE,
      );
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
      console.error('Load intakes error:', error);
      if (!append && !hasLoadedRef.current) {
        Alert.alert('Error', error.message || 'Failed to load Intakes');
      }
    } finally {
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

  const loadMoreIntakes = useCallback(() => {
    if (loading || refreshing || loadingMoreRef.current || !hasMoreRef.current) return;
    void loadIntakes(showArchived, false, true);
  }, [loading, refreshing, showArchived, loadIntakes]);

  const lastLoadTimeRef = useRef<number>(0);
  const RELOAD_DEBOUNCE_MS = 2000;

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
        } else {
          void loadIntakes(showArchived);
        }
      }
    }, [user, activeTab, showArchived, loadIntakes, loadTemplates])
  );

  const handleRefresh = () => {
    if (!user) return;
    setRefreshing(true);
    if (activeTab === 'templates') {
      loadTemplates().finally(() => setRefreshing(false));
      return;
    }
    pageRef.current = 1;
    hasMoreRef.current = true;
    if (listCacheKey) screenCache.invalidate(listCacheKey);
    void loadIntakes(showArchived, true);
  };

  const handleTabChange = (tab: ListTab) => {
    setActiveTab(tab);
    if (tab === 'templates') {
      loadTemplates();
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
      marginLeft: 4,
    },
    tabButtonTextActive: {
      color: '#1D4ED8',
      fontWeight: '600',
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
        </View>
        {item.client_name && (
          <Text style={dynamicStyles.clientName} numberOfLines={1}>{item.client_name}</Text>
        )}
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

  if (loading && !hasLoaded && activeTab !== 'templates') {
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
          style={[dynamicStyles.tabButton, activeTab === 'archived' && dynamicStyles.tabButtonActive]}
          onPress={() => handleTabChange('archived')}
        >
          <Ionicons
            name="archive-outline"
            size={14}
            color={activeTab === 'archived' ? '#1D4ED8' : colors.textSecondary}
          />
          <Text style={[dynamicStyles.tabButtonText, activeTab === 'archived' && dynamicStyles.tabButtonTextActive]}>
            Archived
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[dynamicStyles.tabButton, activeTab === 'templates' && dynamicStyles.tabButtonActive]}
          onPress={() => handleTabChange('templates')}
        >
          <Ionicons
            name="copy-outline"
            size={14}
            color={activeTab === 'templates' ? '#1D4ED8' : colors.textSecondary}
          />
          <Text style={[dynamicStyles.tabButtonText, activeTab === 'templates' && dynamicStyles.tabButtonTextActive]}>
            Templates
          </Text>
        </TouchableOpacity>
      </View>

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
      ) : !hasLoaded && loading ? (
        <View style={dynamicStyles.centerContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={[dynamicStyles.loadingText, { marginTop: 12 }]}>Loading Intakes...</Text>
        </View>
      ) : intakes.length === 0 ? (
        <View style={dynamicStyles.emptyContainer}>
          <Ionicons name="clipboard-outline" size={64} color={colors.textLight} />
          <Text style={dynamicStyles.emptyTitle}>
            {showArchived ? 'No archived Intakes' : 'No Intakes yet'}
          </Text>
          {!showArchived && (
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
          )}
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
