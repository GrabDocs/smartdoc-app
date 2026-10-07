import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import AdaptiveListPickerModal from '../AdaptiveListPickerModal';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import {
  createClient,
  listClients,
  prefetchClientsPicker,
  type Client,
  type ClientVisibility,
} from '../../services/clientsApi';

export interface ClientPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedClientIds: number[];
  onChange: (ids: number[]) => void;
  onSave?: (ids: number[]) => void | Promise<void>;
  allowCreate?: boolean;
  multi?: boolean;
  forceShow?: boolean;
}

export default function ClientPickerModal({
  isOpen,
  onClose,
  selectedClientIds,
  onChange,
  onSave,
  allowCreate = true,
  multi = true,
  forceShow = false,
}: ClientPickerModalProps) {
  const colors = useThemeColors();
  const [count, setCount] = useState<number | null>(null);
  const [recent, setRecent] = useState<Client[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createVisibility, setCreateVisibility] = useState<ClientVisibility>('company');
  const [isCompanyUser, setIsCompanyUser] = useState(false);
  const [creating, setCreating] = useState(false);
  const [localIds, setLocalIds] = useState<number[]>(selectedClientIds);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isOpen) {
      setLocalIds(selectedClientIds);
      setQ('');
      return;
    }
    setShowCreate(false);
    setCreateName('');
    setCreateEmail('');
  }, [isOpen, selectedClientIds]);

  useEffect(() => {
    if (!isOpen) return;
    void apiClient.client
      .get('/api/v1/web/user')
      .then((res: { data?: { company_id?: number } }) => {
        const company = Number(res.data?.company_id || 0) > 0;
        setIsCompanyUser(company);
        setCreateVisibility(company ? 'company' : 'private');
      })
      .catch(() => {
        setIsCompanyUser(false);
        setCreateVisibility('private');
      });
  }, [isOpen]);

  const loadLists = useCallback(async (search: string) => {
    setLoading(true);
    try {
      if (!search.trim()) {
        const data = await prefetchClientsPicker();
        setCount(data.count);
        setRecent(data.recent);
        setClients(data.clients);
        if (data.count === 0 && allowCreate) setShowCreate(true);
        return;
      }
      const listRes = await listClients({ status: 'active', q: search, limit: 100 });
      setClients(listRes.clients || []);
      setCount(listRes.total_count ?? listRes.clients?.length ?? 0);
      setRecent([]);
    } catch {
      Alert.alert('Error', 'Failed to load clients');
    } finally {
      setLoading(false);
    }
  }, [allowCreate]);

  useEffect(() => {
    if (!isOpen) return;
    void loadLists('');
  }, [isOpen, loadLists]);

  useEffect(() => {
    if (!isOpen) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void loadLists(q);
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [q, isOpen, loadLists]);

  const toggle = (id: number) => {
    setLocalIds((prev) => {
      if (multi) {
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      }
      return prev.includes(id) ? [] : [id];
    });
  };

  const handleCreate = async () => {
    if (!createName.trim()) {
      Alert.alert('Error', 'Name is required');
      return;
    }
    if (!createEmail.trim()) {
      Alert.alert('Error', 'Email is required');
      return;
    }
    setCreating(true);
    try {
      const created = await createClient({
        display_name: createName.trim(),
        email: createEmail.trim(),
        visibility: isCompanyUser ? createVisibility : 'private',
      });
      setCreateName('');
      setCreateEmail('');
      setShowCreate(false);
      const next = multi ? [...localIds, created.id] : [created.id];
      setLocalIds(next);
      onChange(next);
      await loadLists(q);
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || err?.message || 'Failed to create client');
    } finally {
      setCreating(false);
    }
  };

  const handleConfirm = async () => {
    if (onSave) {
      setSaving(true);
      try {
        await onSave(localIds);
        onChange(localIds);
        onClose();
      } catch (err: any) {
        Alert.alert('Error', err?.response?.data?.error || err?.message || 'Failed to save clients');
      } finally {
        setSaving(false);
      }
    } else {
      onChange(localIds);
      onClose();
    }
  };

  const searching = !!q.trim();
  const recentIds = new Set(recent.map((c) => c.id));
  const otherClients = searching ? clients : clients.filter((c) => !recentIds.has(c.id));
  const rowCount = showCreate ? 1 : recent.length + otherClients.length;
  const canReturnToList = (count ?? 0) > 0 || recent.length > 0 || clients.length > 0;

  if (!isOpen) return null;
  if (count === 0 && !allowCreate && !forceShow) return null;

  const renderRow = (c: Client) => {
    const selected = localIds.includes(c.id);
    return (
      <TouchableOpacity
        key={c.id}
        style={[styles.row, { borderBottomColor: colors.border }]}
        onPress={() => toggle(c.id)}
        activeOpacity={0.7}
      >
        <Ionicons
          name={selected ? (multi ? 'checkbox' : 'radio-button-on') : multi ? 'square-outline' : 'radio-button-off'}
          size={22}
          color={selected ? '#0D9488' : colors.textSecondary}
        />
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
            {c.display_name}
          </Text>
          {c.identifiers?.find((i) => i.identifier_type === 'email') ? (
            <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
              {c.identifiers.find((i) => i.identifier_type === 'email')?.identifier_value}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <AdaptiveListPickerModal
      visible={isOpen}
      onClose={onClose}
      title={showCreate ? 'New client' : multi ? 'Select clients' : 'Select client'}
      itemCount={Math.max(rowCount, 1)}
      footer={
        <View style={styles.footer}>
          {showCreate ? (
            <TouchableOpacity
              onPress={() => (canReturnToList ? setShowCreate(false) : onClose())}
              style={styles.createLink}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 14 }}>
                {canReturnToList ? 'Back' : 'Cancel'}
              </Text>
            </TouchableOpacity>
          ) : allowCreate ? (
            <TouchableOpacity
              onPress={() => setShowCreate(true)}
              style={styles.createLink}
            >
              <Ionicons name="add" size={18} color="#0D9488" />
              <Text style={styles.createLinkText}>New client</Text>
            </TouchableOpacity>
          ) : (
            <View />
          )}
          {showCreate ? (
            <TouchableOpacity
              style={[styles.doneBtn, { opacity: creating ? 0.6 : 1 }]}
              onPress={() => void handleCreate()}
              disabled={creating}
            >
              {creating ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.doneBtnText}>Create</Text>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.doneBtn, { opacity: saving ? 0.6 : 1 }]}
              onPress={() => void handleConfirm()}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.doneBtnText}>{onSave ? 'Save' : 'Done'}</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      }
    >
      <View style={styles.body}>
        {showCreate ? (
          <View style={styles.createBox}>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
              placeholder="Display name"
              placeholderTextColor={colors.textSecondary}
              value={createName}
              onChangeText={setCreateName}
            />
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
              placeholder="Email"
              placeholderTextColor={colors.textSecondary}
              value={createEmail}
              onChangeText={setCreateEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            {isCompanyUser ? (
              <View style={styles.visRow}>
                {(['company', 'private'] as ClientVisibility[]).map((v) => (
                  <TouchableOpacity
                    key={v}
                    onPress={() => setCreateVisibility(v)}
                    style={[
                      styles.visChip,
                      {
                        backgroundColor: createVisibility === v ? '#0D9488' : colors.card,
                        borderColor: colors.border,
                      },
                    ]}
                  >
                    <Text style={{ color: createVisibility === v ? '#fff' : colors.text, fontSize: 13 }}>
                      {v === 'company' ? 'Company' : 'Private'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </View>
        ) : (
          <>
            <View style={[styles.searchWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="search" size={18} color={colors.textSecondary} />
              <TextInput
                style={[styles.searchInput, { color: colors.text }]}
                placeholder="Search clients…"
                placeholderTextColor={colors.textSecondary}
                value={q}
                onChangeText={setQ}
                autoCorrect={false}
              />
            </View>

            {loading ? (
              <ActivityIndicator style={{ marginVertical: 24 }} color="#0D9488" />
            ) : (
              <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                {!searching && recent.length > 0 ? (
                  <>
                    <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Recent</Text>
                    {recent.map(renderRow)}
                  </>
                ) : null}
                {otherClients.length > 0 || searching ? (
                  <>
                    <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
                      {searching ? 'Results' : 'All clients'}
                    </Text>
                    {otherClients.length === 0 ? (
                      <Text style={[styles.empty, { color: colors.textSecondary }]}>No clients found.</Text>
                    ) : (
                      otherClients.map(renderRow)
                    )}
                  </>
                ) : null}
              </ScrollView>
            )}
          </>
        )}
      </View>
    </AdaptiveListPickerModal>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 4,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 4 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginTop: 12,
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '500' },
  rowSub: { fontSize: 12, marginTop: 2 },
  empty: { fontSize: 14, paddingVertical: 12 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    gap: 12,
  },
  createLink: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  createLinkText: { color: '#0D9488', fontWeight: '600', fontSize: 14 },
  doneBtn: {
    backgroundColor: '#0D9488',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 88,
    alignItems: 'center',
  },
  doneBtnText: { color: '#fff', fontWeight: '600' },
  createBox: {
    gap: 8,
    marginTop: 4,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  visRow: { flexDirection: 'row', gap: 8 },
  visChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
