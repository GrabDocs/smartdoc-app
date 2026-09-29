import { Ionicons } from '@expo/vector-icons';
import { useNetworkState } from 'expo-network';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import LinkifiedText from '../../../components/LinkifiedText';
import { useThemeColors } from '../../../hooks/useThemeColors';
import {
  flushPendingCalendarCreates,
  getPendingCalendarCreate,
  removePendingCalendarCreate,
  resetPendingCalendarToQueued,
  type PendingCalendarCreate,
} from '@/utils/calendarPendingCreates';
import { isDeviceOfflineForCalendar } from '@/utils/calendarOffline';
import { calendarDisplayLocation, formatEventWhen } from '../../../utils/calendarTime';
import { openMapsForLocationLabel } from '../../../utils/openMapsQuery';

import AppBackButton, { APP_BACK_BUTTON_SLOT } from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';

const MAX_ATTENTION_ATTEMPTS = 8;

export default function CalendarPendingEventScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const networkState = useNetworkState();
  const deviceOffline = useMemo(
    () => isDeviceOfflineForCalendar(networkState),
    [networkState?.isConnected, networkState?.type, networkState?.isInternetReachable]
  );
  const { localId } = useLocalSearchParams<{ localId?: string }>();
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState<PendingCalendarCreate | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { flexDirection: 'row', alignItems: 'center', padding: 12 , backgroundColor: colors.headerBackground },
        h1: { fontSize: 18, fontWeight: '700', color: colors.text, flex: 1 },
        body: { padding: 16, paddingBottom: 48 },
        banner: {
          padding: 12,
          borderRadius: 10,
          backgroundColor: `${colors.tint ?? '#007AFF'}22`,
          marginBottom: 16,
          borderWidth: 1,
          borderColor: colors.border,
        },
        bannerWarn: {
          padding: 12,
          borderRadius: 10,
          backgroundColor: '#f9731622',
          marginBottom: 16,
          borderWidth: 1,
          borderColor: colors.border,
        },
        bannerText: { color: colors.text, fontSize: 14, lineHeight: 20 },
        meta: { color: colors.textSecondary, fontSize: 14, marginBottom: 8 },
        err: { color: '#b91c1c', fontSize: 13, lineHeight: 18, marginBottom: 12 },
        btn: {
          backgroundColor: '#007AFF',
          padding: 14,
          borderRadius: 10,
          alignItems: 'center',
          marginTop: 12,
        },
        btnSecondary: {
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          padding: 14,
          borderRadius: 10,
          alignItems: 'center',
          marginTop: 12,
        },
        btnDanger: {
          backgroundColor: '#ef4444',
          padding: 14,
          borderRadius: 10,
          alignItems: 'center',
          marginTop: 12,
        },
        btnText: { color: '#fff', fontWeight: '600' },
        btnTextDark: { color: colors.text, fontWeight: '600' },
      }),
    [colors]
  );

  const reload = useCallback(async () => {
    if (!localId || typeof localId !== 'string') {
      setRow(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const r = await getPendingCalendarCreate(localId);
    setRow(r);
    setLoading(false);
  }, [localId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const payload = row?.body ?? null;

  const evLike = useMemo(
    () =>
      payload
        ? {
            start_time: payload.start_time as string | undefined,
            end_time: payload.end_time as string | undefined,
            location: payload.location,
          }
        : {},
    [payload]
  );

  const locationLabel = calendarDisplayLocation(payload?.location);

  const discard = () => {
    if (!localId) return;
    Alert.alert('Discard queued event?', 'This draft will be removed from your phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: async () => {
          setDiscardBusy(true);
          try {
            await removePendingCalendarCreate(localId);
            router.replace('/calendar' as any);
          } finally {
            setDiscardBusy(false);
          }
        },
      },
    ]);
  };

  const retrySync = async () => {
    if (!localId || !row) return;
    if (deviceOffline) {
      Alert.alert('Offline', 'Connect to the internet to retry sync.');
      return;
    }
    setSyncBusy(true);
    try {
      await resetPendingCalendarToQueued(localId);
      await reload();
      const fresh = await getPendingCalendarCreate(localId);
      if (!fresh) {
        router.replace('/calendar' as any);
        return;
      }
      const r = await flushPendingCalendarCreates(fresh.userId);
      await reload();
      if (r.synced > 0) {
        Alert.alert('Synced', 'This event was saved on the server.');
        router.replace('/calendar' as any);
      } else if (r.permanent > 0) {
        Alert.alert('Still failing', fresh.lastError || 'Check event details or discard and create again.');
      }
    } finally {
      setSyncBusy(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <AppBackButton />
        </View>
        <ActivityIndicator style={{ marginTop: 40 }} />
      </SafeAreaView>
    );
  }

  if (!payload || !row) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <AppBackButton />
          <AppHeaderTitle>Queued event</AppHeaderTitle>
        </View>
        <Text style={[styles.meta, { paddingHorizontal: 16 }]}>Not found — it may have already synced.</Text>
      </SafeAreaView>
    );
  }

  const needsAttention = row.status === 'failed_permanent' || (row.attemptCount ?? 0) >= MAX_ATTENTION_ATTEMPTS;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Queued event</AppHeaderTitle>
        <View style={{ width: APP_BACK_BUTTON_SLOT }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {needsAttention ? (
          <View style={styles.bannerWarn}>
            <Text style={styles.bannerText}>
              This item could not sync automatically (validation error or repeated failures). You can retry or discard.
            </Text>
          </View>
        ) : (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              Waiting to sync. Invitations and emails are sent after this event is successfully saved on the server when you are
              online.
            </Text>
          </View>
        )}

        {row.lastError ? <Text style={styles.err}>{row.lastError}</Text> : null}

        <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: 8 }}>
          {String(payload.title ?? 'Untitled')}
        </Text>
        <Text style={styles.meta}>{formatEventWhen(evLike as any)}</Text>
        {locationLabel ? (
          <Text
            style={[styles.meta, { color: colors.tint ?? '#007AFF' }]}
            selectable
            onPress={() => void openMapsForLocationLabel(locationLabel)}
            accessibilityRole="link"
            accessibilityLabel={`Map options for ${locationLabel}`}
          >
            📍 {locationLabel}
          </Text>
        ) : null}
        {payload.description ? (
          <LinkifiedText
            style={{ color: colors.text, marginTop: 12, fontSize: 14 }}
            linkColor={colors.primary || '#007AFF'}
          >
            {String(payload.description)}
          </LinkifiedText>
        ) : null}
        {payload.notes ? (
          <LinkifiedText
            style={{ color: colors.text, marginTop: 12, fontSize: 14 }}
            linkColor={colors.primary || '#007AFF'}
          >
            {`Event notes: ${String(payload.notes)}`}
          </LinkifiedText>
        ) : null}

        {needsAttention ? (
          <FeedbackTouchable
            style={styles.btn}
            onPress={retrySync}
            disabled={syncBusy || discardBusy}
            loading={syncBusy}
            spinnerColor="#fff"
          >
            <Text style={styles.btnText}>Retry sync</Text>
          </FeedbackTouchable>
        ) : null}

        <FeedbackTouchable
          style={styles.btnSecondary}
          onPress={reload}
          disabled={syncBusy || discardBusy}
          spinnerColor={colors.text}
        >
          <Text style={styles.btnTextDark}>Refresh status</Text>
        </FeedbackTouchable>

        <FeedbackTouchable
          style={styles.btnDanger}
          onPress={discard}
          disabled={syncBusy || discardBusy}
          loading={discardBusy}
          spinnerColor="#fff"
        >
          <Text style={styles.btnText}>Discard queued event</Text>
        </FeedbackTouchable>
      </ScrollView>
    </SafeAreaView>
  );
}
