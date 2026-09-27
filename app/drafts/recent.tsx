import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import FileNameText from '../../components/FileNameText';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { toAlertMessage } from '../../utils/alertUtils';
import { floatingDialogSurfaceStyle, modalScrimOverlayStyle } from '../../utils/dialogSurfaceStyles';
import { sanitizeDisplayFilename } from '../../utils/displayFilename';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

type FileInviteRow = {
  share_id: number;
  file_id: number;
  file_name: string;
  is_draft: boolean;
  role: string;
  inviter_name: string;
  message?: string;
  created_at?: string;
};

type TrashedDraftRow = {
  id: number;
  original_filename?: string;
  file_kind?: string;
  deleted_at?: string | null;
  days_remaining?: number | null;
  restoring?: boolean;
  lifecycle_state?: string | null;
};

function stripExtension(name?: string): string {
  if (!name) return 'Untitled';
  return sanitizeDisplayFilename(name).replace(/\.[^./\\]+$/, '');
}

const TRASHED_PAGE_SIZE = 15;

function filterTrashedDraftRows(list: unknown[]): TrashedDraftRow[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (f) =>
      f != null &&
      typeof f === 'object' &&
      ((f as { file_kind?: string }).file_kind || '').toString().toLowerCase() === 'draft'
  ) as TrashedDraftRow[];
}

export default function DraftsDeletedAndSharedScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const [trashedDrafts, setTrashedDrafts] = useState<TrashedDraftRow[]>([]);
  const [invites, setInvites] = useState<FileInviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMoreTrashed, setLoadingMoreTrashed] = useState(false);
  const [trashedHasMore, setTrashedHasMore] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<number, boolean>>({});
  const [draftTrashActionId, setDraftTrashActionId] = useState<number | null>(null);
  const [showTrashedKebabMenu, setShowTrashedKebabMenu] = useState(false);
  const [selectedTrashedDraftForMenu, setSelectedTrashedDraftForMenu] = useState<TrashedDraftRow | null>(null);
  const restoreDraftPollRef = useRef<{
    intervalId: ReturnType<typeof setInterval> | null;
    pendingIds: Set<number>;
    attempts: number;
  }>({ intervalId: null, pendingIds: new Set(), attempts: 0 });
  const MAX_DRAFT_RESTORE_POLL = 150;

  const trashedPageRef = useRef(1);
  const trashedHasMoreRef = useRef(true);
  const loadingMoreTrashedRef = useRef(false);
  const onEndReachedTrashedMomentumRef = useRef(false);

  const load = useCallback(async () => {
    if (!user) {
      setTrashedDrafts([]);
      setInvites([]);
      setTrashedHasMore(false);
      trashedHasMoreRef.current = false;
      setLoading(false);
      return;
    }
    setLoading(true);
    trashedPageRef.current = 1;
    try {
      const [deletedOutcome, invitesOutcome] = await Promise.allSettled([
        apiClient.getDeletedFiles(1, TRASHED_PAGE_SIZE),
        apiClient.getFileInvites(),
      ]);

      if (deletedOutcome.status === 'fulfilled') {
        const res = deletedOutcome.value;
        const files =
          (res as { files?: unknown }).files ?? (res as { data?: { files?: unknown } })?.data?.files;
        const list = Array.isArray(files) ? files : [];
        const draftsOnly = filterTrashedDraftRows(list);
        setTrashedDrafts(draftsOnly);
        const pag = (res as { pagination?: { has_more?: boolean } }).pagination;
        const more = pag?.has_more === true;
        trashedHasMoreRef.current = more;
        setTrashedHasMore(more);
      } else {
        setTrashedDrafts([]);
        trashedHasMoreRef.current = false;
        setTrashedHasMore(false);
      }

      if (invitesOutcome.status === 'fulfilled') {
        const res = invitesOutcome.value as {
          file_invites?: FileInviteRow[];
          success?: boolean;
        };
        const raw = res?.file_invites ?? [];
        const draftInvites = Array.isArray(raw)
          ? raw.filter((i) => i.is_draft === true || String(i.is_draft) === 'true')
          : [];
        setInvites(draftInvites);
      } else {
        setInvites([]);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  const loadMoreTrashed = useCallback(async () => {
    if (!user || !trashedHasMoreRef.current || loadingMoreTrashedRef.current) return;
    loadingMoreTrashedRef.current = true;
    setLoadingMoreTrashed(true);
    try {
      const nextPage = trashedPageRef.current + 1;
      const res = await apiClient.getDeletedFiles(nextPage, TRASHED_PAGE_SIZE);
      const files =
        (res as { files?: unknown }).files ?? (res as { data?: { files?: unknown } })?.data?.files;
      const list = Array.isArray(files) ? files : [];
      const draftsOnly = filterTrashedDraftRows(list);
      const pag = (res as { pagination?: { has_more?: boolean } }).pagination;
      const more = pag?.has_more === true;
      trashedPageRef.current = nextPage;
      trashedHasMoreRef.current = more;
      setTrashedHasMore(more);
      if (draftsOnly.length > 0) {
        setTrashedDrafts((prev) => {
          const ids = new Set(prev.map((d) => d.id));
          const next = [...prev];
          for (const d of draftsOnly) {
            if (!ids.has(d.id)) {
              ids.add(d.id);
              next.push(d);
            }
          }
          return next;
        });
      }
    } catch {
      // keep existing list
    } finally {
      loadingMoreTrashedRef.current = false;
      setLoadingMoreTrashed(false);
    }
  }, [user]);

  const onEndReachedTrashed = useCallback(() => {
    if (onEndReachedTrashedMomentumRef.current) return;
    onEndReachedTrashedMomentumRef.current = true;
    void loadMoreTrashed();
  }, [loadMoreTrashed]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load])
  );

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const fetchTrashedDraftsOnly = useCallback(async (opts?: { silent?: boolean }) => {
    if (!user) return [] as TrashedDraftRow[];
    try {
      const res = await apiClient.getDeletedFiles(1, 100);
      const files = (res as { files?: unknown }).files ?? (res as { data?: { files?: unknown } })?.data?.files;
      const list = Array.isArray(files) ? files : [];
      const draftsOnly = filterTrashedDraftRows(list);
      setTrashedDrafts(draftsOnly);
      const pag = (res as { pagination?: { has_more?: boolean } }).pagination;
      const more = pag?.has_more === true;
      trashedPageRef.current = 1;
      trashedHasMoreRef.current = more;
      setTrashedHasMore(more);
      return draftsOnly;
    } catch {
      if (!opts?.silent) setTrashedDrafts([]);
      return [];
    }
  }, [user]);

  const runDraftRestorePollTick = useCallback(async () => {
    const poll = restoreDraftPollRef.current;
    if (poll.pendingIds.size === 0) {
      if (poll.intervalId) {
        clearInterval(poll.intervalId);
        poll.intervalId = null;
      }
      poll.attempts = 0;
      return;
    }
    poll.attempts += 1;
    if (poll.attempts > MAX_DRAFT_RESTORE_POLL) {
      if (poll.intervalId) {
        clearInterval(poll.intervalId);
        poll.intervalId = null;
      }
      poll.pendingIds.clear();
      poll.attempts = 0;
      Alert.alert(
        'Restore',
        'Restoring is taking longer than expected. Pull to refresh to check status.'
      );
      return;
    }
    try {
      const draftsOnly = await fetchTrashedDraftsOnly({ silent: true });
      for (const id of [...poll.pendingIds]) {
        if (!draftsOnly.some((d) => d.id === id)) {
          poll.pendingIds.delete(id);
        }
      }
      if (poll.pendingIds.size === 0) {
        if (poll.intervalId) {
          clearInterval(poll.intervalId);
          poll.intervalId = null;
        }
        poll.attempts = 0;
        await load();
      }
    } catch {
      // next tick
    }
  }, [fetchTrashedDraftsOnly, load]);

  const performRestoreDraft = useCallback(async (fileId: number) => {
    setDraftTrashActionId(fileId);
    try {
      const r = await apiClient.restoreFileFromTrash(fileId);
      if ((r as { success?: boolean })?.success === false) {
        Alert.alert('Error', (r as { message?: string })?.message || 'Could not restore');
        return;
      }
      setTrashedDrafts((prev) =>
        prev.map((x) =>
          x.id === fileId ? { ...x, restoring: true, lifecycle_state: 'restoring' } : x
        )
      );
      const poll = restoreDraftPollRef.current;
      poll.pendingIds.add(fileId);
      if (!poll.intervalId) {
        poll.attempts = 0;
        poll.intervalId = setInterval(() => {
          void runDraftRestorePollTick();
        }, 2000);
        void runDraftRestorePollTick();
      } else {
        void runDraftRestorePollTick();
      }
    } catch (e: any) {
      Alert.alert('Error', toAlertMessage(e?.message, 'Could not restore'));
    } finally {
      setDraftTrashActionId(null);
    }
  }, [runDraftRestorePollTick]);

  const confirmRestoreDraft = useCallback(
    (fileId: number, displayName?: string) => {
      const raw = stripExtension(displayName) || 'This note';
      const label = raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
      Alert.alert(
        'Restore this note?',
        `“${label}” will be added back to your notes. This might take a few minutes to complete — you can leave this page.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Restore', onPress: () => void performRestoreDraft(fileId) },
        ]
      );
    },
    [performRestoreDraft]
  );

  useEffect(() => {
    return () => {
      const poll = restoreDraftPollRef.current;
      if (poll.intervalId) {
        clearInterval(poll.intervalId);
        poll.intervalId = null;
      }
      poll.pendingIds.clear();
    };
  }, []);

  const handleCloseTrashedKebabMenu = useCallback(() => {
    setShowTrashedKebabMenu(false);
    setSelectedTrashedDraftForMenu(null);
  }, []);

  const handleOpenTrashedKebab = useCallback((row: TrashedDraftRow) => {
    setSelectedTrashedDraftForMenu(row);
    setShowTrashedKebabMenu(true);
  }, []);

  const handlePermanentDeleteDraft = (row: TrashedDraftRow) => {
    Alert.alert(
      'Delete forever',
      `Permanently delete "${stripExtension(row.original_filename)}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete forever',
          style: 'destructive',
          onPress: async () => {
            setDraftTrashActionId(row.id);
            try {
              const r = await apiClient.permanentlyDeleteTrashedFile(row.id);
              if ((r as { success?: boolean })?.success !== false) {
                setTrashedDrafts((prev) => prev.filter((x) => x.id !== row.id));
              } else {
                Alert.alert('Error', (r as { message?: string })?.message || 'Delete failed');
              }
            } catch (e: any) {
              Alert.alert('Error', toAlertMessage(e?.message, 'Delete failed'));
            } finally {
              setDraftTrashActionId(null);
            }
          },
        },
      ]
    );
  };

  const handleAccept = async (shareId: number) => {
    setActionLoading((p) => ({ ...p, [shareId]: true }));
    try {
      await apiClient.acceptFileInvite(shareId);
      setInvites((prev) => prev.filter((i) => i.share_id !== shareId));
    } catch (e: any) {
      Alert.alert('Error', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Could not accept'));
    } finally {
      setActionLoading((p) => ({ ...p, [shareId]: false }));
    }
  };

  const handleReject = async (shareId: number) => {
    setActionLoading((p) => ({ ...p, [shareId]: true }));
    try {
      await apiClient.rejectFileInvite(shareId);
      setInvites((prev) => prev.filter((i) => i.share_id !== shareId));
    } catch (e: any) {
      Alert.alert('Error', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Could not decline'));
    } finally {
      setActionLoading((p) => ({ ...p, [shareId]: false }));
    }
  };

  const dynamicStyles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.headerBackground },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          backgroundColor: colors.headerBackground,
        },
        backBtn: { padding: 10, marginRight: 6, marginTop: 4 },
        headerTitleWrap: { flex: 1, minWidth: 0 },
        headerTitle: { fontSize: 20, fontWeight: '700', color: colors.text },
        headerSubtitle: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
        section: { paddingTop: 16, paddingBottom: 8 },
        sectionTitle: {
          fontSize: 13,
          fontWeight: '600',
          color: colors.textSecondary,
          textTransform: 'uppercase',
          paddingHorizontal: 16,
          marginBottom: 8,
        },
        card: {
          paddingVertical: 14,
          paddingHorizontal: 16,
          backgroundColor: colors.card,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
        rowMeta: { fontSize: 13, color: colors.textSecondary, marginTop: 4 },
        empty: {
          paddingVertical: 24,
          paddingHorizontal: 24,
          alignItems: 'center',
        },
        emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
        actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
        actionBtn: {
          paddingVertical: 8,
          paddingHorizontal: 14,
          borderRadius: 8,
          minWidth: 88,
          alignItems: 'center',
        },
        accept: { backgroundColor: '#34C759' },
        reject: { backgroundColor: colors.surface },
        actionText: { fontSize: 14, fontWeight: '600', color: '#fff' },
        rejectText: { fontSize: 14, fontWeight: '600', color: colors.text },
        kebabButton: { padding: 6, marginLeft: 6 },
        modalOverlay: modalScrimOverlayStyle(colors.isDark, {
          justifyContent: 'center',
          alignItems: 'center',
        }),
        kebabMenuContainer: {
          ...floatingDialogSurfaceStyle(colors, colors.isDark, { minWidth: 180 }),
          padding: 8,
        },
        kebabMenuItem: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 12,
          paddingHorizontal: 16,
          borderRadius: 8,
        },
        kebabMenuText: {
          fontSize: 16,
          color: colors.text,
          marginLeft: 12,
          fontWeight: '500',
        },
      }),
    [colors]
  );

  if (!user) {
    return (
      <SafeAreaView style={dynamicStyles.container} edges={['top']}>
        <View style={dynamicStyles.header}>
          <AppBackButton />
          <View style={dynamicStyles.headerTitleWrap}>
            <AppHeaderTitle fill={false}>Deleted & shared</AppHeaderTitle>
          </View>
        </View>
        <View style={[dynamicStyles.empty, { backgroundColor: colors.background }]}>
          <Text style={dynamicStyles.emptyText}>Sign in to view deleted notes and invitations.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container} edges={['top']}>
      <View style={dynamicStyles.header}>
        <AppBackButton />
        <View style={dynamicStyles.headerTitleWrap}>
          <AppHeaderTitle fill={false}>Deleted & shared</AppHeaderTitle>
          <Text style={dynamicStyles.headerSubtitle}>
            Notes in your account trash · invitations to co-edit notes
          </Text>
        </View>
        <TouchableOpacity
          onPress={onRefresh}
          disabled={refreshing}
          accessibilityLabel="Refresh"
          accessibilityRole="button"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{ padding: 6 }}
        >
          <Ionicons
            name="refresh"
            size={24}
            color={refreshing ? '#999' : colors.primary || '#007AFF'}
          />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
          <ActivityIndicator size="large" color={colors.primary || '#007AFF'} />
        </View>
      ) : (
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <FlatList
            style={{ flex: 1 }}
            data={trashedDrafts}
            keyExtractor={(item) => `trash-draft-${item.id}`}
            extraData={`${draftTrashActionId}-${trashedDrafts.map((d) => `${d.id}:${d.restoring ? 1 : 0}`).join(',')}`}
            ListHeaderComponent={
              <View style={dynamicStyles.section}>
                <Text style={dynamicStyles.sectionTitle}>Deleted notes</Text>
              </View>
            }
            ListEmptyComponent={
              <View style={dynamicStyles.empty}>
                <Ionicons name="trash-outline" size={40} color={colors.textSecondary} style={{ marginBottom: 8 }} />
                <Text style={dynamicStyles.emptyText}>
                  No draft notes in trash. Deleted notes appear here until restored or permanently removed.
                </Text>
              </View>
            }
            ListFooterComponent={
              loadingMoreTrashed && trashedHasMore ? (
                <View style={{ paddingVertical: 16 }}>
                  <ActivityIndicator size="small" color={colors.primary || '#007AFF'} />
                </View>
              ) : null
            }
            renderItem={({ item: d }) => {
              const isRestoring =
                d.restoring === true || (d.lifecycle_state || '').toLowerCase() === 'restoring';
              const showBusy = isRestoring || draftTrashActionId === d.id;
              return (
                <View style={dynamicStyles.card}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {showBusy ? (
                      <View style={{ marginRight: 10 }}>
                        <ActivityIndicator size="small" color={colors.primary || '#007AFF'} />
                      </View>
                    ) : null}
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <FileNameText
                        name={stripExtension(d.original_filename)}
                        style={dynamicStyles.rowTitle}
                      />
                      <Text style={dynamicStyles.rowMeta}>
                        {isRestoring
                          ? 'Restoring…'
                          : [
                              d.deleted_at
                                ? `Deleted ${new Date(d.deleted_at).toLocaleString(undefined, {
                                    month: 'short',
                                    day: 'numeric',
                                    year: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}`
                                : '',
                              d.days_remaining != null ? ` · ${d.days_remaining} days left in trash` : '',
                            ]
                              .filter(Boolean)
                              .join('')}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[dynamicStyles.kebabButton, showBusy && { opacity: 0.4 }]}
                      onPress={() => handleOpenTrashedKebab(d)}
                      disabled={showBusy}
                      accessibilityLabel="Deleted note actions"
                      accessibilityRole="button"
                    >
                      <Ionicons name="ellipsis-vertical" size={20} color={colors.textSecondary} />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            onEndReached={onEndReachedTrashed}
            onEndReachedThreshold={0.4}
            onMomentumScrollBegin={() => {
              onEndReachedTrashedMomentumRef.current = false;
            }}
            showsVerticalScrollIndicator={false}
          />
          <View style={{ paddingBottom: 32, backgroundColor: colors.background }}>
            <View style={dynamicStyles.section}>
              <Text style={dynamicStyles.sectionTitle}>Shared with you (notes)</Text>
              {invites.length === 0 ? (
                <View style={dynamicStyles.empty}>
                  <Ionicons name="people-outline" size={40} color={colors.textSecondary} style={{ marginBottom: 8 }} />
                  <Text style={dynamicStyles.emptyText}>No pending note invitations.</Text>
                </View>
              ) : (
                invites.map((inv) => (
                  <View key={inv.share_id} style={dynamicStyles.card}>
                    <FileNameText
                      name={stripExtension(inv.file_name)}
                      style={dynamicStyles.rowTitle}
                    />
                    <Text style={dynamicStyles.rowMeta}>
                      From {inv.inviter_name || 'Someone'}
                      {inv.created_at
                        ? ` · ${new Date(inv.created_at).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}`
                        : ''}
                    </Text>
                    {inv.role ? (
                      <Text style={[dynamicStyles.rowMeta, { marginTop: 2 }]}>Role: {inv.role}</Text>
                    ) : null}
                    <View style={dynamicStyles.actions}>
                      <FeedbackTouchable
                        style={[dynamicStyles.actionBtn, dynamicStyles.accept]}
                        onPress={() => handleAccept(inv.share_id)}
                        disabled={actionLoading[inv.share_id]}
                        loading={actionLoading[inv.share_id]}
                        spinnerColor="#fff"
                      >
                        <Text style={dynamicStyles.actionText}>Accept</Text>
                      </FeedbackTouchable>
                      <FeedbackTouchable
                        style={[dynamicStyles.actionBtn, dynamicStyles.reject]}
                        onPress={() => handleReject(inv.share_id)}
                        disabled={actionLoading[inv.share_id]}
                        loading={actionLoading[inv.share_id]}
                        spinnerColor="#007AFF"
                        replaceWithSpinner={false}
                      >
                        <Text style={dynamicStyles.rejectText}>Decline</Text>
                      </FeedbackTouchable>
                    </View>
                  </View>
                ))
              )}
            </View>
          </View>
        </View>
      )}

      <Modal
        visible={showTrashedKebabMenu}
        transparent
        animationType="fade"
        onRequestClose={handleCloseTrashedKebabMenu}
      >
        <TouchableOpacity
          style={dynamicStyles.modalOverlay}
          activeOpacity={1}
          onPress={handleCloseTrashedKebabMenu}
        >
          <View style={dynamicStyles.kebabMenuContainer}>
            <FeedbackTouchable
              style={dynamicStyles.kebabMenuItem}
              onPress={() => {
                const row = selectedTrashedDraftForMenu;
                handleCloseTrashedKebabMenu();
                if (row) confirmRestoreDraft(row.id, row.original_filename);
              }}
              disabled={
                !!selectedTrashedDraftForMenu &&
                (draftTrashActionId === selectedTrashedDraftForMenu.id ||
                  selectedTrashedDraftForMenu.restoring === true ||
                  (selectedTrashedDraftForMenu.lifecycle_state || '').toLowerCase() === 'restoring')
              }
              spinnerColor="#007AFF"
              replaceWithSpinner={false}
            >
              <Ionicons name="arrow-undo-outline" size={20} color="#007AFF" />
              <Text style={dynamicStyles.kebabMenuText}>Restore</Text>
            </FeedbackTouchable>
            <FeedbackTouchable
              style={dynamicStyles.kebabMenuItem}
              onPress={() => {
                const row = selectedTrashedDraftForMenu;
                handleCloseTrashedKebabMenu();
                if (row) handlePermanentDeleteDraft(row);
              }}
              disabled={
                !!selectedTrashedDraftForMenu &&
                (draftTrashActionId === selectedTrashedDraftForMenu.id ||
                  selectedTrashedDraftForMenu.restoring === true ||
                  (selectedTrashedDraftForMenu.lifecycle_state || '').toLowerCase() === 'restoring')
              }
              spinnerColor="#EF4444"
              replaceWithSpinner={false}
            >
              <Ionicons name="trash-outline" size={20} color="#EF4444" />
              <Text style={[dynamicStyles.kebabMenuText, { color: '#EF4444' }]}>Delete forever</Text>
            </FeedbackTouchable>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}
