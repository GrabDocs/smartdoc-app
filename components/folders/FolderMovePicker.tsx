import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import type { FolderRowModel } from '../../types/folder';
import AppHeaderTitle from '../AppHeaderTitle';
import { truncateAppHeaderTitle } from '../../utils/chatTitleDisplay';
import FolderBreadcrumb from './FolderBreadcrumb';
import FolderListItem from './FolderListItem';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (folderId: number | null) => void;
  workspaceId?: number;
  title?: string;
  /** Render inside an existing Modal (avoids nested-modal hang). */
  embedded?: boolean;
}

export default function FolderMovePicker({
  visible,
  onClose,
  onSelect,
  workspaceId,
  title = 'Move to folder',
  embedded = false,
}: Props) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const topInset = embedded
    ? 0
    : insets.top > 0
      ? insets.top
      : Platform.OS === 'ios'
        ? 54
        : StatusBar.currentHeight || 28;
  const [pickerFolderId, setPickerFolderId] = useState<number | null>(null);
  const [trail, setTrail] = useState<{ id: number | null; name: string }[]>([{ id: null, name: 'My Files' }]);
  const [folders, setFolders] = useState<FolderRowModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async (parentId: number | null) => {
    setLoading(true);
    setError('');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), 10000);
    try {
      const res = await apiService.listFolders({
        parentId,
        workspaceId,
        limit: 100,
        signal: ctrl?.signal,
      });
      setFolders(res.folders ?? []);
    } catch {
      setFolders([]);
      setError('Folders took too long to load. You can still use My Files (root).');
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible) {
      setPickerFolderId(null);
      setTrail([{ id: null, name: 'My Files' }]);
      void load(null);
    }
  }, [visible, workspaceId]);

  const choose = (id: number | null) => {
    onSelect(id);
    onClose();
  };

  const currentName = trail[trail.length - 1]?.name || 'My Files';

  const goToTrailIndex = (idx: number) => {
    const next = trail.slice(0, idx + 1);
    const last = next[next.length - 1];
    setTrail(next);
    setPickerFolderId(last?.id ?? null);
    void load(last?.id ?? null);
  };

  if (!visible && !embedded) return null;

  const body = (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingTop: topInset,
          paddingBottom: embedded ? 8 : Math.max(insets.bottom, 12),
        },
      ]}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.closeBtn} accessibilityLabel="Close">
          <Ionicons name="close" size={28} color={colors.text} />
        </TouchableOpacity>
        <AppHeaderTitle shrink={false}>
          {truncateAppHeaderTitle(currentName || 'Folder')}
        </AppHeaderTitle>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.cancelBtn}>
          <Text style={{ color: colors.primary, fontSize: 16, fontWeight: '600' }}>Cancel</Text>
        </TouchableOpacity>
      </View>
      {title ? (
        <Text style={[styles.context, { color: colors.textSecondary }]} numberOfLines={1}>
          {title}
        </Text>
      ) : null}
      <FolderBreadcrumb items={trail} onPress={goToTrailIndex} />
      <TouchableOpacity style={[styles.rootBtn, { borderColor: colors.border }]} onPress={() => choose(null)}>
        <Text style={{ color: colors.primary, fontWeight: '600' }}>Use My Files (root)</Text>
      </TouchableOpacity>
      {error ? (
        <TouchableOpacity onPress={() => void load(pickerFolderId)} style={{ paddingHorizontal: 16, marginBottom: 8 }}>
          <Text style={{ color: '#B45309', fontSize: 13 }}>{error} Tap to retry.</Text>
        </TouchableOpacity>
      ) : null}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />
      ) : (
        <FlatList
          data={folders}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <FolderListItem
              folder={item}
              onPress={() => {
                setPickerFolderId(item.id);
                setTrail((t) => [...t, { id: item.id, name: item.name }]);
                void load(item.id);
              }}
              onLongPress={() => choose(item.id)}
            />
          )}
          ListEmptyComponent={
            !error ? (
              <Text style={[styles.empty, { color: colors.textSecondary }]}>No subfolders</Text>
            ) : null
          }
        />
      )}
      <TouchableOpacity style={[styles.selectBtn, { backgroundColor: colors.primary }]} onPress={() => choose(pickerFolderId)}>
        <Text style={styles.selectBtnText}>
          {pickerFolderId == null ? 'Use My Files (root)' : `Select “${currentName}”`}
        </Text>
      </TouchableOpacity>
    </View>
  );

  if (embedded) return body;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      {body}
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    minHeight: 48,
  },
  closeBtn: { padding: 8, width: 44 },
  cancelBtn: { padding: 8, minWidth: 64, alignItems: 'flex-end' },
  title: { flex: 1, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  context: { fontSize: 12, paddingHorizontal: 16, marginBottom: 2 },
  rootBtn: {
    marginHorizontal: 16,
    marginVertical: 8,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  empty: { textAlign: 'center', marginTop: 24, padding: 16 },
  selectBtn: {
    margin: 16,
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  selectBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
