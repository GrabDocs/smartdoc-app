import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { listAssistCalls, startAssistTestCall } from '../../../services/assistApi';

export default function AssistCallsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ owner_user_id?: string }>();
  const ownerId = params.owner_user_id ? Number(params.owner_user_id) : undefined;
  const colors = useThemeColors();
  const [loading, setLoading] = useState(true);
  const [calls, setCalls] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAssistCalls(ownerId);
      setCalls(res?.calls || []);
      setHealth(res?.health || null);
    } catch {
      setCalls([]);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle title="Calls" />
        <View style={{ width: 40 }} />
      </View>
      {health ? (
        <View style={styles.health}>
          <Text style={{ fontWeight: '700', color: colors.text }}>Status: {health.status}</Text>
          {health.phone ? (
            <>
              <Text style={{ color: colors.textSecondary, marginTop: 8, fontSize: 12 }}>
                GrabDocs capture number
              </Text>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 18, marginTop: 2 }}>
                {health.phone}
              </Text>
              <Text style={{ color: colors.textSecondary, marginTop: 4, fontSize: 12 }}>
                Forward your personal number here. Open Assist settings for eSIM and forwarding steps.
              </Text>
              <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
                <TouchableOpacity
                  onPress={async () => {
                    await Clipboard.setStringAsync(String(health.phone));
                    Alert.alert('Copied', String(health.phone));
                  }}
                >
                  <Text style={{ color: '#0284C7', fontWeight: '700' }}>Copy number</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => router.push('/assist/settings' as any)}>
                  <Text style={{ color: '#0284C7', fontWeight: '700' }}>Setup instructions</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : health.status !== 'Disabled' ? (
            <Text style={{ color: colors.textSecondary, marginTop: 4, fontSize: 12 }}>
              No capture number yet. An admin must assign one before you can forward calls.
            </Text>
          ) : null}
          {health.message ? (
            <Text style={{ color: colors.textSecondary, marginTop: 4 }}>{health.message}</Text>
          ) : null}
          {health.status !== 'Disabled' && health.phone ? (
            <TouchableOpacity
              onPress={() =>
                void startAssistTestCall()
                  .then(() => Alert.alert('Test call', 'GrabDocs is calling your ring number.'))
                  .catch((e) => Alert.alert('Test call', e?.response?.data?.reason || 'Could not place the test call'))
              }
            >
              <Text style={{ color: '#0284C7', fontWeight: '700', marginTop: 8 }}>Re-test</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 30 }} color="#0284C7" />
      ) : (
        <FlatList
          data={calls}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={
            <Text style={{ color: colors.textSecondary }}>No captured calls yet.</Text>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.row, { borderColor: colors.border, backgroundColor: colors.card }]}
              onPress={() =>
                router.push({
                  pathname: `/assist/calls/${item.id}`,
                  params: ownerId ? { owner_user_id: String(ownerId) } : {},
                } as any)
              }
            >
              <Text style={{ fontWeight: '600', color: colors.text }}>
                {item.headline || item.from_number || 'Call'}
              </Text>
              <Text style={{ color: colors.textSecondary, marginTop: 4, fontSize: 12 }}>
                {item.started_at || ''} · {item.recording_status}/{item.transcript_status}
              </Text>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  health: { paddingHorizontal: 16, paddingBottom: 8 },
  row: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
});
