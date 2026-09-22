import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
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
import DocumentViewer from '../../components/DocumentViewer';
import ListFilterDialog, { ListFilterButton, type ListFilterSection } from '../../components/ListFilterDialog';
import EnvelopeListItem from '../../components/signatures/EnvelopeListItem';
import SignatureActivityListItem from '../../components/signatures/SignatureActivityListItem';
import SignatureCreateChooser from '../../components/signatures/SignatureCreateChooser';
import { useEnvelopeList, ENVELOPE_LIST_PAGE_SIZE, type EnvelopeListFilters } from '../../hooks/useEnvelopeList';
import { invalidateSignatureActivityCache, useSignatureAllList } from '../../hooks/useSignatureAllList';
import type { SignatureActivityItem } from '../../hooks/useSignatureAllList';
import { useMinimizableSheet } from '../../hooks/useMinimizableSheet';
import { useThemeColors } from '../../hooks/useThemeColors';
import type { EnvelopeTab } from '../../services/envelopeApi';
import { deleteFillableTemplate } from '../../services/fillableApi';
import type { Envelope } from '../../types/signature';
import {
  envelopeFillableTemplateId,
  envelopeFinalFileId,
  loadEnvelopeForActions,
  resolveEnvelopeAuditFileId,
} from '../../utils/envelopeActions';
import { submissionDisplayTitle } from '../../utils/signatureActivity';
import { envelopeDisplayId } from '../../utils/signatureRuntime';
import { shareDocumentFile } from '../../utils/shareDocumentFile';
import {
  hubDetailRoute,
  hubFillEditorRoute,
  hubFillRoute,
  hubPrepareRoute,
  hubSignRoute,
  hubTemplateSubmissionsRoute,
} from '../../utils/signatureRouteResolver';

import AppBackButton, { APP_BACK_BUTTON_SLOT } from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

const TABS: { key: EnvelopeTab; label?: string; icon?: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'all', icon: 'home' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'sent', label: 'Sent' },
  { key: 'completed', label: 'Completed' },
  { key: 'drafts', label: 'Drafts' },
];

const ANDROID_TEXT_INPUT_PROPS =
  Platform.OS === 'android' ? { underlineColorAndroid: 'transparent' as const } : {};

const SOURCE_TYPE_FILTERS = [
  { value: '', label: 'All types' },
  { value: 'fillable', label: 'Fillable' },
  { value: 'form', label: 'Form' },
] as const;

function statusOptionsForTab(tab: EnvelopeTab): { value: string; label: string }[] | null {
  if (tab === 'drafts') return null;
  if (tab === 'sent') {
    return [
      { value: '', label: 'All' },
      { value: 'sent', label: 'Sent' },
      { value: 'in_progress', label: 'In progress' },
    ];
  }
  if (tab === 'completed') {
    return [
      { value: '', label: 'All' },
      { value: 'completed', label: 'Completed' },
      { value: 'declined', label: 'Declined' },
      { value: 'voided', label: 'Voided' },
      { value: 'expired', label: 'Expired' },
    ];
  }
  return [
    { value: '', label: 'All' },
    { value: 'sent', label: 'Sent' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'declined', label: 'Declined' },
    { value: 'voided', label: 'Voided' },
    { value: 'expired', label: 'Expired' },
  ];
}

function activityMatches(
  item: SignatureActivityItem,
  q: string,
  status: string,
  sourceType: string,
): boolean {
  if (status) {
    if (item.kind === 'envelope' && item.envelope?.status !== status) return false;
    if (item.kind === 'fillable' && status !== 'in_progress' && status !== 'draft') return false;
    if (item.kind === 'submission' && status !== 'completed') return false;
  }
  if (sourceType) {
    if (item.kind === 'envelope') {
      const src = item.envelope?.source_type;
      if (src && src !== sourceType) return false;
    } else if (sourceType !== 'fillable') {
      return false;
    }
  }
  if (q) {
    const hay = [
      item.envelope?.title,
      item.template?.name,
      item.submission?.template_name,
      ...(item.envelope?.recipients || []).flatMap((r) => [r.email, r.name]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!hay.includes(q.toLowerCase())) return false;
  }
  return true;
}

function templateDisplayId(template: { public_id?: string; id: number }): string {
  return template.public_id ?? String(template.id);
}

export default function SignaturesHubScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const colors = useThemeColors();
  const validTab = (t?: string): EnvelopeTab =>
    TABS.some((x) => x.key === t) ? (t as EnvelopeTab) : 'all';
  const [tab, setTab] = useState<EnvelopeTab>(() => validTab(params.tab));
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const chooserSheet = useMinimizableSheet();
  const [viewerFile, setViewerFile] = useState<{ id: string; name: string } | null>(null);
  const [allVisibleCount, setAllVisibleCount] = useState(ENVELOPE_LIST_PAGE_SIZE);
  const isAllTab = tab === 'all';
  const envelopeFilters = useMemo((): EnvelopeListFilters | undefined => {
    if (isAllTab) return undefined;
    const next: EnvelopeListFilters = {};
    if (searchQuery) next.q = searchQuery;
    if (statusFilter) next.status = statusFilter;
    if (sourceFilter) next.source_type = sourceFilter;
    return Object.keys(next).length ? next : undefined;
  }, [isAllTab, searchQuery, statusFilter, sourceFilter]);
  const { envelopes, loading, loadingMore, refreshing, hasMore, loadMore, refresh, revalidateIfStale } =
    useEnvelopeList(tab, envelopeFilters);
  const {
    items: allItems,
    loading: activityLoading,
    revalidateIfStale: revalidateActivityIfStale,
    refreshAll: refreshActivity,
  } = useSignatureAllList(isAllTab, envelopes);
  const lastFocusRefresh = useRef(0);

  useEffect(() => {
    if (isAllTab) {
      setAllVisibleCount(ENVELOPE_LIST_PAGE_SIZE);
    }
  }, [isAllTab, tab]);

  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const hasListFilters = Boolean(searchQuery || statusFilter || sourceFilter);
  const statusOptions = statusOptionsForTab(tab);
  const chipFilterCount = [statusFilter, sourceFilter].filter(Boolean).length;
  const filterSections = useMemo((): ListFilterSection[] => {
    const sections: ListFilterSection[] = [];
    if (statusOptions) {
      sections.push({
        title: 'Status',
        options: statusOptions,
        value: statusFilter,
        onChange: setStatusFilter,
      });
    }
    sections.push({
      title: 'Type',
      options: SOURCE_TYPE_FILTERS,
      value: sourceFilter,
      onChange: setSourceFilter,
    });
    return sections;
  }, [statusOptions, statusFilter, sourceFilter]);

  const resetListFilters = useCallback(() => {
    setSearchInput('');
    setSearchQuery('');
    setStatusFilter('');
    setSourceFilter('');
  }, []);

  const handleTabChange = (next: EnvelopeTab) => {
    setFilterOpen(false);
    resetListFilters();
    setTab(next);
  };

  useEffect(() => {
    if (params.tab) {
      setTab(validTab(params.tab));
    }
  }, [params.tab]);

  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      if (now - lastFocusRefresh.current > 1500) {
        lastFocusRefresh.current = now;
        void revalidateIfStale();
        if (isAllTab) {
          void revalidateActivityIfStale();
        }
      }
    }, [isAllTab, revalidateActivityIfStale, revalidateIfStale]),
  );

  const handleRefresh = useCallback(async () => {
    if (isAllTab) {
      setAllVisibleCount(ENVELOPE_LIST_PAGE_SIZE);
      invalidateSignatureActivityCache();
    }
    await refresh();
    if (isAllTab) {
      await refreshActivity();
    }
  }, [isAllTab, refresh, refreshActivity]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 4,
          paddingHorizontal: 14,
          paddingVertical: 12, backgroundColor: colors.headerBackground },
        title: { fontSize: 22, fontWeight: '700', color: colors.text },
        tabsScroll: { marginBottom: 8, maxHeight: 44 },
        tabs: { flexDirection: 'row', paddingHorizontal: 10, alignItems: 'center' },
        tab: { paddingHorizontal: 12, paddingVertical: 8, marginHorizontal: 4, borderRadius: 20 },
        tabIcon: { paddingHorizontal: 10, paddingVertical: 8, marginHorizontal: 4, borderRadius: 20 },
        tabActive: { backgroundColor: colors.primary },
        tabText: { fontSize: 13, fontWeight: '600' },
        searchContainer: { paddingHorizontal: 14, paddingBottom: 6 },
        searchRow: { flexDirection: 'row', alignItems: 'center' },
        searchInputContainer: {
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: colors.surface,
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
        },
        searchIcon: { marginRight: 8 },
        searchInput: {
          flex: 1,
          fontSize: 14,
          color: colors.text,
          padding: 0,
          backgroundColor: 'transparent',
        },
        empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
        fab: {
          position: 'absolute',
          right: 20,
          bottom: 24,
          backgroundColor: colors.primary,
          width: 56,
          height: 56,
          borderRadius: 28,
          alignItems: 'center',
          justifyContent: 'center',
          elevation: 4,
        },
        footer: { paddingVertical: 16 },
      }),
    [colors],
  );

  const filteredAllItems = useMemo(() => {
    if (!isAllTab) return allItems;
    if (!hasListFilters) return allItems;
    return allItems.filter((item) => activityMatches(item, searchQuery, statusFilter, sourceFilter));
  }, [allItems, hasListFilters, isAllTab, searchQuery, sourceFilter, statusFilter]);

  const visibleAllItems = useMemo(
    () => (isAllTab ? filteredAllItems.slice(0, allVisibleCount) : filteredAllItems),
    [filteredAllItems, allVisibleCount, isAllTab],
  );
  const allHasMoreLocal = isAllTab && allVisibleCount < filteredAllItems.length;

  const showInitialSpinner =
    isAllTab
      ? // Wait for envelopes AND fillable/submission activity — otherwise the list
        // paints envelopes first and other rows "pop in" a few seconds later.
        (loading || activityLoading) && !refreshing
      : loading && envelopes.length === 0 && !refreshing;

  const handleLoadMore = useCallback(() => {
    if (isAllTab) {
      if (allHasMoreLocal) {
        setAllVisibleCount((count) => count + ENVELOPE_LIST_PAGE_SIZE);
        return;
      }
      if (hasMore && !loadingMore && !loading) {
        void loadMore();
      }
      return;
    }
    if (hasMore && !loadingMore && !loading) {
      void loadMore();
    }
  }, [allHasMoreLocal, hasMore, isAllTab, loadMore, loading, loadingMore]);

  const handleShareFile = useCallback(
    async (fileId: number | string | null | undefined, name: string) => {
      if (fileId == null) {
        Alert.alert('Cannot share', 'No file is available to share yet.');
        return;
      }
      try {
        await shareDocumentFile(fileId, name);
      } catch (e: unknown) {
        Alert.alert('Could not share', e instanceof Error ? e.message : 'Try again.');
      }
    },
    [],
  );

  const envelopeActionHandlers = useCallback(
    (envelope: Envelope) => {
      const eid = envelopeDisplayId(envelope);
      const title = envelope.title || 'Envelope';
      const isCompleted = envelope.status === 'completed';
      if (!isCompleted) {
        return {
          onViewCompletedPdf: undefined,
          onShare: undefined,
          onViewSubmissions: undefined,
          onViewAuditTrail: undefined,
        };
      }

      const templateId = envelopeFillableTemplateId(envelope);

      return {
        onViewCompletedPdf: async () => {
          try {
            const full = await loadEnvelopeForActions(envelope);
            const fileId = envelopeFinalFileId(full);
            if (!fileId) {
              Alert.alert('Not available', 'The signed PDF is not ready yet.');
              return;
            }
            setViewerFile({ id: String(fileId), name: title });
          } catch (e: unknown) {
            Alert.alert('Could not open PDF', e instanceof Error ? e.message : 'Try again.');
          }
        },
        onShare: async () => {
          try {
            const full = await loadEnvelopeForActions(envelope);
            const fileId = envelopeFinalFileId(full);
            if (!fileId) {
              Alert.alert('Cannot share', 'No signed PDF is available yet.');
              return;
            }
            await handleShareFile(fileId, title);
          } catch (e: unknown) {
            Alert.alert('Could not share', e instanceof Error ? e.message : 'Try again.');
          }
        },
        onViewSubmissions: templateId
          ? () => router.push(hubTemplateSubmissionsRoute(templateId))
          : undefined,
        onViewAuditTrail: async () => {
          try {
            const auditFileId = await resolveEnvelopeAuditFileId(eid, envelope.audit_file_id);
            if (!auditFileId) {
              Alert.alert('Not available', 'The audit trail PDF could not be generated.');
              return;
            }
            setViewerFile({ id: String(auditFileId), name: `Audit trail — ${title}` });
          } catch (e: unknown) {
            Alert.alert('Could not open audit trail', e instanceof Error ? e.message : 'Try again.');
          }
        },
      };
    },
    [handleShareFile, router],
  );

  const renderActivityRow = useCallback(
    (row: SignatureActivityItem) => {
      const templateId = row.template
        ? templateDisplayId(row.template)
        : row.submission
          ? String(row.submission.template_id)
          : null;
      return (
        <SignatureActivityListItem
          item={row}
          onPress={() => {
            if (row.kind === 'envelope' && row.envelope) {
              router.push(hubDetailRoute(envelopeDisplayId(row.envelope)));
            }
          }}
          onSign={
            row.envelope?.inbox_context?.can_sign
              ? () => {
                  const env = row.envelope;
                  if (env) router.push(hubSignRoute(envelopeDisplayId(env)));
                }
              : undefined
          }
          onViewDocument={
            row.kind === 'fillable' && row.template?.file_id
              ? () => {
                  setViewerFile({
                    id: String(row.template!.file_id),
                    name: row.template!.name || 'Document',
                  });
                }
              : undefined
          }
          onFillDocument={
            row.kind === 'fillable' && templateId
              ? () => router.push(hubFillEditorRoute(templateId))
              : undefined
          }
          onViewSubmission={
            row.kind === 'submission' && row.submission?.filled_file_id
              ? () => {
                  setViewerFile({
                    id: String(row.submission!.filled_file_id),
                    name: submissionDisplayTitle(row.submission!),
                  });
                }
              : undefined
          }
          onViewCompletedPdf={
            row.kind === 'envelope' && row.envelope
              ? envelopeActionHandlers(row.envelope).onViewCompletedPdf
              : undefined
          }
          onViewAuditTrail={
            row.kind === 'envelope' && row.envelope
              ? envelopeActionHandlers(row.envelope).onViewAuditTrail
              : undefined
          }
          onViewSubmissions={
            row.kind === 'submission' && templateId
              ? () => router.push(hubTemplateSubmissionsRoute(templateId))
              : row.kind === 'envelope' && row.envelope
                ? envelopeActionHandlers(row.envelope).onViewSubmissions
                : undefined
          }
          onShare={
            row.kind === 'fillable' && row.template?.file_id
              ? () => handleShareFile(row.template!.file_id, row.template!.name || 'Document')
              : row.kind === 'submission' && row.submission?.filled_file_id
                ? () =>
                    handleShareFile(
                      row.submission!.filled_file_id,
                      submissionDisplayTitle(row.submission!),
                    )
                : row.kind === 'envelope' && row.envelope
                  ? envelopeActionHandlers(row.envelope).onShare
                  : undefined
          }
          onDeleteDocument={
            row.kind === 'fillable' && row.template
              ? () => {
                  const tpl = row.template!;
                  const label = tpl.name || 'this document';
                  Alert.alert(
                    'Delete document?',
                    `"${label}" will be moved to Trash.`,
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () => {
                          void (async () => {
                            try {
                              await deleteFillableTemplate(templateDisplayId(tpl));
                              invalidateSignatureActivityCache();
                              await refreshActivity();
                            } catch (e: unknown) {
                              Alert.alert(
                                'Could not delete',
                                e instanceof Error ? e.message : 'Try again.',
                              );
                            }
                          })();
                        },
                      },
                    ],
                  );
                }
              : undefined
          }
        />
      );
    },
    [envelopeActionHandlers, handleShareFile, refreshActivity, router],
  );

  const listFooter = loadingMore ? (
    <View style={styles.footer}>
      <ActivityIndicator color={colors.primary} />
    </View>
  ) : null;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Signatures</AppHeaderTitle>
        <View style={{ width: APP_BACK_BUTTON_SLOT }} />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsScroll}
        contentContainerStyle={styles.tabs}
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[t.icon ? styles.tabIcon : styles.tab, active && styles.tabActive]}
              onPress={() => handleTabChange(t.key)}
              accessibilityLabel={t.label ?? 'Home'}
            >
              {t.icon ? (
                <Ionicons
                  name={
                    (active ? t.icon : `${t.icon}-outline`) as React.ComponentProps<
                      typeof Ionicons
                    >['name']
                  }
                  size={18}
                  color={active ? '#fff' : colors.textSecondary}
                />
              ) : (
                <Text style={[styles.tabText, { color: active ? '#fff' : colors.textSecondary }]}>
                  {t.label}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <View style={styles.searchContainer}>
        <View style={styles.searchRow}>
          <View style={styles.searchInputContainer}>
            <Ionicons name="search" size={18} color={colors.textSecondary} style={styles.searchIcon} />
            <TextInput
              {...ANDROID_TEXT_INPUT_PROPS}
              style={styles.searchInput}
              placeholder="Search by title or signer…"
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
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            ) : null}
          </View>
          <ListFilterButton activeCount={chipFilterCount} onPress={() => setFilterOpen(true)} />
        </View>
      </View>
      <ListFilterDialog
        visible={filterOpen}
        sections={filterSections}
        hasActiveFilters={chipFilterCount > 0}
        onClose={() => setFilterOpen(false)}
        onClear={() => {
          setStatusFilter('');
          setSourceFilter('');
        }}
      />
      {showInitialSpinner ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : isAllTab ? (
        <FlatList<SignatureActivityItem>
          data={visibleAllItems}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} />
          }
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={{ color: colors.textSecondary }}>
                {hasListFilters ? 'No matching documents' : 'No documents yet'}
              </Text>
            </View>
          }
          ListFooterComponent={listFooter}
          renderItem={({ item }) => renderActivityRow(item)}
          contentContainerStyle={
            visibleAllItems.length === 0
              ? { flexGrow: 1, paddingBottom: 100 }
              : { paddingBottom: 100, paddingTop: 4 }
          }
        />
      ) : (
        <FlatList<Envelope>
          data={envelopes}
          keyExtractor={(item) => envelopeDisplayId(item)}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} />
          }
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={{ color: colors.textSecondary }}>
                {hasListFilters ? 'No matching envelopes' : 'No envelopes'}
              </Text>
            </View>
          }
          ListFooterComponent={listFooter}
          renderItem={({ item }) => {
            const envelopeActions = envelopeActionHandlers(item);
            return (
              <EnvelopeListItem
                envelope={item}
                tab={tab}
                onPress={() => router.push(hubDetailRoute(envelopeDisplayId(item)))}
                onSign={
                  item.inbox_context?.can_sign
                    ? () => router.push(hubSignRoute(envelopeDisplayId(item)))
                    : undefined
                }
                onViewCompletedPdf={envelopeActions.onViewCompletedPdf}
                onShare={envelopeActions.onShare}
                onViewSubmissions={envelopeActions.onViewSubmissions}
                onViewAuditTrail={envelopeActions.onViewAuditTrail}
              />
            );
          }}
          contentContainerStyle={
            envelopes.length === 0
              ? { flexGrow: 1, paddingBottom: 100 }
              : { paddingBottom: 100, paddingTop: 4 }
          }
        />
      )}
      <TouchableOpacity style={styles.fab} onPress={() => chooserSheet.open()}>
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>

      <SignatureCreateChooser
        visible={chooserSheet.visible}
        expandNonce={chooserSheet.expandNonce}
        onClose={chooserSheet.close}
        onPrepare={() => router.push(hubPrepareRoute())}
        onFill={() => router.push(hubFillRoute())}
      />

      {viewerFile ? (
        <DocumentViewer
          fileId={viewerFile.id}
          fileName={viewerFile.name}
          fileType="application/pdf"
          onClose={() => setViewerFile(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}
