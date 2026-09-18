import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import FileNameText from '../../../components/FileNameText';
import { useFillDocumentPickList } from '../../../hooks/useFillDocumentPickList';
import { useThemeColors } from '../../../hooks/useThemeColors';
import type { FillPickFile } from '../../../services/fillDocumentListCache';
import { ensureFillableTemplateReady, listFillableTemplatesFromLibrary } from '../../../services/fillableApi';
import { formatDateToLocal } from '../../../utils/timeFormatting';
import { hubFillEditorRoute } from '../../../utils/signatureRouteResolver';

import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';

const SEARCH_DEBOUNCE_MS = 350;

function formatFileSubtitle(file: FillPickFile): string {
  const stamp = file.updatedAt ?? file.createdAt;
  const parts: string[] = [];
  if (file.fileKind && file.fileKind !== 'unknown') {
    parts.push(file.fileKind.replace(/_/g, ' '));
  }
  if (stamp) {
    const label = file.updatedAt ? 'Updated' : 'Uploaded';
    parts.push(`${label} ${formatDateToLocal(stamp)}`);
  }
  return parts.length ? parts.join(' · ') : 'Document';
}

function formatFileSize(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FillDocumentPickScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [openingLabel, setOpeningLabel] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { files, loading, loadingMore, refreshing, hasMore, loadMore, refresh } =
    useFillDocumentPickList(debouncedQuery);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query]);

  const openFile = useCallback(
    async (file: FillPickFile) => {
      if (openingId != null) return;

      const proceedNew = async () => {
        setOpeningId(file.id);
        setOpeningLabel('Preparing document…');
        try {
          const { templateId } = await ensureFillableTemplateReady(file.id, file.name);
          router.replace(hubFillEditorRoute(templateId));
        } catch (e: unknown) {
          Alert.alert('Error', e instanceof Error ? e.message : 'Could not open document');
          setOpeningId(null);
          setOpeningLabel(null);
        }
      };

      setOpeningId(file.id);
      try {
        let existing: Awaited<ReturnType<typeof listFillableTemplatesFromLibrary>> = [];
        try {
          existing = await listFillableTemplatesFromLibrary(file.id);
        } catch {
          existing = [];
        }
        if (existing.length > 0) {
          const latest = existing[0];
          const extraCount = existing.length - 1;
          setOpeningId(null);
          Alert.alert(
            'Already prepared',
            extraCount > 0
              ? `You already have ${existing.length} fillable copies of "${file.name}". Open the latest, or make another?`
              : `"${file.name}" already has a fillable template. Open it, or make another copy?`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Make another', onPress: () => void proceedNew() },
              {
                text: extraCount > 0 ? 'Open latest' : 'Open existing',
                onPress: () => {
                  router.replace(hubFillEditorRoute(latest.public_id || latest.id));
                },
              },
            ],
          );
          return;
        }
      } catch (e: unknown) {
        Alert.alert('Error', e instanceof Error ? e.message : 'Could not open document');
        setOpeningId(null);
        setOpeningLabel(null);
        return;
      }

      await proceedNew();
    },
    [openingId, router],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          paddingVertical: 10,
          gap: 10, backgroundColor: colors.headerBackground },
        headerTitle: { flex: 1, fontSize: 18, fontWeight: '600', color: colors.text },
        searchWrap: {
          flexDirection: 'row',
          alignItems: 'center',
          marginHorizontal: 16,
          marginBottom: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: colors.border ?? '#E5E7EB',
          backgroundColor: colors.card ?? colors.background,
          gap: 8,
        },
        searchInput: { flex: 1, fontSize: 16, color: colors.text, padding: 0 },
        hint: {
          paddingHorizontal: 16,
          paddingBottom: 8,
          fontSize: 13,
          color: colors.textSecondary,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 14,
          gap: 8,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border ?? '#E5E7EB',
        },
        rowBody: { flex: 1, minWidth: 0 },
        rowTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
        rowSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
        empty: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 40,
          gap: 8,
        },
        footer: { paddingVertical: 16 },
        preparingBanner: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingVertical: 10,
          paddingHorizontal: 16,
          backgroundColor: `${colors.primary}12`,
        },
        preparingText: { fontSize: 13, color: colors.textSecondary },
      }),
    [colors],
  );

  const showInitialSpinner = loading && files.length === 0 && !refreshing;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton onPress={() => { if (openingId == null) router.back(); }} />
        <AppHeaderTitle>Choose document</AppHeaderTitle>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textSecondary} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search your files"
          placeholderTextColor={colors.textSecondary}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.hint}>Your files · newest first</Text>

      {openingLabel ? (
        <View style={styles.preparingBanner}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.preparingText}>{openingLabel}</Text>
        </View>
      ) : null}

      {showInitialSpinner ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item) => String(item.id)}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />
          }
          onEndReached={() => {
            if (hasMore && !loadingMore && !loading) {
              void loadMore();
            }
          }}
          onEndReachedThreshold={0.35}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 16 }}>
                {debouncedQuery ? 'No matching files' : 'No files yet'}
              </Text>
              <Text style={{ color: colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
                {debouncedQuery
                  ? 'Try a different search term.'
                  : 'Upload a document from the previous screen to get started.'}
              </Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footer}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const busy = openingId === item.id;
            const sizeLabel = formatFileSize(item.fileSize);
            const subtitle = formatFileSubtitle(item);
            return (
              <FeedbackTouchable
                style={[styles.row, busy && { opacity: 0.6 }]}
                disabled={openingId != null}
                loading={busy}
                spinnerColor={colors.primary}
                replaceWithSpinner={false}
                onPress={() => openFile(item)}
              >
                <View style={styles.rowBody}>
                  <FileNameText name={item.name} style={styles.rowTitle} />
                  <Text style={styles.rowSub}>
                    {subtitle}
                    {sizeLabel ? ` · ${sizeLabel}` : ''}
                  </Text>
                </View>
                {busy ? (
                  <ActivityIndicator color={colors.primary} />
                ) : (
                  <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                )}
              </FeedbackTouchable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
