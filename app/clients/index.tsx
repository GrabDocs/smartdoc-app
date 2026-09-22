import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import ClientPickerModal from '../../components/clients/ClientPickerModal';
import PendingTasksModal from '../../components/clients/PendingTasksModal';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  attentionStatusLabel,
  getAttentionQueue,
  listClients,
  primaryEmail,
  type AttentionQueueItem,
  type Client,
  type WaitingOnFilter,
} from '../../services/clientsApi';
import { trackRecentApp } from '../../utils/recentApps';

type FilterTab = 'all' | 'client' | 'us';

const CLIENTS_PAGE = 40;
const ATTENTION_PAGE = 20;

export default function ClientsIndexScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<FilterTab>('all');
  const [clients, setClients] = useState<Client[]>([]);
  const [attention, setAttention] = useState<AttentionQueueItem[]>([]);
  const [hasMoreClients, setHasMoreClients] = useState(false);
  const [hasMoreAttention, setHasMoreAttention] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    void trackRecentApp('clients');
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const waitingOn: WaitingOnFilter =
        filter === 'client' ? 'client' : filter === 'us' ? 'us' : 'all';
      const [listRes, att] = await Promise.all([
        listClients({
          q: debouncedQ || undefined,
          status: 'active',
          include_attention: true,
          limit: CLIENTS_PAGE,
          offset: 0,
        }),
        getAttentionQueue(waitingOn, { limit: ATTENTION_PAGE, offset: 0 }),
      ]);
      setClients(listRes.clients || []);
      setHasMoreClients(Boolean(listRes.has_more));
      setAttention(att.items || []);
      setHasMoreAttention(Boolean(att.has_more));
    } catch {
      /* keep prior */
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, filter]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      if (filter === 'all' && hasMoreClients) {
        const listRes = await listClients({
          q: debouncedQ || undefined,
          status: 'active',
          include_attention: true,
          limit: CLIENTS_PAGE,
          offset: clients.length,
        });
        setClients((prev) => {
          const seen = new Set(prev.map((c) => c.id));
          return [...prev, ...(listRes.clients || []).filter((c) => !seen.has(c.id))];
        });
        setHasMoreClients(Boolean(listRes.has_more));
      } else if (filter !== 'all' && hasMoreAttention) {
        const waitingOn: WaitingOnFilter = filter === 'client' ? 'client' : 'us';
        const att = await getAttentionQueue(waitingOn, {
          limit: ATTENTION_PAGE,
          offset: attention.length,
        });
        setAttention((prev) => {
          const seen = new Set(prev.map((i) => i.client.id));
          return [...prev, ...(att.items || []).filter((i) => !seen.has(i.client.id))];
        });
        setHasMoreAttention(Boolean(att.has_more));
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const filteredClients = useMemo(() => {
    if (filter === 'all') return clients;
    return [];
  }, [clients, filter]);

  type ListRow =
    | { kind: 'client'; client: Client }
    | { kind: 'attention'; item: AttentionQueueItem };

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'client', label: 'Waiting on client' },
    { key: 'us', label: 'Waiting on us' },
  ];

  const listData: ListRow[] =
    filter === 'all'
      ? filteredClients.map((c) => ({ kind: 'client' as const, client: c }))
      : attention.map((a) => ({ kind: 'attention' as const, item: a }));

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <AppBackButton onPress={() => router.back()} />
        <AppHeaderTitle>My Clients</AppHeaderTitle>
        <TouchableOpacity onPress={() => setShowCreate(true)} hitSlop={12}>
          <Ionicons name="add-circle" size={28} color="#0D9488" />
        </TouchableOpacity>
      </View>

      <View style={[styles.searchWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="search" size={18} color={colors.textSecondary} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search clients…"
          placeholderTextColor={colors.textSecondary}
          value={q}
          onChangeText={setQ}
        />
      </View>

      <View style={styles.tabs}>
        {tabs.map((t) => (
          <TouchableOpacity
            key={t.key}
            onPress={() => setFilter(t.key)}
            style={[
              styles.tab,
              {
                backgroundColor: filter === t.key ? '#0D9488' : colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <Text
              style={{
                color: filter === t.key ? '#fff' : colors.text,
                fontSize: 12,
                fontWeight: '600',
              }}
            >
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#0D9488" />
      ) : (
        <FlatList
          data={listData}
          keyExtractor={(item) =>
            item.kind === 'client' ? `c-${item.client.id}` : `a-${item.item.client.id}`
          }
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
          ListHeaderComponent={
            filter === 'all' && attention.length > 0 ? (
              <View style={{ marginBottom: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0 }]}>Needs attention</Text>
                  <TouchableOpacity onPress={() => setTasksOpen(true)} hitSlop={8}>
                    <Text style={{ color: '#0D9488', fontWeight: '700', fontSize: 13 }}>All pending</Text>
                  </TouchableOpacity>
                </View>
                {attention.slice(0, 5).map((item) => (
                  <TouchableOpacity
                    key={item.client.id}
                    style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
                    onPress={() => router.push(`/clients/${item.client.id}` as any)}
                  >
                    <Text style={[styles.cardTitle, { color: colors.text }]}>
                      {item.client.display_name}
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                      {item.attention.next_step?.label ||
                        attentionStatusLabel(item.attention.status)}
                    </Text>
                  </TouchableOpacity>
                ))}
                <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 12 }]}>
                  All clients
                </Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={{ color: colors.textSecondary, textAlign: 'center' }}>
                {filter === 'all' ? 'No clients yet' : 'No open waits'}
              </Text>
              {filter === 'all' ? (
                <TouchableOpacity style={styles.emptyBtn} onPress={() => setShowCreate(true)}>
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Create client</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          }
          renderItem={({ item }) => {
            const c = item.kind === 'client' ? item.client : item.item.client;
            const att =
              item.kind === 'attention'
                ? item.item.attention
                : item.client.attention;
            const email = primaryEmail(c);
            return (
              <TouchableOpacity
                style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => router.push(`/clients/${c.id}` as any)}
              >
                <View style={styles.cardRow}>
                  <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
                    {c.display_name}
                  </Text>
                  <Text style={styles.statusPill}>
                    {attentionStatusLabel(att?.status || 'on_track')}
                  </Text>
                </View>
                {email ? (
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
                    {email}
                  </Text>
                ) : null}
                {att?.next_step?.label ? (
                  <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }} numberOfLines={2}>
                    {att.next_step.label}
                  </Text>
                ) : null}
              </TouchableOpacity>
            );
          }}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? <ActivityIndicator style={{ marginVertical: 12 }} color="#0D9488" /> : null
          }
        />
      )}

      <PendingTasksModal
        visible={tasksOpen}
        onClose={() => setTasksOpen(false)}
        seedItems={attention}
      />
      <ClientPickerModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        selectedClientIds={[]}
        onChange={(ids) => {
          if (ids[0]) {
            setShowCreate(false);
            router.push(`/clients/${ids[0]}` as any);
          }
        }}
        allowCreate
        multi={false}
        forceShow
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
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 2 },
  tabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', marginBottom: 8 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 10,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  cardTitle: { fontSize: 16, fontWeight: '600', flex: 1 },
  statusPill: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0D9488',
  },
  empty: { alignItems: 'center', paddingVertical: 48, gap: 16 },
  emptyBtn: {
    backgroundColor: '#0D9488',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
  },
});
