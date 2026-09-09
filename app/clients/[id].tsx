import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { truncateAppHeaderTitle } from '../../utils/chatTitleDisplay';
import ActionMenuModal, { type ActionMenuItem } from '../../components/ActionMenuModal';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  acceptSuggestedIdentifier,
  addIdentifier,
  archiveClient,
  attentionStatusLabel,
  chatGdAskHref,
  deleteIdentifier,
  getClientDossier,
  getClientFinancials,
  getClientOverview,
  getClientTimeline,
  itemHref,
  linkKindLabel,
  primaryEmail,
  rejectSuggestedIdentifier,
  restoreClient,
  unlinkItemClient,
  updateClient,
  type ClientCollectionSchedule,
  type ClientDossier,
  type ClientFinancials,
  type ClientIdentifier,
  type ClientOverview,
  type IdentifierType,
  type TimelineEntry,
} from '../../services/clientsApi';

type TabKey = 'overview' | 'activity' | 'work' | 'files' | 'financials' | 'communication';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'activity', label: 'Activity' },
  { key: 'work', label: 'Work' },
  { key: 'files', label: 'Files' },
  { key: 'financials', label: 'Financials' },
  { key: 'communication', label: 'Communication' },
];

const WORK_TYPES = ['intake', 'intake_schedule', 'file_upload_link', 'signature_envelope', 'form'];
const FILE_TYPES = ['file', 'note'];
const COMM_TYPES = ['email_thread', 'email_draft', 'chat_history', 'user_chat'];

function formatClientMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency || 'USD'} ${Number(amount).toFixed(2)}`;
  }
}

function displayFinancialKind(fileKind?: string | null): string {
  const k = (fileKind || '').trim().toLowerCase();
  if (k === 'invoice') return 'Invoice';
  if (k === 'receipt') return 'Receipt';
  return fileKind?.trim() || 'Document';
}

export default function ClientDetailScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const params = useLocalSearchParams<{ id: string; tab?: string }>();
  const clientId = Number(params.id);
  const initialTab = (TABS.find((t) => t.key === params.tab)?.key || 'overview') as TabKey;

  const [tab, setTab] = useState<TabKey>(initialTab);
  const [overview, setOverview] = useState<ClientOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineMore, setTimelineMore] = useState(false);
  const [dossier, setDossier] = useState<ClientDossier | null>(null);
  const [financials, setFinancials] = useState<ClientFinancials | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [idType, setIdType] = useState<IdentifierType>('email');
  const [idValue, setIdValue] = useState('');

  const loadOverview = useCallback(async () => {
    if (!Number.isFinite(clientId)) return;
    const ov = await getClientOverview(clientId);
    setOverview(ov);
    setNameDraft(ov.client.display_name);
  }, [clientId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await loadOverview();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load client');
    } finally {
      setLoading(false);
    }
  }, [loadOverview]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!Number.isFinite(clientId)) return;
    if (tab === 'activity') {
      void getClientTimeline(clientId, { limit: 30, offset: 0 }).then((r) => {
        setTimeline(r.timeline);
        setTimelineMore(r.has_more);
      });
    } else if (tab === 'work') {
      void getClientDossier(clientId, { item_types: WORK_TYPES }).then(setDossier);
    } else if (tab === 'files') {
      void getClientDossier(clientId, { item_types: FILE_TYPES }).then(setDossier);
    } else if (tab === 'communication') {
      void getClientDossier(clientId, { item_types: COMM_TYPES }).then(setDossier);
    } else if (tab === 'financials') {
      void getClientFinancials(clientId).then(setFinancials);
    }
  }, [tab, clientId]);

  const client = overview?.client;
  const woc = overview?.waiting_on_client || [];
  const wou = overview?.waiting_on_us || [];
  const collections = overview?.collections || [];

  const saveName = async () => {
    if (!client || !nameDraft.trim()) return;
    try {
      await updateClient(client.id, { display_name: nameDraft.trim() });
      setEditingName(false);
      await loadOverview();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to rename');
    }
  };

  const toggleVisibility = async () => {
    if (!client) return;
    const next = client.visibility === 'company' ? 'private' : 'company';
    try {
      await updateClient(client.id, { visibility: next });
      await loadOverview();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to update visibility');
    }
  };

  const handleArchive = () => {
    if (!client) return;
    const archived = client.status === 'archived';
    Alert.alert(
      archived ? 'Restore client?' : 'Archive client?',
      archived ? 'Restore this client to active.' : 'Archived clients hide from the main list.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: archived ? 'Restore' : 'Archive',
          style: archived ? 'default' : 'destructive',
          onPress: async () => {
            try {
              if (archived) await restoreClient(client.id);
              else await archiveClient(client.id);
              await loadOverview();
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'Failed');
            }
          },
        },
      ]
    );
  };

  const addId = async () => {
    if (!client || !idValue.trim()) return;
    try {
      await addIdentifier(client.id, {
        identifier_type: idType,
        identifier_value: idValue.trim(),
      });
      setIdValue('');
      await loadOverview();
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || err?.message || 'Failed to add');
    }
  };

  const removeIdentifier = (ident: ClientIdentifier) => {
    const identifiers = client?.identifiers || [];
    if (ident.identifier_type === 'email') {
      const emailCount = identifiers.filter((i) => i.identifier_type === 'email').length;
      if (emailCount <= 1) {
        Alert.alert(
          'Required',
          'Each client must have an email. Add another before removing this one.'
        );
        return;
      }
    }
    Alert.alert('Remove identifier?', ident.identifier_value, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await deleteIdentifier(ident.id);
              await loadOverview();
            } catch (err: any) {
              Alert.alert(
                'Error',
                err?.response?.data?.error || err?.message || 'Failed to remove'
              );
            }
          })();
        },
      },
    ]);
  };

  const openItem = (itemType?: string | null, itemId?: number | null, extra?: any) => {
    const href = itemHref(itemType, itemId, extra);
    if (href) router.push(href as any);
  };

  const createMenuItems: ActionMenuItem[] = [
    {
      id: 'file-request',
      label: 'File request',
      onPress: () => {
        setShowCreateMenu(false);
        router.push(`/upload-links/create?client_id=${clientId}` as any);
      },
    },
    {
      id: 'intake',
      label: 'Intake',
      onPress: () => {
        setShowCreateMenu(false);
        router.push(`/intake/create?client_id=${clientId}` as any);
      },
    },
    {
      id: 'signature',
      label: 'Signature',
      onPress: () => {
        setShowCreateMenu(false);
        router.push(`/signatures/create?client_id=${clientId}` as any);
      },
    },
    {
      id: 'email',
      label: 'Send email',
      onPress: () => {
        setShowCreateMenu(false);
        const to = primaryEmail(client) || '';
        router.push(
          `/email-sync?compose=1&client_id=${clientId}&to=${encodeURIComponent(to)}` as any
        );
      },
    },
    {
      id: 'chat',
      label: 'Start chat / Ask',
      onPress: () => {
        setShowCreateMenu(false);
        router.push(
          chatGdAskHref({ clientId, clientName: client?.display_name }) as any
        );
      },
    },
  ];

  const renderWaitRow = (item: any, key: string) => (
    <TouchableOpacity
      key={key}
      style={[styles.waitRow, { borderBottomColor: colors.border }]}
      onPress={() =>
        openItem(item.item_type, item.item_id, {
          parentId: item.parent_id,
          sourceType: item.source_type,
          sourceId: item.source_id,
        })
      }
    >
      <Text style={{ color: colors.text, flex: 1 }} numberOfLines={2}>
        {item.label || item.action || 'Open item'}
      </Text>
      {item.overdue ? (
        <Text style={{ color: '#B91C1C', fontSize: 11, fontWeight: '600' }}>Overdue</Text>
      ) : null}
    </TouchableOpacity>
  );

  const renderDossier = () => {
    if (!dossier) return <ActivityIndicator color="#0D9488" />;
    const entries = Object.entries(dossier.by_type || {}).filter(([, b]) => b.count > 0);
    if (!entries.length) {
      return <Text style={{ color: colors.textSecondary }}>Nothing linked yet.</Text>;
    }
    return entries.map(([type, bucket]) => (
      <View key={type} style={{ marginBottom: 16 }}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          {type.replace(/_/g, ' ')} ({bucket.count})
        </Text>
        {bucket.links.map((link) => (
          <View
            key={link.id}
            style={[styles.linkRow, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <TouchableOpacity
              style={{ flex: 1 }}
              onPress={() =>
                openItem(link.item_type, link.item_id, {
                  sourceType: link.source_type,
                  sourceId: link.source_id,
                })
              }
            >
              <Text style={{ color: colors.text, fontWeight: '500' }} numberOfLines={1}>
                {link.label || `${link.item_type} #${link.item_id}`}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                {linkKindLabel(link.link_kind)}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                Alert.alert('Unlink?', 'Remove this association?', [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Unlink',
                    style: 'destructive',
                    onPress: async () => {
                      await unlinkItemClient({ link_id: link.id });
                      if (tab === 'work')
                        setDossier(await getClientDossier(clientId, { item_types: WORK_TYPES }));
                      else if (tab === 'files')
                        setDossier(await getClientDossier(clientId, { item_types: FILE_TYPES }));
                      else
                        setDossier(await getClientDossier(clientId, { item_types: COMM_TYPES }));
                    },
                  },
                ]);
              }}
            >
              <Ionicons name="unlink-outline" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ))}
      </View>
    ));
  };

  const renderCollections = (list: ClientCollectionSchedule[]) => {
    if (!list.length) return null;
    return (
      <View style={{ marginBottom: 16 }}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Collections</Text>
        {list.map((s) => (
          <TouchableOpacity
            key={s.id}
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => router.push('/intake' as any)}
          >
            <Text style={{ color: colors.text, fontWeight: '600' }}>{s.title}</Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
              {s.cadence_summary || s.frequency}
              {s.current_collection?.progress
                ? ` · ${s.current_collection.progress.received}/${s.current_collection.progress.total}`
                : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  if (!Number.isFinite(clientId)) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <Text style={{ padding: 16, color: colors.text }}>Invalid client</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <AppBackButton onPress={() => router.back()} />
        <AppHeaderTitle shrink={false}>
          {truncateAppHeaderTitle(client?.display_name || 'Client')}
        </AppHeaderTitle>
        <TouchableOpacity onPress={handleArchive} hitSlop={8}>
          <Ionicons
            name={client?.status === 'archived' ? 'refresh-outline' : 'archive-outline'}
            size={22}
            color={colors.textSecondary}
          />
        </TouchableOpacity>
      </View>

      {loading && !overview ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#0D9488" />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 48 }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
        >
          <View style={styles.titleBlock}>
            {editingName ? (
              <View style={styles.nameEdit}>
                <TextInput
                  style={[styles.nameInput, { color: colors.text, borderColor: colors.border }]}
                  value={nameDraft}
                  onChangeText={setNameDraft}
                  autoFocus
                />
                <TouchableOpacity onPress={() => void saveName()}>
                  <Text style={{ color: '#0D9488', fontWeight: '600' }}>Save</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={() => setEditingName(true)}>
                <Text style={[styles.title, { color: colors.text }]}>
                  {client?.display_name}
                  <Text style={{ color: colors.textSecondary, fontSize: 14 }}> ✎</Text>
                </Text>
              </TouchableOpacity>
            )}
            <View style={styles.pills}>
              <Text style={styles.pill}>{attentionStatusLabel(overview?.attention?.status)}</Text>
              <TouchableOpacity onPress={() => void toggleVisibility()}>
                <Text style={styles.pill}>{client?.visibility || 'private'}</Text>
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar}>
            {TABS.map((t) => (
              <TouchableOpacity
                key={t.key}
                onPress={() => setTab(t.key)}
                style={[
                  styles.tab,
                  {
                    borderBottomColor: tab === t.key ? '#0D9488' : 'transparent',
                  },
                ]}
              >
                <Text
                  style={{
                    color: tab === t.key ? '#0D9488' : colors.textSecondary,
                    fontWeight: tab === t.key ? '700' : '500',
                    fontSize: 13,
                  }}
                >
                  {t.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <View style={{ padding: 16 }}>
            {tab === 'overview' && (
              <>
                {overview?.attention?.status === 'on_track' &&
                woc.length === 0 &&
                wou.length === 0 ? (
                  <View style={[styles.banner, { backgroundColor: 'rgba(13,148,136,0.1)' }]}>
                    <Text style={{ color: colors.text }}>
                      Everything looks on track for {client?.display_name}. No open waits right now.
                    </Text>
                  </View>
                ) : null}

                {renderCollections(collections)}

                {overview?.next_step ? (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>Next step</Text>
                    {renderWaitRow(overview.next_step, 'next')}
                  </View>
                ) : null}

                {woc.length > 0 ? (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>
                      Waiting on client ({woc.length})
                    </Text>
                    {woc.slice(0, 8).map((i, idx) => renderWaitRow(i, `woc-${idx}`))}
                  </View>
                ) : null}

                {wou.length > 0 ? (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>
                      Waiting on us ({wou.length})
                    </Text>
                    {wou.slice(0, 8).map((i, idx) => renderWaitRow(i, `wou-${idx}`))}
                  </View>
                ) : null}

                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.primaryBtn}
                    onPress={() =>
                      router.push(
                        chatGdAskHref({
                          clientId,
                          clientName: client?.display_name,
                        }) as any
                      )
                    }
                  >
                    <Ionicons name="chatbubble-ellipses-outline" size={18} color="#fff" />
                    <Text style={styles.primaryBtnText}>Ask</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.secondaryBtn, { borderColor: colors.border }]}
                    onPress={() => setShowCreateMenu(true)}
                  >
                    <Ionicons name="add" size={18} color="#0D9488" />
                    <Text style={{ color: '#0D9488', fontWeight: '600' }}>Create</Text>
                  </TouchableOpacity>
                </View>

                <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 20 }]}>
                  Identifiers
                </Text>
                {(() => {
                  const identifiers = (client?.identifiers || []).filter(
                    (id: ClientIdentifier) => !(id.is_learned && id.identifier_type === 'tag')
                  );
                  const emailIdentifierCount = identifiers.filter(
                    (i) => i.identifier_type === 'email'
                  ).length;
                  return identifiers.map((id: ClientIdentifier) => (
                  <View
                    key={id.id}
                    style={[styles.idRow, { borderBottomColor: colors.border }]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                        {id.identifier_type === 'inbox_alias_token'
                          ? 'inbox alias'
                          : id.identifier_type}
                        {id.is_learned ? ' · suggested' : ''}
                      </Text>
                      <Text style={{ color: colors.text }}>{id.identifier_value}</Text>
                    </View>
                    {id.is_learned ? (
                      <View style={{ flexDirection: 'row', gap: 12 }}>
                        <TouchableOpacity
                          onPress={async () => {
                            try {
                              await acceptSuggestedIdentifier(id.id);
                              await loadOverview();
                            } catch (err: any) {
                              Alert.alert(
                                'Error',
                                err?.response?.data?.error || err?.message || 'Failed to accept'
                              );
                            }
                          }}
                        >
                          <Text style={{ color: '#0D9488' }}>Accept</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={async () => {
                            try {
                              await rejectSuggestedIdentifier(id.id);
                              await loadOverview();
                            } catch (err: any) {
                              Alert.alert(
                                'Error',
                                err?.response?.data?.error || err?.message || 'Failed to reject'
                              );
                            }
                          }}
                        >
                          <Text style={{ color: '#B91C1C' }}>Reject</Text>
                        </TouchableOpacity>
                      </View>
                    ) : id.identifier_type === 'email' && emailIdentifierCount <= 1 ? (
                      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Required</Text>
                    ) : (
                      <TouchableOpacity
                        onPress={() => removeIdentifier(id)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityLabel={`Remove ${id.identifier_value}`}
                      >
                        <Ionicons name="trash-outline" size={18} color={colors.textSecondary} />
                      </TouchableOpacity>
                    )}
                  </View>
                  ));
                })()}
                <View style={styles.addIdRow}>
                  <View style={styles.idTypeRow}>
                    {(
                      [
                        { key: 'email', label: 'Email' },
                        { key: 'domain', label: 'Domain' },
                        { key: 'tag', label: 'Tag' },
                        { key: 'inbox_alias_token', label: 'Inbox alias' },
                      ] as const
                    ).map((t) => (
                      <TouchableOpacity
                        key={t.key}
                        onPress={() => setIdType(t.key)}
                        style={[
                          styles.smallChip,
                          { backgroundColor: idType === t.key ? '#0D9488' : colors.card },
                        ]}
                      >
                        <Text style={{ color: idType === t.key ? '#fff' : colors.text, fontSize: 12 }}>
                          {t.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput
                    style={[styles.idInput, { color: colors.text, borderColor: colors.border }]}
                    placeholder="Value"
                    placeholderTextColor={colors.textSecondary}
                    value={idValue}
                    onChangeText={setIdValue}
                    autoCapitalize="none"
                  />
                  <TouchableOpacity onPress={() => void addId()}>
                    <Text style={{ color: '#0D9488', fontWeight: '600' }}>Add</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {tab === 'activity' && (
              <>
                {timeline.map((e, idx) => (
                  <View
                    key={`${e.at}-${idx}`}
                    style={[styles.waitRow, { borderBottomColor: colors.border }]}
                  >
                    <View
                      style={{
                        flex: 1,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <Text style={{ color: colors.text, flexShrink: 1 }} numberOfLines={2}>
                        {e.label || e.action || e.source}
                      </Text>
                      <Text
                        style={{
                          color: colors.textSecondary,
                          fontSize: 11,
                          flexShrink: 0,
                          marginLeft: 8,
                        }}
                      >
                        {e.at ? new Date(e.at).toLocaleString() : ''}
                      </Text>
                    </View>
                  </View>
                ))}
                {timelineMore ? (
                  <TouchableOpacity
                    onPress={async () => {
                      const r = await getClientTimeline(clientId, {
                        limit: 30,
                        offset: timeline.length,
                      });
                      setTimeline((p) => [...p, ...r.timeline]);
                      setTimelineMore(r.has_more);
                    }}
                  >
                    <Text style={{ color: '#0D9488', marginTop: 12 }}>Load more</Text>
                  </TouchableOpacity>
                ) : null}
                {!timeline.length ? (
                  <Text style={{ color: colors.textSecondary }}>No activity yet.</Text>
                ) : null}
              </>
            )}

            {(tab === 'work' || tab === 'files' || tab === 'communication') && renderDossier()}

            {tab === 'financials' && (
              <>
                {financials ? (
                  <>
                    <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 12, lineHeight: 18 }}>
                      Linked receipts and invoices. Totals only include documents with an extracted amount.
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
                      {([
                        {
                          label: 'Receipts',
                          kind: 'Receipt' as const,
                          single: financials.receipts_total || 0,
                        },
                        {
                          label: 'Invoices',
                          kind: 'Invoice' as const,
                          single: financials.invoices_total || 0,
                        },
                      ]).map((box) => {
                        const kindTotals = Object.entries(
                          financials.totals_by_kind?.[box.kind] || {}
                        );
                        const hasAmounts = financials.multi_currency
                          ? kindTotals.length > 0
                          : (financials.total_count ?? financials.count) > 0 || box.single > 0;
                        return (
                          <View
                            key={box.label}
                            style={[
                              styles.financialSummary,
                              {
                                flex: 1,
                                marginBottom: 0,
                                backgroundColor: colors.card,
                                borderColor: colors.border,
                              },
                            ]}
                          >
                            <Text
                              style={{
                                color: colors.textSecondary,
                                fontSize: 13,
                                fontWeight: '600',
                                marginBottom: 6,
                              }}
                            >
                              {box.label}
                            </Text>
                            {!hasAmounts ? (
                              <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700' }}>—</Text>
                            ) : financials.multi_currency ? (
                              kindTotals.map(([cur, amt]) => (
                                <Text
                                  key={cur}
                                  style={{ color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 2 }}
                                >
                                  {formatClientMoney(amt, cur)}
                                </Text>
                              ))
                            ) : (
                              <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700' }}>
                                {formatClientMoney(
                                  box.single,
                                  financials.primary_currency || 'USD'
                                )}
                              </Text>
                            )}
                          </View>
                        );
                      })}
                    </View>
                    <Text style={{ color: colors.textSecondary, fontSize: 11, marginBottom: 8 }}>
                      {financials.counted_in_total} of{' '}
                      {financials.total_count ?? financials.count} document
                      {(financials.total_count ?? financials.count) === 1 ? '' : 's'} included
                      {financials.unknown_amount_count > 0
                        ? ` · ${financials.unknown_amount_count} with unknown amount`
                        : ''}
                    </Text>
                    {financials.items.length === 0 ? (
                      <Text style={{ color: colors.textSecondary, marginTop: 16 }}>
                        No linked receipts or invoices.
                      </Text>
                    ) : (
                      financials.items.map((item) => (
                        <TouchableOpacity
                          key={item.file_id}
                          style={[
                            styles.linkRow,
                            { backgroundColor: colors.card, borderColor: colors.border },
                          ]}
                          onPress={() => openItem('file', item.file_id)}
                        >
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={{ color: colors.text }} numberOfLines={1}>
                              {item.label || item.filename || 'Untitled document'}
                            </Text>
                            <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
                              {displayFinancialKind(item.file_kind)}
                              {item.date ? ` · ${item.date}` : ''}
                            </Text>
                          </View>
                          <Text
                            style={{
                              color: colors.text,
                              fontSize: 13,
                              fontWeight: '600',
                              marginLeft: 8,
                            }}
                          >
                            {item.amount_known && item.amount != null
                              ? formatClientMoney(item.amount, item.currency || 'USD')
                              : 'Unknown'}
                          </Text>
                        </TouchableOpacity>
                      ))
                    )}
                    {financials.has_more ? (
                      <TouchableOpacity
                        onPress={async () => {
                          try {
                            const more = await getClientFinancials(clientId, {
                              limit: 40,
                              offset: financials.items.length,
                            });
                            setFinancials({
                              ...more,
                              items: [...financials.items, ...more.items],
                            });
                          } catch (err: any) {
                            Alert.alert(
                              'Error',
                              err?.response?.data?.error || err?.message || 'Failed to load more'
                            );
                          }
                        }}
                      >
                        <Text style={{ color: '#0D9488', marginTop: 12 }}>Load more</Text>
                      </TouchableOpacity>
                    ) : null}
                  </>
                ) : (
                  <ActivityIndicator color="#0D9488" />
                )}
              </>
            )}
          </View>
        </ScrollView>
      )}

      <ActionMenuModal
        visible={showCreateMenu}
        title="Create"
        message="Start work for this client"
        items={createMenuItems}
        onClose={() => setShowCreateMenu(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titleBlock: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  nameEdit: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  nameInput: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 18,
    fontWeight: '600',
  },
  pills: { flexDirection: 'row', gap: 8 },
  pill: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0D9488',
    backgroundColor: 'rgba(13,148,136,0.12)',
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    textTransform: 'capitalize',
  },
  tabBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
    marginTop: 12,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 2,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', marginBottom: 8 },
  banner: { padding: 12, borderRadius: 10, marginBottom: 16 },
  waitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0D9488',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600' },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  idRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  addIdRow: { marginTop: 12, gap: 8 },
  idTypeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  smallChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  idInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
  financialSummary: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  card: {
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
});
