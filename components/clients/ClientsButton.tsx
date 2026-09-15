import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useVisibleApps } from '../../contexts/VisibleAppsContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  getClientsCount,
  getClientsForItem,
  prefetchClientsPicker,
  setItemClients,
} from '../../services/clientsApi';
import ClientPickerModal from './ClientPickerModal';

export interface ClientsButtonProps {
  selectedClientIds?: number[];
  onChange?: (ids: number[]) => void;
  itemType?: string;
  itemId?: number;
  allowCreate?: boolean;
  multi?: boolean;
  compact?: boolean;
  label?: string;
}

export default function ClientsButton({
  selectedClientIds,
  onChange,
  itemType,
  itemId,
  allowCreate = true,
  multi = true,
  compact = true,
  label = 'Clients',
}: ClientsButtonProps) {
  const colors = useThemeColors();
  const { isHomeAppVisible } = useVisibleApps();
  const clientsFeatureVisible = isHomeAppVisible('clients');
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<number[]>(selectedClientIds || []);
  const controlledRef = useRef(selectedClientIds !== undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (selectedClientIds === undefined) return;
    controlledRef.current = true;
    setIds(selectedClientIds);
  }, [selectedClientIds]);

  useEffect(() => {
    if (!clientsFeatureVisible) {
      setCount(null);
      return;
    }
    let cancelled = false;
    void prefetchClientsPicker()
      .then((data) => {
        if (!cancelled) setCount(data.count);
      })
      .catch(() => {
        void getClientsCount()
          .then((c) => {
            if (!cancelled) setCount(c);
          })
          .catch(() => {
            if (!cancelled) setCount(0);
          });
      });
    return () => {
      cancelled = true;
    };
  }, [clientsFeatureVisible]);

  const loadLinked = useCallback(async () => {
    if (!itemType || itemId == null) return;
    try {
      const clients = await getClientsForItem(itemType, itemId);
      const next = clients.map((c) => c.id);
      setIds(next);
      onChangeRef.current?.(next);
    } catch {
      /* ignore */
    }
  }, [itemType, itemId]);

  useEffect(() => {
    if (!clientsFeatureVisible) return;
    if (!itemType || itemId == null) return;
    if (controlledRef.current && selectedClientIds && selectedClientIds.length > 0) return;
    void loadLinked();
  }, [clientsFeatureVisible, itemType, itemId, loadLinked, selectedClientIds]);

  const handleSave = async (nextIds: number[]) => {
    setIds(nextIds);
    onChangeRef.current?.(nextIds);
    if (itemType && itemId != null) {
      await setItemClients({
        client_ids: nextIds,
        item_type: itemType,
        item_id: itemId,
      });
      try {
        setCount(await getClientsCount());
      } catch {
        /* ignore */
      }
    }
  };

  if (!clientsFeatureVisible) return null;
  if (count === null) return null;
  if (count === 0 && !allowCreate) return null;

  const badge = ids.length;

  return (
    <>
      <TouchableOpacity
        onPress={() => {
          setOpen(true);
          if (itemType && itemId != null) void loadLinked();
        }}
        style={compact ? styles.compact : [styles.full, { backgroundColor: colors.card }]}
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      >
        <Ionicons name="people-outline" size={compact ? 16 : 18} color={colors.textSecondary} />
        <Text style={[compact ? styles.compactLabel : styles.fullLabel, { color: colors.textSecondary }]}>
          {label}
        </Text>
        {badge > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
      </TouchableOpacity>

      <ClientPickerModal
        isOpen={open}
        onClose={() => setOpen(false)}
        selectedClientIds={ids}
        onChange={(next) => {
          setIds(next);
          onChangeRef.current?.(next);
        }}
        onSave={
          itemType && itemId != null
            ? async (next) => {
                try {
                  await handleSave(next);
                } catch (err: any) {
                  Alert.alert('Error', err?.message || 'Failed to update clients');
                  throw err;
                }
              }
            : undefined
        }
        allowCreate={allowCreate}
        multi={multi}
        forceShow
      />
    </>
  );
}

const styles = StyleSheet.create({
  compact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  full: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  compactLabel: { fontSize: 12, fontWeight: '500' },
  fullLabel: { fontSize: 14, fontWeight: '500' },
  badge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#0D9488',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
