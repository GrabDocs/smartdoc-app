import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DocumentViewer from '../../../components/DocumentViewer';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import FolderMovePicker from '../../../components/folders/FolderMovePicker';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { apiService } from '../../../services/api';
import {
  deleteInboxAlias,
  emailSyncWorkspaceId,
  getInboxAlias,
  hideImport,
  importCanRetry,
  importCanView,
  listAliasImports,
  patchInboxAlias,
  retryImport,
  type EmailImportEvent,
  type EmailInboxAlias,
} from '../../../services/emailSyncApi';
import { CollapsibleChipList } from '../_components/CollapsibleChipList';
import { getFileTypeFromFilename } from '../_components/emailFormat';
import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';

export default function AliasDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const aliasId = Number(id);
  const router = useRouter();
  const colors = useThemeColors();
  const [alias, setAlias] = useState<EmailInboxAlias | null>(null);
  const [imports, setImports] = useState<EmailImportEvent[]>([]);
  const [senders, setSenders] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [folderId, setFolderId] = useState<number | null>(null);
  const [folderName, setFolderName] = useState('My Files (root)');
  const [folderPickOpen, setFolderPickOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ws, setWs] = useState<number | null>(null);
  const [viewer, setViewer] = useState<{ fileId: number; fileName: string } | null>(null);
  const [purpose, setPurpose] = useState<'import' | 'scheduling'>('import');

  const load = useCallback(async () => {
    const a = await getInboxAlias(aliasId);
    setAlias(a);
    setName(a.display_name || '');
    setSenders(a.allowed_senders || []);
    setPurpose(a.purpose === 'scheduling' ? 'scheduling' : 'import');
    setFolderId(a.target_folder_id ?? null);
    if (a.target_folder_id) {
      try {
        const f = await apiService.getFolderDetail(a.target_folder_id);
        setFolderName(f.folder?.name || `Folder ${a.target_folder_id}`);
      } catch {
        setFolderName(`Folder ${a.target_folder_id}`);
      }
    } else {
      setFolderName('My Files (root)');
    }
    const page = await listAliasImports(aliasId);
    setImports(page.imports || []);
    try {
      setWs(await emailSyncWorkspaceId());
    } catch {
      setWs(null);
    }
  }, [aliasId]);

  useEffect(() => {
    load()
      .catch((e) => Alert.alert('Alias', e?.message || 'Failed'))
      .finally(() => setLoading(false));
  }, [load]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.headerBackground },
        header: { flexDirection: 'row', alignItems: 'center', padding: 8, backgroundColor: colors.headerBackground },
        h1: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.text },
        input: {
          borderWidth: 1,
          borderColor: colors.border,
          margin: 12,
          borderRadius: 8,
          padding: 10,
          color: colors.text,
        },
        btn: { backgroundColor: '#007AFF', marginHorizontal: 12, marginBottom: 8, padding: 12, borderRadius: 10, alignItems: 'center' },
        btnTxt: { color: '#fff', fontWeight: '600' },
        row: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
      }),
    [colors]
  );

  if (loading || !alias) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ActivityIndicator style={{ marginTop: 40 }} color="#007AFF" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Alias</AppHeaderTitle>
      </View>
      <ScrollView style={{ backgroundColor: colors.background }}>
        <Text style={{ color: colors.text, paddingHorizontal: 12 }}>{alias.alias_address}</Text>
        <Text style={{ color: colors.textSecondary, paddingHorizontal: 12, marginTop: 8, fontSize: 13 }}>
          {purpose === 'scheduling'
            ? 'Forward appointment emails here for Assist schedule. Body-only mail is allowed; attachments are not imported.'
            : 'Forward from Gmail, Outlook, or Apple Mail to this address. Attachments are imported; this is not used for Replies.'}
        </Text>
        <TouchableOpacity
          style={styles.btn}
          onPress={async () => {
            await Clipboard.setStringAsync(alias.alias_address);
            Alert.alert('Copied', alias.alias_address);
          }}
        >
          <Text style={styles.btnTxt}>Copy address</Text>
        </TouchableOpacity>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Display name" placeholderTextColor={colors.textSecondary} />
        <Text style={{ color: colors.textSecondary, paddingHorizontal: 16, marginTop: 12, fontSize: 13 }}>
          Alias purpose
        </Text>
        <TouchableOpacity
          style={styles.input}
          onPress={() =>
            setPurpose((p) => (p === 'import' ? 'scheduling' : 'import'))
          }
        >
          <Text style={{ color: colors.text }}>
            {purpose === 'scheduling' ? 'Assist scheduling (tap to switch)' : 'Document import (tap to switch)'}
          </Text>
        </TouchableOpacity>
        <CollapsibleChipList
          title="Allowed senders"
          hint={
            purpose === 'scheduling'
              ? 'Scheduling still requires the verified owner email. Extra allowlist entries are ignored for auth.'
              : 'Only import attachments from these addresses or domains. Blank = all. Expand to view or edit.'
          }
          value={senders}
          onChange={setSenders}
          placeholder="email@example.com or @domain.com"
          emptyLabel="All senders"
        />
        {purpose === 'import' ? (
          <>
            <Text style={{ color: colors.textSecondary, paddingHorizontal: 16, marginTop: 12, fontSize: 13 }}>
              Save attachments to folder
            </Text>
            <TouchableOpacity style={styles.input} onPress={() => setFolderPickOpen(true)}>
              <Text style={{ color: colors.text }}>{folderName}</Text>
            </TouchableOpacity>
          </>
        ) : null}
        <TouchableOpacity
          style={styles.btn}
          onPress={async () => {
            await patchInboxAlias(aliasId, {
              display_name: name,
              allowed_senders: senders,
              purpose,
              target_folder_id: purpose === 'scheduling' ? null : folderId,
            });
            Alert.alert('Saved');
            await load();
          }}
        >
          <Text style={styles.btnTxt}>Save</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          onPress={() =>
            Alert.alert('Delete alias', 'Stop this forwarding address?', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                  await deleteInboxAlias(aliasId);
                  router.back();
                },
              },
            ])
          }
        >
          <Text style={styles.btnTxt}>Delete</Text>
        </TouchableOpacity>
        {purpose === 'import' ? (
          <Text style={{ color: colors.text, fontWeight: '700', padding: 12 }}>Imports</Text>
        ) : (
          <Text style={{ color: colors.textSecondary, padding: 12 }}>
            Scheduling aliases do not import attachments.
          </Text>
        )}
        {purpose === 'import' ? imports.map((ev) => (
          <View key={ev.id} style={[styles.row, { flexDirection: 'row', alignItems: 'center' }]}>
            <View style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
              <Text style={{ color: colors.text }} numberOfLines={1}>
                {ev.attachment_filename || ev.email_subject || `#${ev.id}`}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{ev.status}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {importCanView(ev) ? (
                <TouchableOpacity
                  onPress={() =>
                    setViewer({
                      fileId: ev.file_id as number,
                      fileName: ev.attachment_filename || `File ${ev.file_id}`,
                    })
                  }
                  hitSlop={8}
                  accessibilityLabel="Open"
                  style={{ padding: 8 }}
                >
                  <Ionicons name="open-outline" size={22} color="#007AFF" />
                </TouchableOpacity>
              ) : null}
              {importCanRetry(ev) ? (
                <TouchableOpacity
                  onPress={async () => {
                    try {
                      await retryImport(ev.id);
                      await load();
                    } catch (e: any) {
                      Alert.alert('Imports', e?.message || 'Retry failed');
                    }
                  }}
                  hitSlop={8}
                  accessibilityLabel="Retry"
                  style={{ padding: 8 }}
                >
                  <Ionicons name="refresh" size={22} color="#007AFF" />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                onPress={() => {
                  const label = ev.attachment_filename || 'this import';
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
                            await hideImport(ev.id);
                            await load();
                          } catch (e: any) {
                            Alert.alert('Imports', e?.message || 'Failed to remove from history');
                          }
                        },
                      },
                    ]
                  );
                }}
                hitSlop={8}
                accessibilityLabel="Remove from list"
                style={{ padding: 8 }}
              >
                <Ionicons name="trash-outline" size={22} color="#FF3B30" />
              </TouchableOpacity>
            </View>
          </View>
        )) : null}
      </ScrollView>
      {viewer ? (
        <DocumentViewer
          fileId={String(viewer.fileId)}
          fileName={viewer.fileName}
          fileType={getFileTypeFromFilename(viewer.fileName)}
          workspaceId={ws ?? undefined}
          onClose={() => setViewer(null)}
        />
      ) : null}
      <FolderMovePicker
        visible={folderPickOpen}
        title="Save attachments to"
        onClose={() => setFolderPickOpen(false)}
        onSelect={async (id) => {
          setFolderId(id);
          if (id == null) {
            setFolderName('My Files (root)');
            return;
          }
          try {
            const f = await apiService.getFolderDetail(id);
            setFolderName(f.folder?.name || `Folder ${id}`);
          } catch {
            setFolderName(`Folder ${id}`);
          }
        }}
      />
    </SafeAreaView>
  );
}
