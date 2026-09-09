import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Dimensions,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  type ViewStyle,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import FileNameText from '../FileNameText';
import { useDraftsSplitOptional } from '../../contexts/DraftsSplitContext';
import { useOpenChatGD } from '../../contexts/ChatGDSheetContext';
import { useScrollRestoresHeaderProps } from '../../contexts/HeaderVisibilityContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { toAlertMessage } from '../../utils/alertUtils';
import {
  anchoredPopoverCardStyle,
  anchoredPopoverOverlayStyle,
} from '../../utils/dialogSurfaceStyles';
import { sanitizeDisplayFilename } from '../../utils/displayFilename';
import { createUntitledDraft, type DraftListItem } from '../../utils/createUntitledDraft';
import {
  flattenVisibleDrafts,
  groupDraftsForList,
} from '../../utils/draftListOrdering';
import { CachedDraftMeta, draftsCache, isNetworkError } from '../../utils/draftsCache';
import { flushAllPendingDraftOps } from '../../utils/draftsOfflineSync';
import { saveLastOpenedDraft } from '../../utils/lastOpenedDraft';
import { parseAsUTC, parseUtcMs } from '../../utils/timeFormatting';
import { AnimatedHeaderContainer } from '../../app/components/AnimatedHeaderContainer';
import { TapToToggleHeaderView } from '../../app/components/TapToToggleHeaderView';
import { useAuth } from '../../app/context/auth';

import AppBackButton from '../AppBackButton';
import AppHeaderTitle from '../AppHeaderTitle';

const CHATGD_PLACEHOLDER_FROM_DRAFTS = 'Ask about your notes';

function stripExtension(name?: string): string {
  if (!name) return 'Untitled Note';
  return sanitizeDisplayFilename(name).replace(/\.[^./\\]+$/, '');
}

function getSectionLabel(key: string): string {
  if (key === 'today') return 'Today';
  if (key === 'yesterday') return 'Yesterday';
  if (key === 'last7') return 'Previous 7 Days';
  if (key === 'last30') return 'Previous 30 Days';
  if (key.startsWith('month-')) {
    const parts = key.split('-');
    return new Date(parseInt(parts[1], 10), parseInt(parts[2], 10) - 1, 1).toLocaleString('default', {
      month: 'long',
      year: 'numeric',
    });
  }
  return key;
}

function formatItemDate(draft: DraftListItem, sectionKey: string): string {
  const raw = draft.updated_at || draft.created_at;
  if (!raw) return '';
  const date = parseAsUTC(raw);
  if (sectionKey === 'today') {
    return date.toLocaleTimeString('default', { hour: 'numeric', minute: '2-digit' });
  }
  if (sectionKey === 'yesterday') return 'Yesterday';
  if (sectionKey === 'last7') {
    return date.toLocaleDateString('default', { weekday: 'long' });
  }
  if (sectionKey === 'last30') {
    return date.toLocaleDateString('default', { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface DraftsListPaneProps {
  mode: 'phone' | 'split';
  width?: number;
  style?: ViewStyle;
}

export default function DraftsListPane({ mode, width, style }: DraftsListPaneProps) {
  const router = useRouter();
  const openChatGD = useOpenChatGD();
  const split = useDraftsSplitOptional();
  const { user } = useAuth();
  const colors = useThemeColors();
  const isDarkMode = colors.isDark;
  const scrollRestoresHeaderProps = useScrollRestoresHeaderProps();
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isOffline, setIsOffline] = useState(false);
  const draftSwipeRefs = useRef<Map<number, Swipeable>>(new Map());
  const moreButtonRef = useRef<View>(null);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState({ top: 0, right: 0 });
  const userId = user?.id;
  const isFocusedRef = useRef(false);
  const hasShownDraftsRef = useRef(false);

  const isSplitMode = mode === 'split';
  const selectedDraftId = isSplitMode ? split?.selectedDraftId ?? null : null;

  const loadDrafts = useCallback(async (options?: { background?: boolean }) => {
    if (!userId) return;
    const background = options?.background ?? false;

    const cached = await draftsCache.getDraftsList(userId);
    if (cached && cached.length > 0) {
      setDrafts(cached as DraftListItem[]);
      hasShownDraftsRef.current = true;
      if (!background) setLoading(false);
    } else if (!background) {
      setLoading(true);
    }

    try {
      await flushAllPendingDraftOps(userId);

      const res = await apiClient.getDrafts();
      const list = (res as { drafts?: DraftListItem[] })?.drafts ?? (res?.data?.drafts ?? []) ?? [];
      const serverDrafts: DraftListItem[] = Array.isArray(list) ? list : [];
      const refreshedCache = await draftsCache.getDraftsList(userId);
      const localDrafts = (refreshedCache || []).filter((d) => draftsCache.isLocalDraftId(d.id)) as DraftListItem[];
      const serverIds = new Set(serverDrafts.map((d) => d.id));
      const localOnly = localDrafts.filter((d) => !serverIds.has(d.id));
      const merged = [...serverDrafts, ...localOnly].sort((a, b) => {
        const ta = parseUtcMs(a.updated_at || a.created_at || 0);
        const tb = parseUtcMs(b.updated_at || b.created_at || 0);
        return tb - ta;
      });

      setDrafts(merged);
      hasShownDraftsRef.current = merged.length > 0;
      setIsOffline(false);
      await draftsCache.saveDraftsList(userId, merged as CachedDraftMeta[]);
    } catch (e: unknown) {
      if (isNetworkError(e)) {
        setIsOffline(true);
        if (!cached || cached.length === 0) {
          setDrafts([]);
        }
      } else {
        console.error('Failed to load drafts:', e);
        if (!cached) setDrafts([]);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      if (isSplitMode) return;
      isFocusedRef.current = true;
      loadDrafts({ background: hasShownDraftsRef.current });
      return () => {
        isFocusedRef.current = false;
      };
    }, [loadDrafts, isSplitMode]),
  );

  useEffect(() => {
    if (!isSplitMode) return;
    loadDrafts({ background: hasShownDraftsRef.current });
    isFocusedRef.current = true;
    return () => {
      isFocusedRef.current = false;
    };
  }, [loadDrafts, isSplitMode]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && isFocusedRef.current) {
        loadDrafts({ background: true });
      }
    });
    return () => sub.remove();
  }, [loadDrafts]);

  const filteredDrafts = useMemo(() => {
    if (!searchQuery.trim()) return drafts;
    const query = searchQuery.toLowerCase().trim();
    return drafts.filter((draft) => {
      const filename = (draft.original_filename || '').toLowerCase();
      const createdFrom = (draft.json_data?.created_from || '').toLowerCase();
      return filename.includes(query) || createdFrom.includes(query);
    });
  }, [drafts, searchQuery]);

  const grouped = useMemo(() => {
    return groupDraftsForList(filteredDrafts).map((g) => ({
      ...g,
      label: getSectionLabel(g.key),
    }));
  }, [filteredDrafts]);

  useEffect(() => {
    if (!split || !isSplitMode) return;
    split.registerListSnapshot(() => flattenVisibleDrafts(filteredDrafts));
    return () => split.registerListSnapshot(null);
  }, [split, isSplitMode, filteredDrafts]);

  useEffect(() => {
    if (!split || !isSplitMode) return;
    split.registerListRefresh(() => loadDrafts({ background: true }));
    return () => split.registerListRefresh(null);
  }, [split, isSplitMode, loadDrafts]);

  const onRefresh = () => {
    setRefreshing(true);
    loadDrafts({ background: true });
  };

  const handleNewDraft = async () => {
    if (creating || !userId) return;
    setCreating(true);
    try {
      if (split) {
        await split.createAndOpenNewDraft(drafts, setDrafts, { forceOffline: isOffline });
      } else {
        const result = await createUntitledDraft(userId, drafts, { forceOffline: isOffline });
        if (result) {
          setDrafts(result.updatedList);
          await saveLastOpenedDraft(userId, result.id);
          router.push(`/drafts/edit/${result.id}`);
        }
      }
    } finally {
      setCreating(false);
    }
  };

  const handleOpenDraft = (draft: DraftListItem) => {
    if (userId) void saveLastOpenedDraft(userId, draft.id);
    if (split) {
      split.openDraft(draft.id);
    } else {
      router.push(`/drafts/edit/${draft.id}`);
    }
  };

  const handleMoreOptions = useCallback(() => {
    moreButtonRef.current?.measureInWindow((x, y, w, height) => {
      const screenWidth = Dimensions.get('window').width;
      setMenuAnchor({ top: y + height + 6, right: screenWidth - x - w });
      setMenuVisible(true);
    });
  }, []);

  const performDeleteDraft = useCallback(
    async (draft: DraftListItem) => {
      if (!userId) return;
      const snapshot = flattenVisibleDrafts(filteredDrafts);
      const ref = draftSwipeRefs.current.get(draft.id);
      try {
        if (draftsCache.isLocalDraftId(draft.id)) {
          await draftsCache.removePendingCreate(userId, draft.id);
          await draftsCache.removePendingSave(userId, draft.id);
          await draftsCache.removePendingRename(userId, draft.id);
          await draftsCache.removeFromDraftsList(userId, draft.id);
          await draftsCache.deleteDraftContent(userId, draft.id);
        } else {
          await apiClient.deleteDraft(draft.id);
          await draftsCache.removePendingSave(userId, draft.id);
          await draftsCache.removePendingRename(userId, draft.id);
          await draftsCache.removeFromDraftsList(userId, draft.id);
          await draftsCache.deleteDraftContent(userId, draft.id);
        }
        setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
        ref?.close();
        split?.handleDeleteNavigation(draft.id, { snapshot });
      } catch (e: unknown) {
        const err = e as { message?: string; response?: { data?: { message?: string } } };
        Alert.alert('Error', toAlertMessage(err?.message ?? err?.response?.data?.message, 'Could not delete note'));
        ref?.close();
      }
    },
    [userId, split, filteredDrafts],
  );

  const confirmDeleteDraft = useCallback(
    (draft: DraftListItem) => {
      Alert.alert(
        'Move to Trash?',
        'You can restore this note within 30 days from Deleted Notes.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => draftSwipeRefs.current.get(draft.id)?.close() },
          { text: 'Move to Trash', style: 'destructive', onPress: () => void performDeleteDraft(draft) },
        ],
      );
    },
    [performDeleteDraft],
  );

  const accentColor = colors.primary || '#007AFF';

  const dynamicStyles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 8,
          paddingVertical: 10,
          backgroundColor: colors.headerBackground,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        backBtn: { paddingHorizontal: 8, paddingVertical: 8 },
        headerTitleWrap: { flex: 1, minWidth: 0, paddingHorizontal: 4 },
        headerTitle: { fontSize: 17, fontWeight: '600', color: colors.text },
        headerSubtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
        headerActionBtn: { paddingHorizontal: 10, paddingVertical: 8 },
        searchContainer: {
          paddingHorizontal: 16,
          paddingVertical: 10,
          backgroundColor: colors.background,
        },
        searchInputContainer: {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: colors.card,
          borderRadius: 10,
          paddingHorizontal: 10,
          paddingVertical: 7,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        },
        searchIcon: { marginRight: 6 },
        searchInput: {
          flex: 1,
          fontSize: 15,
          color: colors.text,
          paddingVertical: 0,
        },
        searchClearBtn: { padding: 2 },
        list: { paddingTop: 4, paddingBottom: 32 },
        sectionHeader: {
          paddingHorizontal: 20,
          paddingTop: 24,
          paddingBottom: 8,
        },
        sectionTitle: {
          fontSize: 22,
          fontWeight: '700',
          color: colors.text,
        },
        sectionCard: {
          marginHorizontal: 16,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: colors.card,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          marginBottom: 4,
        },
        item: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 12,
          paddingHorizontal: 16,
          backgroundColor: colors.card,
        },
        itemSelected: {
          backgroundColor: colors.isDark ? 'rgba(0,122,255,0.15)' : 'rgba(0,122,255,0.08)',
        },
        itemSelectedAccent: {
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          backgroundColor: accentColor,
        },
        itemBorder: {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        itemContent: { flex: 1, minWidth: 0 },
        itemTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
        itemSubtitle: { fontSize: 13, color: colors.textSecondary, marginTop: 3 },
        itemChevron: { marginLeft: 6 },
        empty: {
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          paddingVertical: 60,
          paddingHorizontal: 32,
        },
        emptyIcon: { marginBottom: 16 },
        emptyTitle: { fontSize: 20, fontWeight: '600', color: colors.text, marginBottom: 8 },
        emptySubtitle: {
          fontSize: 15,
          color: colors.textSecondary,
          textAlign: 'center',
          marginBottom: 24,
          lineHeight: 22,
        },
        emptyNewBtn: {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: accentColor,
          paddingHorizontal: 20,
          paddingVertical: 12,
          borderRadius: 22,
          gap: 6,
        },
        emptyNewBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
        popoverOverlay: anchoredPopoverOverlayStyle(isDarkMode),
        popoverCard: anchoredPopoverCardStyle(colors, isDarkMode),
        popoverItem: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 13,
          paddingHorizontal: 16,
        },
        popoverItemBorder: {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        popoverItemIcon: { marginRight: 12 },
        popoverItemText: { fontSize: 16, color: colors.text, flex: 1 },
      }),
    [colors, accentColor, isDarkMode],
  );

  const paneStyle: ViewStyle = {
    flex: isSplitMode ? undefined : 1,
    width: isSplitMode ? width : undefined,
    ...style,
  };

  return (
    <View style={[dynamicStyles.container, paneStyle]}>
      <TapToToggleHeaderView style={dynamicStyles.container}>
        <AnimatedHeaderContainer>
          <View style={dynamicStyles.header}>
            {!isSplitMode && (
              <AppBackButton />
            )}
            <View style={[dynamicStyles.headerTitleWrap, isSplitMode && { paddingLeft: 12 }]}>
              <AppHeaderTitle fill={false}>Notes</AppHeaderTitle>
              {drafts.length > 0 && (
                <Text style={dynamicStyles.headerSubtitle}>
                  {drafts.length} {drafts.length === 1 ? 'note' : 'notes'}
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={dynamicStyles.headerActionBtn}
              onPress={onRefresh}
              disabled={refreshing}
              accessibilityLabel="Refresh"
              accessibilityRole="button"
            >
              {refreshing ? (
                <ActivityIndicator size="small" color={accentColor} />
              ) : (
                <Ionicons name="refresh-outline" size={30} color={accentColor} />
              )}
            </TouchableOpacity>
            <TouchableOpacity
              ref={moreButtonRef}
              style={dynamicStyles.headerActionBtn}
              onPress={handleMoreOptions}
              accessibilityLabel="More options"
              accessibilityRole="button"
            >
              <Ionicons name="ellipsis-horizontal-circle" size={28} color={accentColor} />
            </TouchableOpacity>
            <TouchableOpacity
              style={dynamicStyles.headerActionBtn}
              onPress={handleNewDraft}
              disabled={creating}
              accessibilityLabel="New note"
              accessibilityRole="button"
            >
              {creating ? (
                <ActivityIndicator size="small" color={accentColor} />
              ) : (
                <Ionicons name="create-outline" size={30} color={accentColor} />
              )}
            </TouchableOpacity>
          </View>
        </AnimatedHeaderContainer>

        <View style={dynamicStyles.searchContainer}>
          <View style={dynamicStyles.searchInputContainer}>
            <Ionicons name="search" size={16} color={colors.textSecondary} style={dynamicStyles.searchIcon} />
            <TextInput
              style={dynamicStyles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search"
              placeholderTextColor={colors.textSecondary}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')} style={dynamicStyles.searchClearBtn}>
                <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {loading ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color={accentColor} />
          </View>
        ) : filteredDrafts.length === 0 && drafts.length === 0 ? (
          <ScrollView
            contentContainerStyle={dynamicStyles.empty}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            {...scrollRestoresHeaderProps}
          >
            <Ionicons name="create-outline" size={64} color={colors.textSecondary} style={dynamicStyles.emptyIcon} />
            <Text style={dynamicStyles.emptyTitle}>No Notes Yet</Text>
            <Text style={dynamicStyles.emptySubtitle}>
              {isOffline
                ? 'No cached notes available. Connect to the internet to load your notes.'
                : 'Tap the compose button to write your first note.'}
            </Text>
            {!isOffline && (
              <TouchableOpacity style={dynamicStyles.emptyNewBtn} onPress={handleNewDraft} disabled={creating}>
                {creating ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="add" size={20} color="#fff" />
                    <Text style={dynamicStyles.emptyNewBtnText}>New Note</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </ScrollView>
        ) : filteredDrafts.length === 0 && searchQuery.trim() ? (
          <ScrollView
            contentContainerStyle={dynamicStyles.empty}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            {...scrollRestoresHeaderProps}
          >
            <Ionicons name="search-outline" size={64} color={colors.textSecondary} style={dynamicStyles.emptyIcon} />
            <Text style={dynamicStyles.emptyTitle}>No Results</Text>
            <Text style={dynamicStyles.emptySubtitle}>{`No notes match "${searchQuery}"`}</Text>
          </ScrollView>
        ) : (
          <ScrollView
            contentContainerStyle={dynamicStyles.list}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            showsVerticalScrollIndicator={false}
            {...scrollRestoresHeaderProps}
          >
            {grouped.map(({ key, label, items }) => (
              <View key={key}>
                <View style={dynamicStyles.sectionHeader}>
                  <Text style={dynamicStyles.sectionTitle}>{label}</Text>
                </View>
                <View style={dynamicStyles.sectionCard}>
                  {items.map((draft, index) => {
                    const isSelected = isSplitMode && selectedDraftId === draft.id;
                    return (
                      <Swipeable
                        key={draft.id}
                        ref={(r) => {
                          if (r) draftSwipeRefs.current.set(draft.id, r);
                          else draftSwipeRefs.current.delete(draft.id);
                        }}
                        renderRightActions={() => (
                          <TouchableOpacity
                            style={{
                              backgroundColor: '#FF3B30',
                              justifyContent: 'center',
                              alignItems: 'center',
                              width: 88,
                            }}
                            onPress={() => confirmDeleteDraft(draft)}
                            accessibilityLabel="Delete note"
                            accessibilityRole="button"
                          >
                            <Ionicons name="trash-outline" size={22} color="#fff" />
                            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600', marginTop: 4 }}>
                              Delete
                            </Text>
                          </TouchableOpacity>
                        )}
                        overshootRight={false}
                        friction={2}
                        containerStyle={{ backgroundColor: colors.card }}
                      >
                        <TouchableOpacity
                          style={[
                            dynamicStyles.item,
                            index < items.length - 1 && dynamicStyles.itemBorder,
                            isSelected && dynamicStyles.itemSelected,
                          ]}
                          onPress={() => handleOpenDraft(draft)}
                          activeOpacity={0.6}
                        >
                          {isSelected ? <View style={dynamicStyles.itemSelectedAccent} /> : null}
                          <View style={dynamicStyles.itemContent}>
                            <FileNameText
                              name={stripExtension(draft.original_filename)}
                              style={dynamicStyles.itemTitle}
                            />
                            <Text style={dynamicStyles.itemSubtitle} numberOfLines={1}>
                              {formatItemDate(draft, key)}
                              {draft.json_data?.created_from ? `  ·  ${draft.json_data.created_from}` : ''}
                            </Text>
                          </View>
                          {!isSplitMode && (
                            <Ionicons
                              name="chevron-forward"
                              size={16}
                              color={colors.textSecondary}
                              style={dynamicStyles.itemChevron}
                            />
                          )}
                        </TouchableOpacity>
                      </Swipeable>
                    );
                  })}
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </TapToToggleHeaderView>

      <Modal visible={menuVisible} transparent animationType="fade" onRequestClose={() => setMenuVisible(false)}>
        <TouchableWithoutFeedback onPress={() => setMenuVisible(false)}>
          <View style={dynamicStyles.popoverOverlay}>
            <View style={[dynamicStyles.popoverCard, { top: menuAnchor.top, right: menuAnchor.right }]}>
              <TouchableOpacity
                style={[dynamicStyles.popoverItem, dynamicStyles.popoverItemBorder]}
                onPress={() => {
                  setMenuVisible(false);
                  openChatGD({ chatPlaceholder: CHATGD_PLACEHOLDER_FROM_DRAFTS });
                }}
              >
                <Ionicons name="chatbubbles-outline" size={20} color={colors.text} style={dynamicStyles.popoverItemIcon} />
                <Text style={dynamicStyles.popoverItemText}>Ask ChatGD</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={dynamicStyles.popoverItem}
                onPress={() => {
                  setMenuVisible(false);
                  router.push('/drafts/recent');
                }}
              >
                <Ionicons name="trash-outline" size={20} color={colors.text} style={dynamicStyles.popoverItemIcon} />
                <Text style={dynamicStyles.popoverItemText}>Deleted Notes</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}
