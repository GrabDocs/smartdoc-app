import { Ionicons } from '@expo/vector-icons';
import { Redirect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import ActionMenuModal, { type ActionMenuItem } from '../../components/ActionMenuModal';
import DocumentViewer from '../../components/DocumentViewer';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  hideImport,
  importCanRetry,
  importCanView,
  listWorkspaceImports,
  mailboxPendingCount,
  retryImport,
  viewEmailErrorMessage,
  viewEmailFromImport,
  type EmailImportEvent,
} from '../../services/emailSyncApi';
import { formatEmailWhen, getFileTypeFromFilename, importSourceLabel, importStatusBadge, senderDisplayName, senderNameAndEmail } from './_components/emailFormat';
import { emailSyncCacheImports, emailSyncCacheSetImports, emailSyncCacheSetPending } from './_components/emailSyncCache';

function ImportRow({
  item,
  workspaceId,
  onView,
  onRetry,
  onRemove,
}: {
  item: EmailImportEvent;
  workspaceId: number;
  onView: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const colors = useThemeColors();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [viewingEmail, setViewingEmail] = useState(false);
  const badge = importStatusBadge(item.status, item.failure_category, colors.isDark);
  const when = formatEmailWhen(item.created_at);
  const source = importSourceLabel(item.source_type);
  const senderName = senderDisplayName(item.email_sender);
  const senderDetail = senderNameAndEmail(item.email_sender);

  const onViewEmail = useCallback(async () => {
    if (viewingEmail) return;
    setViewingEmail(true);
    try {
      const { thread_id } = await viewEmailFromImport(item.id);
      // Stay on email-sync: switch to Replies → Dismissed, then open the thread.
      router.setParams({
        tab: 'replies',
        filter: 'dismissed',
        threadId: String(thread_id),
        workspaceId: String(workspaceId),
      } as any);
    } catch (e) {
      Alert.alert('View email', viewEmailErrorMessage(e));
    } finally {
      setViewingEmail(false);
    }
  }, [item.id, router, viewingEmail, workspaceId]);

  const items = useMemo((): ActionMenuItem[] => {
    const next: ActionMenuItem[] = [];
    next.push({
      id: 'view-email',
      label: viewingEmail ? 'Loading…' : 'View email',
      icon: 'mail-outline',
      iconColor: '#007AFF',
      onPress: () => {
        void onViewEmail();
      },
    });
    if (importCanView(item)) {
      next.push({ id: 'view', label: 'View', icon: 'eye-outline', iconColor: '#007AFF', onPress: onView });
    }
    if (importCanRetry(item)) {
      next.push({ id: 'retry', label: 'Retry', icon: 'refresh', iconColor: '#007AFF', onPress: onRetry });
    }
    next.push({
      id: 'remove',
      label: 'Remove from list',
      icon: 'trash-outline',
      destructive: true,
      onPress: onRemove,
    });
    return next;
  }, [item, onRemove, onRetry, onView, onViewEmail, viewingEmail]);

  return (
    <>
      <TouchableOpacity
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={importCanView(item) ? onView : () => setMenu(true)}
        activeOpacity={0.7}
      >
        <View style={styles.cardBody}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {item.attachment_filename || item.email_subject || `Import ${item.id}`}
          </Text>
          <View style={styles.metaRow}>
            <View style={[styles.badge, { backgroundColor: badge.backgroundColor }]}>
              <Text style={[styles.badgeTxt, { color: badge.color }]}>{badge.label}</Text>
            </View>
            <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
              {source}
            </Text>
            {when ? (
              <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
                {when}
              </Text>
            ) : null}
            {senderName ? (
              <Text style={[styles.meta, styles.sender, { color: colors.textSecondary }]} numberOfLines={1}>
                {senderName}
              </Text>
            ) : null}
          </View>
        </View>
        <TouchableOpacity
          style={styles.kebab}
          onPress={() => setMenu(true)}
          hitSlop={8}
          accessibilityLabel="Import actions"
        >
          <Ionicons name="ellipsis-vertical" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </TouchableOpacity>
      <ActionMenuModal
        visible={menu}
        title={item.attachment_filename || item.email_subject || 'Import'}
        message={senderDetail || undefined}
        items={items}
        onClose={() => setMenu(false)}
      />
    </>
  );
}

export function EmailImportsPane({
  workspaceId,
  onPending,
}: {
  workspaceId: number;
  onPending: (n: number) => void;
}) {
  const colors = useThemeColors();
  const cached = emailSyncCacheImports();
  const [items, setItems] = useState<EmailImportEvent[]>(cached?.items || []);
  const [cursor, setCursor] = useState<string | null>(cached?.cursor || null);
  const [loading, setLoading] = useState(!cached);
  const [viewer, setViewer] = useState<{ fileId: number; fileName: string } | null>(null);

  const load = useCallback(async (append = false) => {
    const [page, count] = await Promise.all([
      listWorkspaceImports(workspaceId, { cursor: append ? cursor || undefined : undefined }),
      append ? Promise.resolve(null) : mailboxPendingCount(workspaceId).catch(() => 0),
    ]);
    const nextCursor = page.next_cursor || null;
    setItems((prev) => {
      const next = append ? [...prev, ...(page.imports || [])] : page.imports || [];
      emailSyncCacheSetImports({ items: next, cursor: nextCursor });
      return next;
    });
    setCursor(nextCursor);
    if (!append) {
      const n = Number(count) || 0;
      emailSyncCacheSetPending(n);
      onPending(n);
    }
  }, [cursor, onPending, workspaceId]);

  useEffect(() => {
    const hit = emailSyncCacheImports();
    if (hit && !hit.stale) {
      setLoading(false);
      return;
    }
    load(false)
      .catch((e) => {
        if (!hit) Alert.alert('Imports', e?.message || 'Failed');
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const removeFromHistory = (item: EmailImportEvent) => {
    const label = item.attachment_filename || 'this import';
    Alert.alert(
      'Remove from list',
      `Remove "${label}" from the list?\n\nThe imported file (if any) will not be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove from list',
          style: 'destructive',
          onPress: async () => {
            try {
              await hideImport(item.id);
              await load(false);
            } catch (e: any) {
              Alert.alert('Imports', e?.message || 'Failed to remove from history');
            }
          },
        },
      ]
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#007AFF" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => String(i.id)}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => load(false)} />}
          onEndReached={() => {
            if (cursor) load(true).catch(() => {});
          }}
          renderItem={({ item }) => (
            <ImportRow
              item={item}
              workspaceId={workspaceId}
              onView={() =>
                setViewer({
                  fileId: item.file_id as number,
                  fileName: item.attachment_filename || `File ${item.file_id}`,
                })
              }
              onRetry={async () => {
                try {
                  await retryImport(item.id);
                  await load(false);
                } catch (e: any) {
                  Alert.alert('Imports', e?.message || 'Retry failed');
                }
              }}
              onRemove={() => removeFromHistory(item)}
            />
          )}
        />
      )}
      {viewer ? (
        <DocumentViewer
          fileId={String(viewer.fileId)}
          fileName={viewer.fileName}
          fileType={getFileTypeFromFilename(viewer.fileName)}
          workspaceId={workspaceId}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </View>
  );
}

export default function EmailImportsScreen() {
  return <Redirect href={{ pathname: '/email-sync', params: { tab: 'imports' } }} />;
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginHorizontal: 14,
    marginBottom: 8,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
  },
  cardBody: { flex: 1, minWidth: 0, gap: 6 },
  title: { fontSize: 15, fontWeight: '600' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, marginTop: 6, flexWrap: 'wrap' },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, flexShrink: 0 },
  badgeTxt: { fontSize: 11, fontWeight: '600' },
  meta: { fontSize: 12, flexShrink: 0 },
  sender: { flexShrink: 1, minWidth: 0 },
  kebab: { padding: 4 },
});
