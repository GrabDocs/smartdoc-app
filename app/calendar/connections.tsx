import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  calendarConnections,
  calendarDeleteConnection,
  calendarResetConnection,
  calendarSetDefaultConnection,
  calendarSyncGoogleWithStaleConnectionRecovery,
  formatCalendarSyncMessage,
  type CalendarConnection,
  type CalendarProvider,
} from '../../services/calendarApi';
import {
  calendarConnectionProvider,
  canConnectMoreCalendarProviders,
  connectionDisplayLabel,
} from '../../utils/calendarConnections';
import { CalendarOAuthWebView } from './_components/CalendarOAuthWebView';
import { ConnectCalendarModal } from './_components/ConnectCalendarModal';
import { ConnectionChips } from './_components/ConnectionChips';

import AppBackButton, { APP_BACK_BUTTON_SLOT } from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

export default function CalendarConnectionsScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState<CalendarConnection[]>([]);
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [oauthProvider, setOauthProvider] = useState<CalendarProvider>('google');
  const [busyConnectionId, setBusyConnectionId] = useState<number | null>(null);
  const [cardBusyId, setCardBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const c = await calendarConnections();
    setList(c);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await load();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const hasGoogle = useMemo(() => list.some((c) => calendarConnectionProvider(c) === 'google'), [list]);
  const hasMicrosoft = useMemo(
    () => list.some((c) => calendarConnectionProvider(c) === 'microsoft'),
    [list]
  );
  const canConnectMore = useMemo(() => canConnectMoreCalendarProviders(list), [list]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { flexDirection: 'row', alignItems: 'center', padding: 12 , backgroundColor: colors.headerBackground },
        h1: { fontSize: 20, fontWeight: '700', color: colors.text, flex: 1 },
        card: {
          margin: 16,
          padding: 14,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        },
        row: { marginBottom: 14 },
        name: { fontWeight: '600', color: colors.text },
        meta: { color: colors.textSecondary, fontSize: 13, marginTop: 4 },
        btn: {
          backgroundColor: '#007AFF',
          padding: 14,
          borderRadius: 10,
          marginHorizontal: 16,
          marginBottom: 10,
          alignItems: 'center',
        },
        btnText: { color: '#fff', fontWeight: '600' },
        secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
      }),
    [colors]
  );

  const syncAll = async () => {
    try {
      const result = await calendarSyncGoogleWithStaleConnectionRecovery();
      Alert.alert('Sync', formatCalendarSyncMessage(result));
      await load();
    } catch (e: any) {
      Alert.alert('Sync failed', e?.response?.data?.error || e?.message || '');
    }
  };

  const openOAuth = (provider: CalendarProvider) => {
    setOauthProvider(provider);
    setConnectModalOpen(false);
    setOauthOpen(true);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Calendar connections</AppHeaderTitle>
        <View style={{ width: APP_BACK_BUTTON_SLOT }} />
      </View>

      {list.length === 0 || canConnectMore ? (
        <TouchableOpacity style={styles.btn} onPress={() => setConnectModalOpen(true)}>
          <Text style={styles.btnText}>{list.length === 0 ? 'Connect calendar' : 'Connect another'}</Text>
        </TouchableOpacity>
      ) : null}
      <FeedbackTouchable style={[styles.btn, styles.secondary]} onPress={syncAll} spinnerColor={colors.text}>
        <Text style={[styles.btnText, { color: colors.text }]}>Sync all calendars</Text>
      </FeedbackTouchable>

      {loading ? <ActivityIndicator style={{ marginTop: 24 }} /> : null}

      {!loading && list.length === 0 ? (
        <View style={{ paddingHorizontal: 24, paddingTop: 24 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>No connections yet</Text>
          <Text style={{ color: colors.textSecondary, marginTop: 8, lineHeight: 22 }}>
            Connect Google Calendar or Microsoft 365 to sync events into GrabDocs. After connecting, use Sync all
            calendars to pull the latest.
          </Text>
        </View>
      ) : null}

      {!loading && list.length > 0 ? (
        <ConnectionChips
          connections={list}
          canConnectMore={canConnectMore}
          onSetDefault={async (id) => {
            try {
              const res = await calendarSetDefaultConnection(id);
              await load();
              Alert.alert('Default calendar', res?.message || 'Default calendar updated');
            } catch (e: any) {
              Alert.alert('Error', e?.response?.data?.error || '');
            }
          }}
          onDisconnect={(connection) => {
            const label = connectionDisplayLabel(connection);
            Alert.alert(
              'Disconnect calendar',
              `Disconnect ${label}?\n\nSynced events will be removed from GrabDocs. Events you created in GrabDocs keep working. Reconnect later to restore synced events.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Disconnect',
                  style: 'destructive',
                  onPress: async () => {
                    setBusyConnectionId(Number(connection.id));
                    try {
                      await calendarDeleteConnection(Number(connection.id));
                      await load();
                    } catch (e: any) {
                      Alert.alert('Error', e?.response?.data?.error || '');
                    } finally {
                      setBusyConnectionId(null);
                    }
                  },
                },
              ]
            );
          }}
          onAddAnother={() => setConnectModalOpen(true)}
          busyConnectionId={busyConnectionId}
        />
      ) : null}

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {list.map((c) => (
          <View key={String(c.id)} style={styles.card}>
            <Text style={styles.name}>{connectionDisplayLabel(c)}</Text>
            <Text style={styles.meta}>
              Status: {c.status || '—'}
              {c.is_default ? ' · Default for new events' : ''}
            </Text>
            <View style={{ flexDirection: 'row', marginTop: 12, gap: 12 }}>
              <FeedbackTouchable
                spinnerColor="#007AFF"
                disabled={cardBusyId != null}
                onPress={async () => {
                  try {
                    await calendarResetConnection(Number(c.id));
                    await load();
                  } catch (e: any) {
                    Alert.alert('Error', e?.response?.data?.error || '');
                  }
                }}
              >
                <Text style={{ color: '#007AFF' }}>Resume / reset</Text>
              </FeedbackTouchable>
              <FeedbackTouchable
                spinnerColor="#ef4444"
                disabled={cardBusyId != null}
                loading={cardBusyId === Number(c.id)}
                onPress={() => {
                  Alert.alert(
                    'Disconnect calendar',
                    'Synced events will be removed from GrabDocs. Events you created in GrabDocs keep working. Reconnect later to restore synced events.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Disconnect',
                        style: 'destructive',
                        onPress: async () => {
                          setCardBusyId(Number(c.id));
                          try {
                            await calendarDeleteConnection(Number(c.id));
                            await load();
                          } catch (e: any) {
                            Alert.alert('Error', e?.response?.data?.error || '');
                          } finally {
                            setCardBusyId(null);
                          }
                        },
                      },
                    ]
                  );
                }}
              >
                <Text style={{ color: '#ef4444' }}>Disconnect</Text>
              </FeedbackTouchable>
            </View>
          </View>
        ))}
      </ScrollView>

      <ConnectCalendarModal
        visible={connectModalOpen}
        hasGoogle={hasGoogle}
        hasMicrosoft={hasMicrosoft}
        onClose={() => setConnectModalOpen(false)}
        onConnectGoogle={() => openOAuth('google')}
        onConnectMicrosoft={() => openOAuth('microsoft')}
      />

      <CalendarOAuthWebView
        visible={oauthOpen}
        provider={oauthProvider}
        onClose={() => setOauthOpen(false)}
        onSuccess={async () => {
          await load();
          const result = await calendarSyncGoogleWithStaleConnectionRecovery({ silent: true }).catch(() => null);
          if (result) Alert.alert('Connected', formatCalendarSyncMessage(result));
        }}
        onError={(msg) => Alert.alert('Connection', msg)}
      />
    </SafeAreaView>
  );
}
