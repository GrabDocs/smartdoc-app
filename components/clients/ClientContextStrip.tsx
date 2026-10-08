import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  getClientOverview,
  getClientsForItem,
  type Client,
  type ClientOverview,
} from '../../services/clientsApi';

type Props = {
  itemType: string;
  itemId: number;
  /** Bump to re-fetch linked clients after an external assign/unlink. */
  reloadToken?: number | string;
  /** When true, show a muted "No clients linked" row instead of hiding. */
  showEmpty?: boolean;
};

/**
 * Strip showing linked client name + pending work chips (email threads).
 */
export default function ClientContextStrip({
  itemType,
  itemId,
  reloadToken = 0,
  showEmpty = false,
}: Props) {
  const colors = useThemeColors();
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [overview, setOverview] = useState<ClientOverview | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getClientsForItem(itemType, itemId);
        if (cancelled) return;
        if (!list.length) {
          setClients([]);
          setOverview(null);
          return;
        }
        setClients(list);
        const ov = await getClientOverview(list[0].id);
        if (!cancelled) setOverview(ov);
      } catch {
        if (!cancelled) {
          setClients([]);
          setOverview(null);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemType, itemId, reloadToken]);

  if (!clients.length) {
    if (!showEmpty || !loaded) return null;
    return (
      <View style={[styles.wrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.nameRow}>
          <Ionicons name="people-outline" size={16} color={colors.textSecondary} />
          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>No clients linked</Text>
        </View>
      </View>
    );
  }

  const primary = clients[0];
  const oc = overview?.attention?.open_counts;

  return (
    <View style={[styles.wrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <TouchableOpacity
        style={styles.nameRow}
        onPress={() => router.push(`/clients/${primary.id}` as any)}
      >
        <Ionicons name="people-outline" size={16} color="#0D9488" />
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
          {primary.display_name}
        </Text>
        {clients.length > 1 ? (
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>+{clients.length - 1}</Text>
        ) : null}
      </TouchableOpacity>
      {oc ? (
        <View style={styles.chips}>
          {(oc.intakes_pending > 0 || oc.signatures_pending > 0) && (
            <TouchableOpacity
              style={styles.chip}
              onPress={() => router.push(`/clients/${primary.id}?tab=work` as any)}
            >
              <Text style={styles.chipText}>
                {oc.intakes_pending + oc.signatures_pending} pending
              </Text>
            </TouchableOpacity>
          )}
          {oc.file_requests_open > 0 && (
            <TouchableOpacity
              style={styles.chip}
              onPress={() => router.push('/upload-links' as any)}
            >
              <Text style={styles.chipText}>{oc.file_requests_open} open request</Text>
            </TouchableOpacity>
          )}
          {oc.emails_needs_reply > 0 && (
            <TouchableOpacity
              style={styles.chip}
              onPress={() => router.push('/email-sync/replies' as any)}
            >
              <Text style={styles.chipText}>{oc.emails_needs_reply} needs reply</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
    marginBottom: 8,
    gap: 8,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flex: 1, fontSize: 14, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    backgroundColor: 'rgba(13, 148, 136, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  chipText: { fontSize: 11, color: '#0D9488', fontWeight: '600' },
});
