import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';
import CallsSetupGuide from '../../../components/assist/CallsSetupGuide';
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

function formatCallWhen(iso?: string | null): string {
  if (!iso) return '';
  const normalized = String(iso).replace(/(\.\d{3})\d+/, '$1');
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function callMediaLabel(recording?: string, transcript?: string): string {
  if (transcript === 'paused_credits') return 'Needs credits';
  if (recording === 'ready' && transcript === 'ready') return 'Recorded';
  if (recording === 'ready' && transcript === 'pending') return 'Transcribing';
  if (recording === 'ready') return 'No transcript';
  if (recording === 'pending') return 'Saving recording';
  return 'Not recorded';
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
  const [testing, setTesting] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopHealthPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
    try {
      const res = await listAssistCalls(ownerId);
      setCalls(res?.calls || []);
      setHealth(res?.health || null);
      return res?.health || null;
    } catch {
      setCalls([]);
      return null;
    } finally {
      if (!opts?.quiet) setLoading(false);
    }
  }, [ownerId]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => stopHealthPoll();
    }, [load, stopHealthPoll]),
  );

  const placeTestCall = async () => {
    if (testing) return;
    setTesting(true);
    try {
      await startAssistTestCall();
      Alert.alert('Test call', 'GrabDocs is calling your ring number. Answer to confirm forwarding.');
      stopHealthPoll();
      let tries = 0;
      pollRef.current = setInterval(() => {
        tries += 1;
        void load({ quiet: true }).then((next) => {
          if (next?.status === 'Healthy' || tries >= 20) {
            stopHealthPoll();
            setTesting(false);
          }
        });
      }, 3000);
    } catch (e: any) {
      setTesting(false);
      Alert.alert('Test call', e?.response?.data?.reason || 'Could not place the test call');
    }
  };

  const healthy = health?.status === 'Healthy';
  const needsAttention =
    health?.status === 'Needs attention' || health?.status === 'Not configured';

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
        <View
          style={[
            styles.healthCard,
            {
              borderColor: healthy ? '#A7F3D0' : needsAttention ? '#FDE68A' : colors.border,
              backgroundColor: healthy ? '#ECFDF5' : needsAttention ? '#FFFBEB' : colors.card,
            },
          ]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {healthy ? (
              <Ionicons name="checkmark-circle" size={20} color="#059669" />
            ) : needsAttention ? (
              <Ionicons name="warning" size={20} color="#D97706" />
            ) : null}
            <Text style={{ fontWeight: '700', color: colors.text }}>
              {healthy ? 'Calls is set up' : `Status: ${health.status}`}
            </Text>
          </View>
          {health.phone ? (
            <>
              <Text style={{ color: colors.textSecondary, marginTop: 8, fontSize: 12 }}>
                GrabDocs capture number
              </Text>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 18, marginTop: 2 }}>
                {health.phone}
              </Text>
              <Text style={{ color: colors.textSecondary, marginTop: 4, fontSize: 12 }}>
                Forward your personal number here. Open setup instructions for eSIM and forwarding steps.
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
                <TouchableOpacity onPress={() => setSetupOpen(true)}>
                  <Text style={{ color: '#0284C7', fontWeight: '700' }}>Setup instructions</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : health.status !== 'Disabled' ? (
            <Text style={{ color: colors.textSecondary, marginTop: 4, fontSize: 12 }}>
              No capture number yet. An admin must assign one before you can forward calls.
            </Text>
          ) : null}
          {healthy ? (
            <Text style={{ color: '#047857', marginTop: 8, fontSize: 13 }}>
              {health.message || 'Capture number, forwarding, and a recent ring check are in place.'}
            </Text>
          ) : health.message ? (
            <Text style={{ color: needsAttention ? '#92400E' : colors.textSecondary, marginTop: 8 }}>
              {health.message}
            </Text>
          ) : null}
          {health.status !== 'Disabled' && health.phone && !healthy ? (
            <TouchableOpacity onPress={() => void placeTestCall()} disabled={testing}>
              <Text style={{ color: '#B45309', fontWeight: '700', marginTop: 8, opacity: testing ? 0.5 : 1 }}>
                {testing ? 'Waiting for test call…' : 'Re-test'}
              </Text>
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
            const when = formatCallWhen(item.started_at);
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
                  {party ? ` · ${party}` : ''}
                  {when ? ` · ${when}` : ''} · {callMediaLabel(item.recording_status, item.transcript_status)}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      )}

      <Modal
        visible={setupOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSetupOpen(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'bottom']}>
          <View style={styles.header}>
            <View style={{ width: 40 }} />
            <AppHeaderTitle>Setup instructions</AppHeaderTitle>
            <TouchableOpacity
              onPress={() => setSetupOpen(false)}
              style={{ width: 40, alignItems: 'flex-end', padding: 8 }}
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
            <CallsSetupGuide captureNumber={health?.phone || null} />
          </ScrollView>
        </SafeAreaView>
      </Modal>
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
  healthCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
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
