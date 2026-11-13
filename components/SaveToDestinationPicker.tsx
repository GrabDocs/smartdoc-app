/**
 * Mobile Save-to destination: GrabDocs or Drive Connect + folder pick/create.
 * Connect link confirms leave-app and callers can persist form drafts via storageKey.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { FRONTEND_URL } from '../constants/Config';
import { useThemeColors } from '../hooks/useThemeColors';
import { apiService } from '../services/api';
import FolderMovePicker from './folders/FolderMovePicker';

export type SaveToValue = {
  save_to_type: 'grabdocs' | 'external';
  destination_folder_id: number | null;
  save_to_connection_id: number | null;
  save_to_external_folder_id: string | null;
  save_to_external_folder_path: string | null;
};

type DriveConnection = {
  id: number;
  platform: string;
  account_name?: string | null;
  is_active?: boolean;
};

type BrowseItem = { id: string; name: string; path?: string | null; is_folder: boolean };

const PROVIDER_LABEL: Record<string, string> = {
  dropbox_files: 'Dropbox',
  google_drive_files: 'Google Drive',
  onedrive_files: 'OneDrive',
};

export const emptySaveTo = (): SaveToValue => ({
  save_to_type: 'grabdocs',
  destination_folder_id: null,
  save_to_connection_id: null,
  save_to_external_folder_id: null,
  save_to_external_folder_path: null,
});

export function saveToFromRecord(rec: Partial<SaveToValue> | null | undefined): SaveToValue {
  const base = emptySaveTo();
  if (!rec) return base;
  return {
    save_to_type: rec.save_to_type === 'external' ? 'external' : 'grabdocs',
    destination_folder_id: rec.destination_folder_id ?? null,
    save_to_connection_id: rec.save_to_connection_id ?? null,
    save_to_external_folder_id: rec.save_to_external_folder_id ?? null,
    save_to_external_folder_path: rec.save_to_external_folder_path ?? null,
  };
}

export async function persistSaveToDraft(storageKey: string, draft: unknown) {
  try {
    await AsyncStorage.setItem(storageKey, JSON.stringify(draft));
  } catch {
    /* ignore */
  }
}

export async function loadSaveToDraft<T = unknown>(storageKey: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function clearSaveToDraft(storageKey: string) {
  try {
    await AsyncStorage.removeItem(storageKey);
  } catch {
    /* ignore */
  }
}

export default function SaveToDestinationPicker({
  value,
  onChange,
  workspaceId,
  grabdocsFolderName,
  onGrabdocsFolderName,
  storageKey,
  getFormDraft,
}: {
  value: SaveToValue;
  onChange: (next: SaveToValue) => void;
  workspaceId?: number | null;
  grabdocsFolderName?: string;
  onGrabdocsFolderName?: (name: string) => void;
  /** When opening Drive Connect in browser, persist form draft under this key. */
  storageKey?: string;
  getFormDraft?: () => unknown;
}) {
  const colors = useThemeColors();
  const [connections, setConnections] = useState<DriveConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [destPickOpen, setDestPickOpen] = useState(false);
  const [folderPickOpen, setFolderPickOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseItems, setBrowseItems] = useState<BrowseItem[]>([]);
  const [browseParent, setBrowseParent] = useState('root');
  const [browseStack, setBrowseStack] = useState<{ id: string; name: string }[]>([]);
  const [browsing, setBrowsing] = useState(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        label: { fontSize: 14, fontWeight: '600', color: colors.text, marginBottom: 8 },
        row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
        chip: {
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border,
        },
        chipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '22' },
        chipText: { color: colors.text, fontSize: 13 },
        chipTextActive: { color: colors.primary, fontWeight: '600' },
        link: { color: colors.primary, fontSize: 13, marginBottom: 8 },
        muted: { color: colors.textSecondary, fontSize: 12, marginBottom: 8 },
        pickerBtn: {
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
          padding: 12,
          marginBottom: 8,
        },
        pickerText: { color: colors.text, fontSize: 14 },
        modalSafe: { flex: 1, backgroundColor: colors.background },
        modalHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        },
        modalTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
        itemRow: {
          padding: 14,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        },
        itemText: { color: colors.text, fontSize: 15, flex: 1 },
      }),
    [colors],
  );

  const loadConnections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiService.client.get('/api/v1/web/grabdocs-connect/connections');
      const list = (res.data?.connections || []) as DriveConnection[];
      setConnections(
        list.filter((c) => Object.keys(PROVIDER_LABEL).includes(c.platform) && c.is_active !== false),
      );
    } catch {
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // Refresh connections when returning from Drive Connect in the browser.
  useEffect(() => {
    if (!storageKey) return;
    const sub = Linking.addEventListener('url', () => {
      void loadConnections();
    });
    return () => sub.remove();
  }, [storageKey, loadConnections]);

  const openConnect = async () => {
    const url = `${FRONTEND_URL.replace(/\/$/, '')}/grabdocs-connect`;
    Alert.alert(
      'Open Drive Connect',
      'You’ll leave the app to connect a drive in the browser. Your form will be kept when you return.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: async () => {
            if (storageKey && getFormDraft) {
              await persistSaveToDraft(storageKey, getFormDraft());
            }
            try {
              await Linking.openURL(url);
            } catch {
              Alert.alert('Could not open browser', url);
            }
          },
        },
      ],
    );
  };

  const loadBrowse = async (connectionId: number, folderId = 'root') => {
    setBrowsing(true);
    try {
      const res = await apiService.client.get(
        `/api/v1/web/grabdocs-connect/connections/${connectionId}/browse`,
        { params: { folder_id: folderId, folders_only: 1 } },
      );
      const items = ((res.data?.items || []) as BrowseItem[]).filter((i) => i.is_folder !== false);
      setBrowseItems(items);
      setBrowseParent(folderId);
    } catch (e: any) {
      Alert.alert('Browse', e?.response?.data?.error || e?.message || 'Failed');
      setBrowseItems([]);
    } finally {
      setBrowsing(false);
    }
  };

  const createExternalFolder = () => {
    if (!value.save_to_connection_id) return;
    Alert.prompt?.('New folder', 'Folder name', async (name) => {
      if (!name?.trim()) return;
      try {
        const res = await apiService.client.post(
          `/api/v1/web/grabdocs-connect/connections/${value.save_to_connection_id}/folders`,
          { name: name.trim(), parent_id: browseParent },
        );
        const folder = res.data?.folder;
        if (folder?.id) {
          onChange({
            ...value,
            save_to_external_folder_id: String(folder.id),
            save_to_external_folder_path: folder.path || folder.name || name.trim(),
          });
          setBrowseOpen(false);
        }
      } catch (e: any) {
        Alert.alert('Create folder', e?.response?.data?.error || e?.message || 'Failed');
      }
    });
    // Android Alert.prompt may be undefined — fallback
    if (typeof Alert.prompt !== 'function') {
      Alert.alert('New folder', 'Enter a folder name in the next step is not supported on this device. Select an existing folder.');
    }
  };

  const selectedConn =
    value.save_to_type === 'external' && value.save_to_connection_id
      ? connections.find((c) => c.id === value.save_to_connection_id)
      : null;
  const destinationLabel = selectedConn
    ? `${PROVIDER_LABEL[selectedConn.platform] || selectedConn.platform}${
        selectedConn.account_name ? ` — ${selectedConn.account_name}` : ''
      }`
    : 'GrabDocs';

  const folderLabel =
    value.save_to_type === 'grabdocs'
      ? grabdocsFolderName || (value.destination_folder_id ? `Folder ${value.destination_folder_id}` : 'My Files (root)')
      : value.save_to_external_folder_path ||
        (value.save_to_external_folder_id ? `Folder ${value.save_to_external_folder_id}` : 'Select folder…');

  const showSaveTo = !loading && (connections.length > 0 || value.save_to_type === 'external');

  return (
    <View>
      {showSaveTo ? (
        <>
          <Text style={styles.label}>Save to</Text>
          <TouchableOpacity
            style={styles.pickerBtn}
            onPress={() => setDestPickOpen(true)}
          >
            <Text style={styles.pickerText}>{destinationLabel}</Text>
          </TouchableOpacity>
        </>
      ) : null}

      {!loading && connections.length === 0 && (
        <TouchableOpacity onPress={() => void openConnect()}>
          <Text style={styles.link}>Connect and save to an external drive</Text>
        </TouchableOpacity>
      )}

      {value.save_to_type === 'grabdocs' && (
        <TouchableOpacity style={styles.pickerBtn} onPress={() => setFolderPickOpen(true)}>
          <Text style={styles.pickerText}>{folderLabel}</Text>
        </TouchableOpacity>
      )}

      {value.save_to_type === 'external' && value.save_to_connection_id != null && (
        <>
          <TouchableOpacity
            style={styles.pickerBtn}
            onPress={() => {
              if (!value.save_to_connection_id) return;
              setBrowseStack([]);
              setBrowseOpen(true);
              void loadBrowse(value.save_to_connection_id, 'root');
            }}
          >
            <Text style={styles.pickerText}>{folderLabel}</Text>
          </TouchableOpacity>
        </>
      )}

      <Modal visible={destPickOpen} animationType="slide" onRequestClose={() => setDestPickOpen(false)}>
        <View style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setDestPickOpen(false)}>
              <Text style={styles.link}>Close</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Save to</Text>
            <View style={{ width: 48 }} />
          </View>
          <ScrollView>
            <TouchableOpacity
              style={styles.itemRow}
              onPress={() => {
                onChange({
                  ...value,
                  save_to_type: 'grabdocs',
                  save_to_connection_id: null,
                  save_to_external_folder_id: null,
                  save_to_external_folder_path: null,
                });
                setDestPickOpen(false);
              }}
            >
              <Text style={styles.itemText}>GrabDocs</Text>
              {value.save_to_type === 'grabdocs' ? (
                <Text style={styles.link}>Selected</Text>
              ) : null}
            </TouchableOpacity>
            {connections.map((c) => (
              <TouchableOpacity
                key={c.id}
                style={styles.itemRow}
                onPress={() => {
                  onChange({
                    ...value,
                    save_to_type: 'external',
                    save_to_connection_id: c.id,
                    save_to_external_folder_id: null,
                    save_to_external_folder_path: null,
                  });
                  setDestPickOpen(false);
                }}
              >
                <Text style={styles.itemText}>
                  {PROVIDER_LABEL[c.platform] || c.platform}
                  {c.account_name ? ` — ${c.account_name}` : ''}
                </Text>
                {value.save_to_connection_id === c.id ? (
                  <Text style={styles.link}>Selected</Text>
                ) : null}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Modal>

      <FolderMovePicker
        visible={folderPickOpen}
        title="GrabDocs folder"
        workspaceId={workspaceId ?? undefined}
        onClose={() => setFolderPickOpen(false)}
        onSelect={(folderId) => {
          onChange({
            ...value,
            destination_folder_id: folderId,
          });
          onGrabdocsFolderName?.(
            folderId == null ? 'My Files (root)' : `Folder ${folderId}`,
          );
          setFolderPickOpen(false);
        }}
      />

      <Modal visible={browseOpen} animationType="slide" onRequestClose={() => setBrowseOpen(false)}>
        <View style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setBrowseOpen(false)}>
              <Text style={styles.link}>Close</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Select folder</Text>
            <TouchableOpacity onPress={createExternalFolder}>
              <Text style={styles.link}>New</Text>
            </TouchableOpacity>
          </View>
          {browseStack.length > 0 && (
            <TouchableOpacity
              style={styles.itemRow}
              onPress={() => {
                const next = browseStack.slice(0, -1);
                setBrowseStack(next);
                const parent = next.length ? next[next.length - 1].id : 'root';
                if (value.save_to_connection_id) void loadBrowse(value.save_to_connection_id, parent);
              }}
            >
              <Text style={styles.itemText}>← Up</Text>
            </TouchableOpacity>
          )}
          {browsing ? (
            <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />
          ) : (
            <ScrollView>
              {browseItems.map((item) => (
                <View key={item.id} style={styles.itemRow}>
                  <TouchableOpacity
                    style={{ flex: 1 }}
                    onPress={() => {
                      setBrowseStack((s) => [...s, { id: item.id, name: item.name }]);
                      if (value.save_to_connection_id) void loadBrowse(value.save_to_connection_id, item.id);
                    }}
                  >
                    <Text style={styles.itemText}>📁 {item.name}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      onChange({
                        ...value,
                        save_to_external_folder_id: item.id,
                        save_to_external_folder_path: item.path || item.name,
                      });
                      setBrowseOpen(false);
                    }}
                  >
                    <Text style={styles.link}>Select</Text>
                  </TouchableOpacity>
                </View>
              ))}
              {!browseItems.length && (
                <Text style={[styles.muted, { padding: 16 }]}>No folders here</Text>
              )}
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

/** Compact Save-to sync status + owner Retry for file rows. */
export function ExportSyncStatus({
  fileId,
  statusLabel,
  canRetry,
  sourceKind,
  sourceId,
  onRetried,
}: {
  fileId: number;
  statusLabel?: string | null;
  canRetry?: boolean;
  sourceKind?: string;
  sourceId?: number;
  onRetried?: () => void;
}) {
  const colors = useThemeColors();
  const [busy, setBusy] = useState(false);
  const label = statusLabel || 'Saved to GrabDocs';

  const retry = async () => {
    setBusy(true);
    try {
      await apiService.retryFileExportSync(fileId, {
        source_kind: sourceKind,
        source_id: sourceId,
      });
      onRetried?.();
    } catch (e: any) {
      Alert.alert('Sync', e?.message || 'Retry failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{label}</Text>
      {canRetry ? (
        <TouchableOpacity onPress={() => void retry()} disabled={busy} hitSlop={8}>
          <Text style={{ color: '#007AFF', fontSize: 12 }}>{busy ? 'Retrying…' : 'Retry sync'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
