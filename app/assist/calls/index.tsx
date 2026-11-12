import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { listAssistCalls, startAssistOutboundCall, startAssistTestCall } from '../../../services/assistApi';

function otherParty(call: any): string {
  if ((call?.direction || '') === 'outbound') {
    return call?.to_number || '';
  }
  return call?.from_number || '';
}

function directionLabel(direction?: string): string {
  if (direction === 'outbound') return 'Outbound';
  if (direction === 'test') return 'Test';
  return 'Inbound';
}

export default function AssistCallsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ owner_user_id?: string }>();
  const ownerId = params.owner_user_id ? Number(params.owner_user_id) : undefined;
  const colors = useThemeColors();
  const [loading, setLoading] = useState(true);
  const [calls, setCalls] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [dialTo, setDialTo] = useState('');
  const [dialing, setDialing] = useState(false);

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

  const placeOutbound = async () => {
    const to = dialTo.trim();
    if (!to || dialing) return;
    setDialing(true);
    try {
      await startAssistOutboundCall(to);
      Alert.alert('Calling', 'GrabDocs is calling your phone. Answer to connect the other party.');
      setDialTo('');
      await load();
    } catch (e: any) {
      Alert.alert(
        'Call',
        e?.response?.data?.message ||
          e?.response?.data?.reason ||
          e?.response?.data?.error ||
          'Could not place the call',
      );
    } finally {
      setDialing(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Calls</AppHeaderTitle>
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

      {!ownerId && health?.phone ? (
        <View style={[styles.dial, { borderColor: colors.border }]}>
          <Text style={{ fontWeight: '700', color: colors.text }}>Place a call</Text>
          <Text style={{ color: colors.textSecondary, marginTop: 4, fontSize: 12 }}>
            Your phone rings first; after you answer, GrabDocs dials the other party.
          </Text>
          <TextInput
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.border, backgroundColor: colors.card },
            ]}
            placeholder="+1 555 123 4567"
            placeholderTextColor={colors.textSecondary}
            keyboardType="phone-pad"
            autoComplete="tel"
            value={dialTo}
            onChangeText={setDialTo}
            editable={!dialing}
          />
          <TouchableOpacity
            onPress={() => void placeOutbound()}
            disabled={dialing || !dialTo.trim()}
            style={[styles.callBtn, { opacity: dialing || !dialTo.trim() ? 0.5 : 1 }]}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>{dialing ? 'Calling…' : 'Call'}</Text>
          </TouchableOpacity>
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
          renderItem={({ item }) => {
            const party = otherParty(item);
            return (
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
                  {item.headline || party || 'Call'}
                </Text>
                <Text style={{ color: colors.textSecondary, marginTop: 4, fontSize: 12 }}>
                  {directionLabel(item.direction)}
                  {party ? ` · ${party}` : ''} · {item.started_at || ''} · {item.recording_status}/
                  {item.transcript_status}
                </Text>
              </TouchableOpacity>
            );
          }}
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
  dial: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  input: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  callBtn: {
    marginTop: 10,
    backgroundColor: '#0284C7',
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 12,
  },
  row: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
});
