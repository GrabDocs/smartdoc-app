import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  flattenPendingAttentionTasks,
  formatPendingTaskDue,
  itemHref,
  loadPendingTasksPage,
  peekPendingTasksCache,
  seedPendingTasksCache,
  type AttentionQueueItem,
  type PendingAttentionTask,
} from '../../services/clientsApi';
import { floatingDialogSurfaceStyle, modalScrimOverlayStyle } from '../../utils/dialogSurfaceStyles';

type Scope = 'all' | 'us' | 'client';

export default function PendingTasksModal({
  visible,
  onClose,
  seedItems,
}: {
  visible: boolean;
  onClose: () => void;
  seedItems: AttentionQueueItem[];
}) {
  const router = useRouter();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [items, setItems] = useState<AttentionQueueItem[]>(seedItems);
  const [hasMore, setHasMore] = useState(true);
  const [totalCount, setTotalCount] = useState(seedItems.length);
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  const onEndReachedDuringMomentum = useRef(true);
  hasMoreRef.current = hasMore;

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 200);
    return () => clearTimeout(t);
  }, [searchInput]);

  const applyCache = useCallback((seed: AttentionQueueItem[]) => {
    seedPendingTasksCache('all', seed);
    const cached = peekPendingTasksCache('all');
    if (cached) {
      setItems(cached.items);
      setHasMore(cached.hasMore);
      setTotalCount(cached.totalCount);
      return cached;
    }
    setItems(seed);
    setHasMore(true);
    setTotalCount(seed.length);
    return null;
  }, []);

  const loadMore = useCallback(async (reset = false) => {
    if (loadingMoreRef.current) return;
    if (!reset && !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    if (reset) setLoading(true);
    else setLoadingMore(true);
    try {
      const page = await loadPendingTasksPage('all', { reset });
      setItems(page.items);
      setHasMore(page.hasMore);
      setTotalCount(page.totalCount);
    } finally {
      loadingMoreRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      setSearchInput('');
      setQ('');
      setScope('all');
      return;
    }
    const cached = applyCache(seedItems);
    const needsFirstPage = !cached || (cached.hasMore && cached.items.length < 20);
    if (needsFirstPage) void loadMore(!cached);
    // Seed is read when the modal opens; cache covers later visits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, applyCache, loadMore]);

  const tasks = useMemo(() => flattenPendingAttentionTasks(items), [items]);
  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return tasks.filter((t) => {
      if (scope !== 'all' && t.waitingOn !== scope) return false;
      if (!needle) return true;
      return (
        t.label.toLowerCase().includes(needle) ||
        t.clientName.toLowerCase().includes(needle)
      );
    });
  }, [tasks, q, scope]);

  useEffect(() => {
    if (!visible || !q || loadingMoreRef.current || !hasMoreRef.current) return;
    if (filtered.length >= 12) return;
    void loadMore(false);
  }, [visible, q, filtered.length, loadMore]);

  const openTask = useCallback(
    (task: PendingAttentionTask) => {
      const href =
        itemHref(task.item_type, task.item_id, {
          parentId: task.parent_id,
          sourceType: task.source_type,
          sourceId: task.source_id,
        }) || (`/clients/${task.clientId}` as any);
      onClose();
      router.push(href as any);
    },
    [onClose, router],
  );

  const renderItem = useCallback(
    ({ item: task }: { item: PendingAttentionTask }) => {
      const onUs = task.waitingOn === 'us';
      const dot = task.overdue ? '#EF4444' : onUs ? '#3B82F6' : '#F59E0B';
      const dueLabel = formatPendingTaskDue(task.due_at);
      return (
        <TouchableOpacity onPress={() => openTask(task)} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={2}>
              {task.label}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
              {task.clientName}
              {dueLabel ? ` · Due ${dueLabel}` : ''}
            </Text>
          </View>
          <View
            style={[
              styles.pill,
              {
                backgroundColor: task.overdue
                  ? colors.isDark
                    ? 'rgba(239,68,68,0.2)'
                    : '#FEE2E2'
                  : onUs
                    ? colors.isDark
                      ? 'rgba(59,130,246,0.2)'
                      : '#DBEAFE'
                    : colors.isDark
                      ? 'rgba(245,158,11,0.2)'
                      : '#FEF3C7',
              },
            ]}
          >
            <Text
              style={{
                fontSize: 10,
                fontWeight: '700',
                color: task.overdue ? '#B91C1C' : onUs ? '#1D4ED8' : '#B45309',
              }}
            >
              {task.overdue ? 'OVERDUE' : onUs ? 'ON US' : 'ON CLIENT'}
            </Text>
          </View>
        </TouchableOpacity>
      );
    },
    [colors, openTask],
  );

  const subtitle =
    loading && tasks.length === 0
      ? 'Loading…'
      : hasMore
        ? `${filtered.length} shown · more available`
        : `${filtered.length} open ${filtered.length === 1 ? 'item' : 'items'}${
            totalCount > filtered.length ? ` · ${totalCount} clients` : ''
          }`;

  const scopes: { id: Scope; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'us', label: 'On us' },
    { id: 'client', label: 'On client' },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={modalScrimOverlayStyle(colors.isDark, styles.overlay)}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View
          style={[
            styles.sheet,
            floatingDialogSurfaceStyle(colors, colors.isDark, { borderRadius: 16 }),
            { paddingBottom: 8 + insets.bottom },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.title, { color: colors.text }]}>Pending tasks</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>{subtitle}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.toolbar}>
            <View style={[styles.search, { backgroundColor: colors.surface }]}>
              <Ionicons name="search" size={16} color={colors.textSecondary} />
              <TextInput
                style={[styles.searchInput, { color: colors.text }]}
                value={searchInput}
                onChangeText={setSearchInput}
                placeholder="Search tasks or clients…"
                placeholderTextColor={colors.textSecondary}
                returnKeyType="search"
              />
            </View>
            <View style={styles.scopeRow}>
              {scopes.map((tab) => {
                const active = scope === tab.id;
                return (
                  <TouchableOpacity
                    key={tab.id}
                    onPress={() => setScope(tab.id)}
                    style={[
                      styles.scopeChip,
                      { backgroundColor: active ? '#0D9488' : colors.surface },
                    ]}
                  >
                    <Text style={{ color: active ? '#fff' : colors.text, fontSize: 12, fontWeight: '600' }}>
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {loading && tasks.length === 0 ? (
            <View style={{ paddingVertical: 40 }}>
              <ActivityIndicator color="#0D9488" />
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.key}
              renderItem={renderItem}
              style={styles.list}
              contentContainerStyle={
                filtered.length === 0
                  ? { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 16 }
                  : { paddingHorizontal: 8, paddingBottom: 8 }
              }
              keyboardShouldPersistTaps="handled"
              initialNumToRender={12}
              maxToRenderPerBatch={10}
              windowSize={8}
              removeClippedSubviews
              onEndReachedThreshold={0.4}
              onMomentumScrollBegin={() => {
                onEndReachedDuringMomentum.current = false;
              }}
              onEndReached={() => {
                if (onEndReachedDuringMomentum.current) return;
                onEndReachedDuringMomentum.current = true;
                void loadMore(false);
              }}
              ListEmptyComponent={
                <View style={{ alignItems: 'center', paddingVertical: 28 }}>
                  <Text style={{ color: colors.text, fontWeight: '600' }}>No pending tasks</Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 4, textAlign: 'center' }}>
                    {q ? 'Try a different search.' : 'Everything looks on track.'}
                  </Text>
                </View>
              }
              ListFooterComponent={
                loadingMore ? (
                  <View style={{ paddingVertical: 12 }}>
                    <ActivityIndicator size="small" color="#0D9488" />
                  </View>
                ) : null
              }
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    justifyContent: 'flex-end',
    padding: 12,
  },
  sheet: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    height: '86%',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 18, fontWeight: '700' },
  toolbar: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 14, padding: 0 },
  scopeRow: { flexDirection: 'row', gap: 8 },
  scopeChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 12,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, marginTop: 2 },
});
