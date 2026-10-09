import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import ActionMenuModal, { type ActionMenuItem } from '../ActionMenuModal';

type Pane = 'with-me' | 'links';

type LinkFile = { id: number | null; name: string; deleted?: boolean };

type SharedLink = {
  kind: 'file' | 'set';
  id: number;
  file_id: number | null;
  role: string;
  general_access: string;
  phone_verification_required: boolean;
  phone_number?: string | null;
  status: 'active' | 'revoked' | 'expired';
  expires_at: string | null;
  created_at: string | null;
  share_url: string | null;
  files: LinkFile[];
};

type SharedSender = {
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
};

type SharedItem = {
  id: number | string;
  file_id?: number;
  item_type?: string;
  share_type?: string;
  file?: { id: number; original_filename?: string; file_kind?: string };
  bookmark_id?: number;
  bookmark_name?: string;
  file_count?: number;
  files?: Array<{ id: number; original_filename?: string }>;
  asset_type?: string;
  asset_id?: number;
  meeting_id?: number;
  workspace_id?: number;
  workspace_name?: string;
  name?: string;
  meeting_name?: string;
  sender?: SharedSender;
  permissions?: string;
  created_at?: string;
};

type PopupFile = { key: string; name: string; deleted?: boolean };

function formatWhen(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}

function accessLabel(value: string): string {
  return value === 'anyone' ? 'Anyone with the link' : 'Sign-in required';
}

function senderName(sender?: SharedSender): string {
  if (!sender) return 'Unknown';
  if (sender.firstName && sender.lastName) return `${sender.firstName} ${sender.lastName}`;
  return sender.username || sender.email || 'Unknown';
}

function fileLinkLabel(files: Array<{ name: string }>): string {
  if (files.length === 0) return 'No files';
  if (files.length === 1) return files[0].name;
  return `${files[0].name} · ${files.length} files`;
}

function sharedItemName(item: SharedItem): string {
  if (item.item_type === 'meeting_asset') return item.name || item.meeting_name || 'Meeting asset';
  if (item.item_type === 'workspace_bookmark') return item.bookmark_name || 'Bookmark';
  return item.file?.original_filename || item.name || `File ${item.file_id ?? ''}`;
}

function sharedSearchText(item: SharedItem): string {
  const sender = item.sender;
  const senderBits = sender
    ? [sender.firstName, sender.lastName, sender.username, sender.email].filter(Boolean).join(' ')
    : '';
  const fileNames = (item.files || []).map((file) => file.original_filename).join(' ');
  return [
    sharedItemName(item),
    item.file?.file_kind,
    item.workspace_name,
    item.asset_type,
    item.permissions,
    senderBits,
    fileNames,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function linkSearchText(link: SharedLink): string {
  const fileNames = link.files.map((file) => file.name).join(' ');
  const access = link.general_access === 'anyone' ? 'anyone with the link' : 'sign-in required';
  const phone = link.phone_verification_required
    ? `phone verification ${link.phone_number || ''}`
    : 'no phone verification';
  return [fileNames, link.role, access, phone, link.status, link.share_url].join(' ').toLowerCase();
}

export default function FilesSharedSection() {
  const colors = useThemeColors();
  const [pane, setPane] = useState<Pane>('with-me');
  const [linksOpened, setLinksOpened] = useState(false);
  const [search, setSearch] = useState('');

  const [sharedItems, setSharedItems] = useState<SharedItem[]>([]);
  const [sharedLoading, setSharedLoading] = useState(true);
  const [sharedLoadingMore, setSharedLoadingMore] = useState(false);
  const [sharedSettled, setSharedSettled] = useState(false);
  const [sharedError, setSharedError] = useState<string | null>(null);

  const [links, setLinks] = useState<SharedLink[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksLoadingMore, setLinksLoadingMore] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<{ title: string; items: ActionMenuItem[] } | null>(null);
  const [popup, setPopup] = useState<{ title: string; files: PopupFile[]; loading: boolean } | null>(null);

  const loadShared = useCallback(async () => {
    setSharedError(null);
    setSharedSettled(false);
    setSharedItems([]);
    setSharedLoading(true);
    let rows: SharedItem[] = [];
    try {
      for (const phase of ['fast', 'rest'] as const) {
        let offset = 0;
        let more = true;
        while (more) {
          const data = await apiClient.getFilesSharedWithMe({ limit: 100, offset, phase });
          if (!data?.success) throw new Error(data?.message || 'Failed to load shared files');
          const page = (data.shared_files || []) as SharedItem[];
          const seen = new Set(rows.map((item) => String(item.id)));
          for (const item of page) {
            const key = String(item.id);
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push(item);
          }
          rows = [...rows].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
          setSharedItems(rows);
          setSharedLoading(false);
          setSharedLoadingMore(true);
          more = !!data.has_more && data.next_offset != null;
          offset = data.next_offset ?? 0;
        }
      }
    } catch (error: any) {
      setSharedError(error?.message || 'Failed to load shared files');
    } finally {
      setSharedLoading(false);
      setSharedLoadingMore(false);
      setSharedSettled(true);
    }
  }, []);

  const loadLinks = useCallback(async () => {
    setLinksError(null);
    setLinks([]);
    setLinksLoading(true);
    const collected: SharedLink[] = [];
    let offset = 0;
    let more = true;
    try {
      while (more) {
        const data = await apiClient.getMyShareLinks({ limit: 25, offset });
        if (!data?.success) throw new Error(data?.message || 'Failed to load share links');
        collected.push(...((data.links || []) as SharedLink[]));
        setLinks([...collected]);
        setLinksLoading(false);
        more = !!data.has_more && data.next_offset != null;
        setLinksLoadingMore(more);
        offset = data.next_offset ?? 0;
      }
    } catch (error: any) {
      setLinksError(error?.message || 'Failed to load share links');
    } finally {
      setLinksLoading(false);
      setLinksLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void loadShared();
  }, [loadShared]);

  useEffect(() => {
    if (linksOpened) void loadLinks();
  }, [linksOpened, loadLinks]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (pane === 'links') await loadLinks();
    else await loadShared();
    setRefreshing(false);
  }, [pane, loadLinks, loadShared]);

  const openLinkFiles = useCallback((link: SharedLink) => {
    setPopup({
      title: fileLinkLabel(link.files),
      loading: false,
      files: link.files.map((file, index) => ({
        key: `${file.id ?? 'gone'}-${index}`,
        name: file.deleted ? `${file.name} (deleted)` : file.name,
        deleted: file.deleted,
      })),
    });
  }, []);

  const openSharedFiles = useCallback(async (item: SharedItem) => {
    if (item.item_type === 'workspace_bookmark' && item.bookmark_id != null) {
      const existing = item.files || [];
      if (existing.length > 0) {
        setPopup({
          title: item.bookmark_name || 'Bookmark',
          loading: false,
          files: existing.map((file) => ({
            key: String(file.id),
            name: file.original_filename || 'File',
          })),
        });
        return;
      }
      setPopup({ title: item.bookmark_name || 'Bookmark', loading: true, files: [] });
      try {
        const data = await apiClient.getSharedBookmarkFiles(item.bookmark_id, item.workspace_id);
        const files = (data?.files || []) as Array<{ id: number; original_filename?: string }>;
        setPopup({
          title: data?.bookmark_name || item.bookmark_name || 'Bookmark',
          loading: false,
          files: files.map((file) => ({
            key: String(file.id),
            name: file.original_filename || 'File',
          })),
        });
      } catch (error: any) {
        setPopup(null);
        Alert.alert('Shared files', error?.message || 'Failed to load bookmark files');
      }
      return;
    }

    if (item.item_type === 'meeting_asset') {
      setPopup({
        title: sharedItemName(item),
        loading: false,
        files: [
          {
            key: String(item.id),
            name: item.meeting_name
              ? `${sharedItemName(item)} · ${item.meeting_name}`
              : sharedItemName(item),
          },
        ],
      });
      return;
    }

    const name = item.file?.original_filename || item.name || 'File';
    setPopup({
      title: name,
      loading: false,
      files: [{ key: String(item.file?.id ?? item.file_id ?? item.id), name }],
    });
  }, []);

  const copyLink = useCallback(async (url: string) => {
    await Clipboard.setStringAsync(url);
    Toast.show({ type: 'success', text1: 'Link copied' });
  }, []);

  const revokeLink = useCallback((link: SharedLink) => {
    Alert.alert('Revoke link', 'Anyone using this link will lose access.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: () => {
          if (link.kind !== 'set' && link.file_id == null) {
            Alert.alert('Revoke link', 'This file is no longer available.');
            return;
          }
          void (async () => {
            try {
              const data = link.kind === 'set'
                ? await apiClient.revokeShareSet(link.id)
                : await apiClient.revokeFileShare(link.file_id as number, link.id);
              if (!data?.success) throw new Error(data?.message || 'Failed to revoke');
              setLinks((prev) => prev.map((row) => (
                row.kind === link.kind && row.id === link.id ? { ...row, status: 'revoked' } : row
              )));
              Toast.show({ type: 'success', text1: 'Share link revoked' });
            } catch (error: any) {
              Alert.alert('Revoke link', error?.message || 'Failed to revoke');
            }
          })();
        },
      },
    ]);
  }, []);

  const deleteLink = useCallback((link: SharedLink) => {
    Alert.alert(
      'Delete link',
      'This permanently deletes the share link. Anyone with it will lose access.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (link.kind !== 'set' && link.file_id == null) {
              Alert.alert('Delete link', 'This file is no longer available.');
              return;
            }
            void (async () => {
              try {
                const data = link.kind === 'set'
                  ? await apiClient.revokeShareSet(link.id, true)
                  : await apiClient.deleteFileShare(link.file_id as number, link.id);
                if (!data?.success) throw new Error(data?.message || 'Failed to delete');
                setLinks((prev) => prev.filter((row) => !(row.kind === link.kind && row.id === link.id)));
                Toast.show({ type: 'success', text1: 'Share link deleted' });
              } catch (error: any) {
                Alert.alert('Delete link', error?.message || 'Failed to delete');
              }
            })();
          },
        },
      ]
    );
  }, []);

  const exitShare = useCallback((item: SharedItem) => {
    const name = sharedItemName(item);
    Alert.alert('Exit share', `You will no longer see "${name}".`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Exit',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              let data;
              if (item.item_type === 'meeting_asset') {
                data = await apiClient.hideSharedItem({
                  share_type: 'meeting_asset',
                  asset_type: item.asset_type || 'transcript',
                  asset_id: item.asset_id as number,
                  workspace_id: item.workspace_id,
                });
              } else if (item.item_type === 'workspace_bookmark' && item.bookmark_id != null) {
                data = await apiClient.hideSharedItem({
                  share_type: 'bookmark_workspace_visibility',
                  asset_type: 'bookmark',
                  asset_id: item.bookmark_id,
                  workspace_id: item.workspace_id,
                });
              } else if (item.item_type === 'workspace_file' || item.share_type === 'file_workspace_visibility') {
                data = await apiClient.hideSharedItem({
                  share_type: 'file_workspace_visibility',
                  asset_type: item.asset_type || 'file',
                  asset_id: (item.asset_id ?? item.file_id) as number,
                  workspace_id: item.workspace_id,
                });
              } else {
                data = await apiClient.exitFileShare(Number(item.id));
              }
              if (!data?.success) throw new Error(data?.message || data?.error || 'Failed to exit share');
              setSharedItems((prev) => prev.filter((row) => row.id !== item.id));
              Toast.show({ type: 'success', text1: 'You have exited this share' });
            } catch (error: any) {
              Alert.alert('Exit share', error?.message || 'Failed to exit share');
            }
          })();
        },
      },
    ]);
  }, []);

  const openLinkMenu = useCallback((link: SharedLink) => {
    const items: ActionMenuItem[] = [];
    if (link.share_url) {
      items.push({
        id: 'copy',
        label: 'Copy link',
        icon: 'copy-outline',
        onPress: () => copyLink(link.share_url as string),
      });
    }
    if (link.status !== 'revoked') {
      items.push({
        id: 'revoke',
        label: 'Revoke',
        icon: 'close-circle-outline',
        destructive: true,
        onPress: () => revokeLink(link),
      });
    }
    items.push({
      id: 'delete',
      label: 'Delete',
      icon: 'trash-outline',
      destructive: true,
      onPress: () => deleteLink(link),
    });
    setMenu({ title: fileLinkLabel(link.files), items });
  }, [copyLink, revokeLink, deleteLink]);

  const openSharedMenu = useCallback((item: SharedItem) => {
    setMenu({
      title: sharedItemName(item),
      items: [
        {
          id: 'exit',
          label: 'Exit share',
          icon: 'exit-outline',
          destructive: true,
          onPress: () => exitShare(item),
        },
      ],
    });
  }, [exitShare]);

  const query = search.trim().toLowerCase();
  const visibleShared = useMemo(
    () => (query ? sharedItems.filter((item) => sharedSearchText(item).includes(query)) : sharedItems),
    [sharedItems, query]
  );
  const visibleLinks = useMemo(
    () => (query ? links.filter((link) => linkSearchText(link).includes(query)) : links),
    [links, query]
  );

  const tabStyle = (active: boolean) => [
    styles.tab,
    { backgroundColor: active ? colors.card : 'transparent' },
  ];

  const renderShared = ({ item }: { item: SharedItem }) => {
    const kind = item.item_type === 'meeting_asset'
      ? (item.asset_type || 'Meeting')
      : item.item_type === 'workspace_bookmark'
        ? 'Bookmark'
        : (item.file?.file_kind || 'File');
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardBody}>
          <TouchableOpacity onPress={() => void openSharedFiles(item)} accessibilityRole="link">
            <Text style={[styles.fileLink, { color: colors.primary }]} numberOfLines={2}>
              {sharedItemName(item)}
            </Text>
          </TouchableOpacity>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {kind}
            {item.workspace_name ? ` · ${item.workspace_name}` : ''}
            {item.item_type === 'workspace_bookmark' && item.file_count != null ? ` · ${item.file_count} files` : ''}
          </Text>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            Shared by {senderName(item.sender)} · {formatWhen(item.created_at)}
            {item.permissions ? ` · ${item.permissions}` : ''}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.kebab}
          onPress={() => openSharedMenu(item)}
          accessibilityLabel="Share actions"
          accessibilityRole="button"
        >
          <Ionicons name="ellipsis-vertical" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    );
  };

  const renderLink = ({ item }: { item: SharedLink }) => {
    const statusColor = item.status === 'active' ? '#16a34a' : item.status === 'expired' ? '#d97706' : '#dc2626';
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardBody}>
          <TouchableOpacity onPress={() => openLinkFiles(item)} accessibilityRole="link">
            <Text style={[styles.fileLink, { color: colors.primary }]} numberOfLines={2}>
              {fileLinkLabel(item.files)}
            </Text>
          </TouchableOpacity>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {(item.role || 'viewer').replace(/^./, (letter) => letter.toUpperCase())} · {accessLabel(item.general_access)}
          </Text>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {item.phone_verification_required ? 'Phone verification' : 'No phone verification'}
            {' · '}Created {formatWhen(item.created_at)}
            {' · '}{item.expires_at ? `Expires ${formatWhen(item.expires_at)}` : 'No expiration'}
          </Text>
          <Text style={[styles.status, { color: statusColor }]}>{item.status}</Text>
        </View>
        <TouchableOpacity
          style={styles.kebab}
          onPress={() => openLinkMenu(item)}
          accessibilityLabel="Link actions"
          accessibilityRole="button"
        >
          <Ionicons name="ellipsis-vertical" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    );
  };

  const sharedEmpty = sharedError
    ? sharedError
    : query
      ? `No shared items match “${search.trim()}”.`
      : 'Files and meeting assets shared with you will appear here.';
  const linksEmpty = linksError
    ? linksError
    : query
      ? `No links match “${search.trim()}”.`
      : 'Links you create from a file will appear here.';

  return (
    <View style={styles.root}>
      <View style={[styles.tabs, { backgroundColor: colors.isDark ? '#1f2937' : '#f3f4f6' }]}>
        <TouchableOpacity style={tabStyle(pane === 'with-me')} onPress={() => setPane('with-me')}>
          <Text style={[styles.tabText, { color: pane === 'with-me' ? colors.primary : colors.textSecondary }]}>
            Shared with me
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={tabStyle(pane === 'links')}
          onPress={() => {
            setLinksOpened(true);
            setPane('links');
          }}
        >
          <Text style={[styles.tabText, { color: pane === 'links' ? colors.primary : colors.textSecondary }]}>
            Links Shared
          </Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.search, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="search" size={18} color={colors.textSecondary} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={pane === 'with-me' ? 'Search shared items' : 'Search links'}
          placeholderTextColor={colors.textSecondary}
          style={[styles.searchInput, { color: colors.text }]}
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel={pane === 'with-me' ? 'Search shared items' : 'Search links'}
        />
      </View>

      {pane === 'with-me' ? (
        <FlatList
          data={visibleShared}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderShared}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            !sharedSettled && sharedLoading ? (
              <ActivityIndicator style={styles.loader} color={colors.primary} />
            ) : (
              <Text style={[styles.empty, { color: colors.textSecondary }]}>
                {sharedSettled || sharedError ? sharedEmpty : ''}
              </Text>
            )
          }
          ListFooterComponent={
            sharedLoadingMore ? <Text style={[styles.more, { color: colors.textSecondary }]}>Loading more…</Text> : null
          }
        />
      ) : (
        <FlatList
          data={visibleLinks}
          keyExtractor={(item) => `${item.kind}-${item.id}`}
          renderItem={renderLink}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            linksLoading && links.length === 0 ? (
              <ActivityIndicator style={styles.loader} color={colors.primary} />
            ) : (
              <Text style={[styles.empty, { color: colors.textSecondary }]}>
                {!linksLoading || linksError ? linksEmpty : ''}
              </Text>
            )
          }
          ListFooterComponent={
            linksLoadingMore ? <Text style={[styles.more, { color: colors.textSecondary }]}>Loading more…</Text> : null
          }
        />
      )}

      <ActionMenuModal
        visible={!!menu}
        title={menu?.title}
        items={menu?.items || []}
        onClose={() => setMenu(null)}
      />

      <Modal visible={!!popup} transparent animationType="fade" onRequestClose={() => setPopup(null)}>
        <TouchableOpacity style={styles.scrim} activeOpacity={1} onPress={() => setPopup(null)}>
          <View
            style={[styles.popup, { backgroundColor: colors.card }]}
            onStartShouldSetResponder={() => true}
          >
            <Text style={[styles.popupTitle, { color: colors.text }]} numberOfLines={2}>
              {popup?.title}
            </Text>
            {popup?.loading ? (
              <ActivityIndicator style={styles.loader} color={colors.primary} />
            ) : (
              <FlatList
                data={popup?.files || []}
                keyExtractor={(file) => file.key}
                style={styles.popupList}
                ListEmptyComponent={
                  <Text style={[styles.meta, { color: colors.textSecondary }]}>No files</Text>
                }
                renderItem={({ item }) => (
                  <Text
                    style={[
                      styles.popupFile,
                      { color: item.deleted ? colors.textSecondary : colors.text },
                      item.deleted && styles.deletedFile,
                    ]}
                  >
                    {item.name}
                  </Text>
                )}
              />
            )}
            <TouchableOpacity onPress={() => setPopup(null)} accessibilityRole="button">
              <Text style={[styles.close, { color: colors.primary }]}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  tabs: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 10,
    padding: 4,
  },
  tab: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  tabText: { fontSize: 14, fontWeight: '600' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 16 },
  list: { padding: 16, paddingBottom: 88, flexGrow: 1 },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  cardBody: { flex: 1, minWidth: 0 },
  fileLink: { fontSize: 16, fontWeight: '600', textDecorationLine: 'underline' },
  meta: { marginTop: 4, fontSize: 13, lineHeight: 18 },
  status: { marginTop: 6, fontSize: 13, fontWeight: '600', textTransform: 'capitalize' },
  kebab: { padding: 4, marginLeft: 8 },
  loader: { marginTop: 32 },
  empty: { textAlign: 'center', marginTop: 32, fontSize: 15, lineHeight: 22, paddingHorizontal: 12 },
  more: { textAlign: 'center', paddingVertical: 12 },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  popup: { borderRadius: 14, padding: 16, maxHeight: '70%' },
  popupTitle: { fontSize: 17, fontWeight: '700', marginBottom: 12 },
  popupList: { flexGrow: 0 },
  popupFile: { fontSize: 15, paddingVertical: 8 },
  deletedFile: { textDecorationLine: 'line-through' },
  close: { marginTop: 12, fontSize: 16, fontWeight: '600', textAlign: 'right' },
});
