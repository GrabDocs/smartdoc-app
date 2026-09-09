import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Clipboard from 'expo-clipboard';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ActionMenuModal, { type ActionMenuItem } from '../../components/ActionMenuModal';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { GoogleLogo } from '../../components/GoogleLogo';
import { MicrosoftLogo } from '../../components/MicrosoftLogo';
import FolderMovePicker from '../../components/folders/FolderMovePicker';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import {
  createInboxAlias,
  deleteInboxConnection,
  disconnectInboxConnection,
  emailApiError,
  getInboxRules,
  getMailboxSettings,
  listInboxAliases,
  listInboxConnections,
  mailboxPendingCount,
  patchInboxRules,
  patchMailboxSettings,
  syncInboxConnection,
  type ConnectionRules,
  type EmailInboxAlias,
  type InboxConnection,
  type NeedsReplySensitivity,
} from '../../services/emailSyncApi';
import { CollapsibleChipList } from './_components/CollapsibleChipList';
import { openEmailInboxOAuth } from './_components/emailOAuth';
import {
  emailSyncCacheSetPending,
  emailSyncCacheSetSetup,
  emailSyncCacheSetup,
  emailSyncPeekOAuthRefresh,
} from './_components/emailSyncCache';
import { parseAsUTC } from '../../utils/timeFormatting';

const FILE_TYPES = ['pdf', 'png', 'jpg', 'jpeg', 'docx', 'xlsx', 'csv'];

const SENSITIVITY_LEVELS: NeedsReplySensitivity[] = ['conservative', 'balanced', 'aggressive'];

const SENSITIVITY_HINT: Record<NeedsReplySensitivity, string> = {
  conservative: 'Shows fewer emails, prioritizing high-confidence replies.',
  balanced: 'Recommended. Focuses on emails most likely to need a response.',
  aggressive: 'Catches more possible replies, but may include mail that does not require action.',
};

function platformLabel(platform: string): string {
  return platform === 'outlook_inbox' ? 'Outlook' : 'Gmail';
}

function formatLastSynced(iso?: string | null): string {
  if (!iso) return 'never';
  const d = parseAsUTC(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function connectionReadOn(c: InboxConnection): boolean {
  return c.read_enabled !== false && !c.needs_reconnect;
}

function connectionSendOn(c: InboxConnection): boolean {
  return !!c.send_enabled && !c.needs_reconnect_for_send;
}

export function EmailSetupPane({
  workspaceId,
  onPending,
}: {
  workspaceId: number;
  onPending: (n: number) => void;
}) {
  const router = useRouter();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const cached = emailSyncCacheSetup();
  const [conns, setConns] = useState<InboxConnection[]>(cached?.conns || []);
  const [aliases, setAliases] = useState<EmailInboxAlias[]>(cached?.aliases || []);
  const [senders, setSenders] = useState<string[]>(cached?.senders || []);
  const [patterns, setPatterns] = useState<string[]>(cached?.patterns || []);
  const [needsReplySensitivity, setNeedsReplySensitivity] = useState<NeedsReplySensitivity>(
    cached?.needsReplySensitivity || 'balanced',
  );
  const [grabdocsResearch, setGrabdocsResearch] = useState<boolean | null>(
    cached?.grabdocsResearch ?? null,
  );
  const [loading, setLoading] = useState(!cached);
  const [menuConn, setMenuConn] = useState<InboxConnection | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rulesConn, setRulesConn] = useState<InboxConnection | null>(null);
  const [rules, setRules] = useState<ConnectionRules | null>(null);
  const [rulesSenders, setRulesSenders] = useState<string[]>([]);
  const [rulesKeywords, setRulesKeywords] = useState<string[]>([]);
  const [rulesTypes, setRulesTypes] = useState<string[]>([]);
  const [rulesFolderId, setRulesFolderId] = useState<number | null>(null);
  const [rulesFolderName, setRulesFolderName] = useState('My Files (root)');
  const [rulesSyncAt, setRulesSyncAt] = useState(new Date());
  const [showSyncPicker, setShowSyncPicker] = useState(false);
  const [folderPickOpen, setFolderPickOpen] = useState(false);
  const [rulesBusy, setRulesBusy] = useState(false);

  const load = useCallback(async (ws: number) => {
    const [c, a, s, count] = await Promise.all([
      listInboxConnections(),
      listInboxAliases(ws),
      getMailboxSettings(ws).catch(() => ({})),
      mailboxPendingCount(ws).catch(() => 0),
    ]);
    const next = {
      conns: c.filter((x) => x.is_active !== false),
      aliases: Array.isArray(a) ? a : [],
      senders: s.allowed_senders || [],
      patterns: s.subject_patterns || [],
      needsReplySensitivity: (s.needs_reply_sensitivity || 'balanced') as NeedsReplySensitivity,
      grabdocsResearch: (s.grabdocs_research_enabled ?? null) as boolean | null,
    };
    setConns(next.conns);
    setAliases(next.aliases);
    setSenders(next.senders);
    setPatterns(next.patterns);
    setNeedsReplySensitivity(next.needsReplySensitivity);
    setGrabdocsResearch(next.grabdocsResearch);
    emailSyncCacheSetSetup(next);
    const n = Number(count) || 0;
    emailSyncCacheSetPending(n);
    onPending(n);
  }, [onPending]);

  useEffect(() => {
    const hit = emailSyncCacheSetup();
    const force = emailSyncPeekOAuthRefresh();
    if (hit && !hit.stale && !force) {
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        await load(workspaceId);
      } catch (e) {
        if (!hit) Alert.alert('Mailbox', emailApiError(e, 'Could not load'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [load, workspaceId]);

  const reloadAfterOAuth = useCallback(async () => {
    for (let i = 0; i < 6; i++) {
      await load(workspaceId);
      const c = await listInboxConnections().catch(() => [] as InboxConnection[]);
      if (c.some((x) => x.is_active !== false)) return;
      await new Promise((r) => setTimeout(r, 400));
    }
  }, [load, workspaceId]);

  useFocusEffect(
    useCallback(() => {
      if (!emailSyncPeekOAuthRefresh()) return;
      let alive = true;
      (async () => {
        try {
          await reloadAfterOAuth();
        } catch {
          /* load errors already handled */
        }
      })();
      return () => {
        alive = false;
      };
    }, [reloadAfterOAuth])
  );

  const connect = async (provider: 'gmail' | 'outlook') => {
    if (!workspaceId) return;
    setAddOpen(false);
    setMenuConn(null);
    setBusy(true);
    try {
      const r = await openEmailInboxOAuth(provider, workspaceId);
      if (r.result === 'error') Alert.alert('Could not connect', r.reason.replace(/_/g, ' '));
      if (r.result === 'success') await reloadAfterOAuth();
      else await load(workspaceId);
      if (r.result === 'success') {
        const settings = await getMailboxSettings(workspaceId).catch(() => ({}));
        if (settings.grabdocs_research_enabled == null) {
          Alert.alert(
            'GrabDocs research',
            'Use GrabDocs to look up calendar, documents, and workspace data while drafting replies. Uses AI credits per research.',
            [
              {
                text: 'Not now',
                onPress: () => {
                  void patchMailboxSettings({
                    workspace_id: workspaceId,
                    grabdocs_research_enabled: false,
                  }).then(() => load(workspaceId));
                },
              },
              {
                text: 'Turn on',
                onPress: () => {
                  void patchMailboxSettings({
                    workspace_id: workspaceId,
                    grabdocs_research_enabled: true,
                  }).then(() => load(workspaceId));
                },
              },
            ],
          );
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const patchResearch = (enabled: boolean) => {
    if (!workspaceId) return;
    setGrabdocsResearch(enabled);
    void patchMailboxSettings({ workspace_id: workspaceId, grabdocs_research_enabled: enabled }).catch((e) =>
      Alert.alert('Settings', emailApiError(e, 'Could not save')),
    );
  };

  const patchSensitivity = (level: NeedsReplySensitivity) => {
    if (!workspaceId) return;
    setNeedsReplySensitivity(level);
    void patchMailboxSettings({ workspace_id: workspaceId, needs_reply_sensitivity: level }).catch((e) =>
      Alert.alert('Settings', emailApiError(e, 'Could not save')),
    );
  };

  const openRules = async (c: InboxConnection) => {
    setMenuConn(null);
    setRulesConn(c);
    setRulesBusy(true);
    try {
      const r = await getInboxRules(c.id);
      setRules(r);
      setRulesSenders(r.allowed_senders || []);
      setRulesKeywords(r.subject_keywords || []);
      setRulesTypes(r.allowed_file_types || []);
      setRulesFolderId(r.target_folder_id ?? null);
      if (r.sync_start_date) {
        const d = parseAsUTC(r.sync_start_date);
        setRulesSyncAt(Number.isNaN(d.getTime()) ? new Date() : d);
      } else {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        setRulesSyncAt(start);
      }
      if (r.target_folder_id) {
        try {
          const f = await apiService.getFolderDetail(r.target_folder_id);
          setRulesFolderName(f.folder?.name || `Folder ${r.target_folder_id}`);
        } catch {
          setRulesFolderName(`Folder ${r.target_folder_id}`);
        }
      } else {
        setRulesFolderName('My Files (root)');
      }
    } catch (e) {
      Alert.alert('Rules', emailApiError(e, 'Could not load'));
      setRulesConn(null);
    } finally {
      setRulesBusy(false);
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 8, backgroundColor: colors.headerBackground },
        title: { flex: 1, fontSize: 20, fontWeight: '700', color: colors.text },
        section: {
          fontSize: 13,
          fontWeight: '600',
          color: colors.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginHorizontal: 16,
          marginTop: 20,
          marginBottom: 8,
        },
        card: {
          marginHorizontal: 16,
          backgroundColor: colors.surface,
          borderRadius: 14,
          overflow: 'hidden',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        },
        row: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
        name: { fontSize: 16, fontWeight: '600', color: colors.text },
        sub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
        statusRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 6 },
        statusOn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
        statusOnText: { fontSize: 12, fontWeight: '600', color: '#16a34a' },
        warn: { fontSize: 12, fontWeight: '600', color: '#B45309', marginTop: 4 },
        input: {
          marginHorizontal: 16,
          marginTop: 8,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          padding: 14,
          color: colors.text,
          fontSize: 16,
        },
        hint: { marginHorizontal: 16, marginTop: 6, fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
        sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 58 },
        chip: {
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border,
          marginRight: 8,
          marginTop: 8,
        },
        chipOn: { borderColor: '#007AFF', backgroundColor: colors.isDark ? '#1e3a5f' : '#E3F2FD' },
        modalSafe: { flex: 1, backgroundColor: colors.background, paddingTop: insets.top },
        saveBtn: {
          margin: 16,
          backgroundColor: '#007AFF',
          borderRadius: 12,
          padding: 14,
          alignItems: 'center',
        },
      }),
    [colors, insets.top]
  );

  const hasGmail = conns.some((c) => c.platform === 'gmail_inbox');
  const hasOutlook = conns.some((c) => c.platform === 'outlook_inbox');

  const addMailboxItems = useMemo((): ActionMenuItem[] => {
    const items: ActionMenuItem[] = [];
    if (!hasGmail) {
      items.push({ id: 'g', label: 'Google', onPress: () => connect('gmail') });
    }
    if (!hasOutlook) {
      items.push({ id: 'm', label: 'Microsoft', onPress: () => connect('outlook') });
    }
    return items;
  }, [hasGmail, hasOutlook]);

  const onAddMailbox = () => {
    if (addMailboxItems.length === 1) {
      addMailboxItems[0].onPress?.();
      return;
    }
    setAddOpen(true);
  };

  const menuItems: ActionMenuItem[] = menuConn
    ? [
        {
          id: 'reconnect',
          label: menuConn.needs_reconnect_for_send ? 'Reconnect to send' : 'Reconnect',
          icon: 'refresh',
          onPress: () => connect(menuConn.platform === 'outlook_inbox' ? 'outlook' : 'gmail'),
        },
        {
          id: 'rules',
          label: 'Edit rules',
          icon: 'options-outline',
          onPress: () => void openRules(menuConn),
        },
        {
          id: 'sync',
          label: 'Sync now',
          icon: 'cloud-download-outline',
          onPress: async () => {
            await syncInboxConnection(menuConn.id);
            Alert.alert('Syncing', 'New attachments will show up in Documents shortly.');
          },
        },
        {
          id: 'off',
          label: 'Disconnect',
          icon: 'close-circle-outline',
          onPress: () =>
            Alert.alert('Disconnect mailbox?', 'Replies will stop for this account.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Disconnect',
                style: 'destructive',
                onPress: async () => {
                  await disconnectInboxConnection(menuConn.id);
                  if (workspaceId) await load(workspaceId);
                },
              },
            ]),
        },
        {
          id: 'delete',
          label: 'Delete',
          icon: 'trash-outline',
          destructive: true,
          onPress: () =>
            Alert.alert(
              'Delete account?',
              'Permanently delete this account from GrabDocs?\n\n' +
                '• GrabDocs will stop syncing this mailbox\n' +
                '• Email Replies threads for this account will be removed\n' +
                '• Files already imported will be kept\n\n' +
                'This cannot be undone (you can connect the account again later).',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await deleteInboxConnection(menuConn.id);
                      if (workspaceId) await load(workspaceId);
                    } catch (e) {
                      Alert.alert('Mailbox', emailApiError(e, 'Failed to delete account'));
                    }
                  },
                },
              ],
            ),
        },
      ]
    : [];

  return (
    <View style={styles.safe}>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 32 }} color="#007AFF" />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.section}>Accounts</Text>
          <View style={styles.card}>
            {conns.map((c, i) => (
              <View key={c.id}>
                {i > 0 ? <View style={styles.sep} /> : null}
                <View style={styles.row}>
                  {c.platform === 'outlook_inbox' ? <MicrosoftLogo size={22} /> : <GoogleLogo size={22} />}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{c.account_name}</Text>
                    <Text style={styles.sub}>
                      {platformLabel(c.platform)} · Last synced {formatLastSynced(c.last_synced_at)}
                    </Text>
                    <View style={styles.statusRow}>
                      {connectionReadOn(c) ? (
                        <View style={styles.statusOn}>
                          <Ionicons name="checkmark-circle" size={14} color="#16a34a" />
                          <Text style={styles.statusOnText}>Read on</Text>
                        </View>
                      ) : null}
                      {connectionSendOn(c) ? (
                        <Text style={styles.statusOnText}>Send on</Text>
                      ) : null}
                    </View>
                    {c.needs_reconnect || c.needs_reconnect_for_send ? (
                      <Text style={styles.warn}>Tap ••• and reconnect</Text>
                    ) : null}
                  </View>
                  <TouchableOpacity onPress={() => setMenuConn(c)} hitSlop={12}>
                    <Ionicons name="ellipsis-horizontal" size={20} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            {addMailboxItems.length > 0 ? (
              <TouchableOpacity style={styles.row} onPress={onAddMailbox} disabled={busy}>
                <View style={{ width: 22, alignItems: 'center' }}>
                  <Ionicons name="add" size={22} color="#007AFF" />
                </View>
                <Text style={[styles.name, { color: '#007AFF' }]}>
                  {busy ? 'Connecting…' : addMailboxItems.length === 1 ? `Add ${addMailboxItems[0].label}` : 'Add mailbox'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <Text style={styles.section}>Who to surface</Text>
          {!senders.length && !patterns.length ? (
            <Text style={[styles.hint, { color: '#B45309' }]}>
              No presets yet — add at least one domain or subject keyword for a quieter queue.
            </Text>
          ) : null}
          <CollapsibleChipList
            title="Sender allowlist"
            hint="Emails or @domain.com. Presets make mail eligible — they do not auto-mark needs reply."
            value={senders}
            onChange={(v) => {
              setSenders(v);
              if (!workspaceId) return;
              void patchMailboxSettings({
                workspace_id: workspaceId,
                allowed_senders: v,
                subject_patterns: patterns,
              }).catch((e) => Alert.alert('Settings', emailApiError(e, 'Could not save')));
            }}
            placeholder="@client.com, partner@firm.com"
            emptyLabel="None"
          />
          <CollapsibleChipList
            title="Subject contains"
            hint="Subject keywords that mark mail as eligible."
            value={patterns}
            onChange={(v) => {
              setPatterns(v);
              if (!workspaceId) return;
              void patchMailboxSettings({
                workspace_id: workspaceId,
                allowed_senders: senders,
                subject_patterns: v,
              }).catch((e) => Alert.alert('Settings', emailApiError(e, 'Could not save')));
            }}
            placeholder="invoice, W-2, signature"
            emptyLabel="None"
          />

          <View style={[styles.card, { padding: 14, marginTop: 8 }]}>
            <Text style={[styles.name, { fontSize: 15 }]}>Needs-reply sensitivity</Text>
            <Text style={[styles.sub, { marginTop: 6, lineHeight: 18 }]}>
              Controls how broadly GrabDocs identifies emails that may need a reply.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 }}>
              {SENSITIVITY_LEVELS.map((level) => {
                const selected = needsReplySensitivity === level;
                const label = level.charAt(0).toUpperCase() + level.slice(1);
                return (
                  <TouchableOpacity
                    key={level}
                    style={[styles.chip, selected && styles.chipOn, { marginTop: 0 }]}
                    onPress={() => patchSensitivity(level)}
                  >
                    <Text style={{ color: colors.text, fontWeight: selected ? '600' : '400' }}>
                      {label}
                      {level === 'balanced' ? ' (recommended)' : ''}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={[styles.sub, { marginTop: 10, fontSize: 11, lineHeight: 15 }]}>
              {SENSITIVITY_HINT[needsReplySensitivity]}
            </Text>
          </View>

          <Text style={styles.section}>Reply settings</Text>
          <View style={[styles.card, { padding: 14, marginBottom: 8 }]}>
            {grabdocsResearch == null ? (
              <>
                <Text style={[styles.name, { fontSize: 15 }]}>Use GrabDocs when drafting replies?</Text>
                <Text style={[styles.sub, { marginTop: 6, lineHeight: 18 }]}>
                  Look up calendar, documents, and workspace data while drafting. Uses AI credits per research.
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  <TouchableOpacity
                    style={[styles.chip, styles.chipOn, { marginTop: 0 }]}
                    onPress={() => patchResearch(true)}
                  >
                    <Text style={{ color: colors.text, fontWeight: '600' }}>Turn on</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.chip, { marginTop: 0 }]} onPress={() => patchResearch(false)}>
                    <Text style={{ color: colors.text }}>Not now</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}
                onPress={() => patchResearch(!grabdocsResearch)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={grabdocsResearch ? 'checkbox' : 'square-outline'}
                  size={22}
                  color={grabdocsResearch ? '#007AFF' : colors.textSecondary}
                  style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.name, { fontSize: 15 }]}>Look up workspace data</Text>
                  <Text style={[styles.sub, { marginTop: 2, fontSize: 11, lineHeight: 15 }]}>
                    Searches your calendar, files, and workspace to help draft replies.
                  </Text>
                </View>
              </TouchableOpacity>
            )}
            <Text
              style={[
                styles.sub,
                {
                  marginTop: grabdocsResearch == null ? 0 : 14,
                  paddingTop: grabdocsResearch == null ? 0 : 14,
                  borderTopWidth: grabdocsResearch == null ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: colors.border,
                  fontSize: 11,
                  lineHeight: 15,
                },
              ]}
            >
              Only emails sent directly to you are auto-added to Needs reply. CC-only mail needs a sender or subject preset match.
            </Text>
          </View>

          <Text style={styles.section}>Forwarding</Text>
          <View style={styles.card}>
            {aliases.map((a, i) => (
              <View key={a.id}>
                {i > 0 ? <View style={styles.sep} /> : null}
                <TouchableOpacity style={styles.row} onPress={() => router.push(`/email-sync/alias/${a.id}` as any)}>
                  <Ionicons name="arrow-redo-outline" size={20} color={colors.textSecondary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name} numberOfLines={1}>
                      {a.display_name || 'Forwarding address'}
                    </Text>
                    <Text style={styles.sub} numberOfLines={1}>
                      {a.alias_address}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity
              style={styles.row}
              onPress={async () => {
                if (!workspaceId) return;
                const created = await createInboxAlias({ workspace_id: workspaceId });
                const addr = (created as any)?.alias_address;
                if (addr) await Clipboard.setStringAsync(addr);
                await load(workspaceId);
                Alert.alert('Address copied', 'Forward mail here to import attachments. This does not send replies.');
              }}
            >
              <Ionicons name="add" size={22} color="#007AFF" />
              <Text style={[styles.name, { color: '#007AFF' }]}>New forwarding address</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      <ActionMenuModal visible={!!menuConn} title={menuConn?.account_name} items={menuItems} onClose={() => setMenuConn(null)} />
      <ActionMenuModal
        visible={addOpen}
        title="Add mailbox"
        items={addMailboxItems}
        onClose={() => setAddOpen(false)}
      />

      <Modal
        visible={!!rulesConn}
        animationType="slide"
        onRequestClose={() => {
          setFolderPickOpen(false);
          setRulesConn(null);
        }}
      >
        <View style={styles.modalSafe}>
          {folderPickOpen ? (
            <FolderMovePicker
              embedded
              visible
              title="Save attachments to"
              workspaceId={workspaceId ?? undefined}
              onClose={() => setFolderPickOpen(false)}
              onSelect={async (folderId) => {
                setRulesFolderId(folderId);
                if (folderId == null) {
                  setRulesFolderName('My Files (root)');
                  return;
                }
                try {
                  const f = await apiService.getFolderDetail(folderId);
                  setRulesFolderName(f.folder?.name || `Folder ${folderId}`);
                } catch {
                  setRulesFolderName(`Folder ${folderId}`);
                }
              }}
            />
          ) : (
            <>
          <View style={styles.header}>
            <FeedbackTouchable onPress={() => setRulesConn(null)} style={{ padding: 10 }}>
              <Ionicons name="close" size={28} color={colors.text} />
            </FeedbackTouchable>
            <Text style={styles.title}>Edit rules</Text>
          </View>
          {rulesBusy || !rules ? (
            <ActivityIndicator style={{ marginTop: 32 }} color="#007AFF" />
          ) : (
            <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
              <Text style={styles.hint}>{rules.account_name}</Text>
              <Text style={[styles.hint, { marginTop: 4 }]}>
                Set rules for which emails GrabDocs imports. Leave blank to import all attachments.
              </Text>
              <CollapsibleChipList
                title="Allowed senders"
                hint="Only import attachments from these addresses or domains. Blank = all. Expand to view or edit."
                value={rulesSenders}
                onChange={setRulesSenders}
                placeholder="email@example.com or @domain.com"
                emptyLabel="All senders"
              />
              <CollapsibleChipList
                title="Subject keywords"
                hint="Only import emails whose subject contains at least one keyword. Blank = all subjects."
                value={rulesKeywords}
                onChange={setRulesKeywords}
                placeholder="invoice, receipt, statement…"
                emptyLabel="All subjects"
              />
              <Text style={styles.section}>File types</Text>
              <Text style={styles.hint}>None selected = all types</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: 16 }}>
                {FILE_TYPES.map((t) => {
                  const on = rulesTypes.includes(t);
                  return (
                    <TouchableOpacity
                      key={t}
                      style={[styles.chip, on && styles.chipOn]}
                      onPress={() =>
                        setRulesTypes(on ? rulesTypes.filter((x) => x !== t) : [...rulesTypes, t])
                      }
                    >
                      <Text style={{ color: colors.text }}>{t}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={styles.section}>Save attachments to folder</Text>
              <TouchableOpacity style={styles.input} onPress={() => setFolderPickOpen(true)}>
                <Text style={{ color: colors.text }}>{rulesFolderName}</Text>
              </TouchableOpacity>
              <Text style={styles.section}>Sync from date & time</Text>
              <TouchableOpacity style={styles.input} onPress={() => setShowSyncPicker(true)}>
                <Text style={{ color: colors.text }}>
                  {rulesSyncAt.toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </Text>
              </TouchableOpacity>
              <Text style={styles.hint}>
                GrabDocs will only import emails received on or after this date and time (your local timezone).
              </Text>
              {showSyncPicker ? (
                <DateTimePicker
                  value={rulesSyncAt}
                  mode="datetime"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={(_, d) => {
                    if (Platform.OS === 'android') setShowSyncPicker(false);
                    if (d) setRulesSyncAt(d);
                  }}
                />
              ) : null}
              {Platform.OS === 'ios' && showSyncPicker ? (
                <TouchableOpacity onPress={() => setShowSyncPicker(false)} style={{ alignSelf: 'flex-end', marginRight: 16, marginTop: 4 }}>
                  <Text style={{ color: '#007AFF', fontWeight: '600' }}>Done</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={async () => {
                  if (!rulesConn) return;
                  setRulesBusy(true);
                  try {
                    await patchInboxRules(rulesConn.id, {
                      allowed_senders: rulesSenders,
                      subject_keywords: rulesKeywords,
                      allowed_file_types: rulesTypes,
                      target_folder_id: rulesFolderId,
                      sync_start_date: rulesSyncAt.toISOString(),
                    });
                    setRulesConn(null);
                    if (workspaceId) await load(workspaceId);
                  } catch (e) {
                    Alert.alert('Rules', emailApiError(e, 'Could not save'));
                  } finally {
                    setRulesBusy(false);
                  }
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Save rules</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
            </>
          )}
        </View>
      </Modal>
    </View>
  );
}

export default function MailboxSettingsScreen() {
  return <Redirect href={{ pathname: '/email-sync', params: { tab: 'setup' } }} />;
}
