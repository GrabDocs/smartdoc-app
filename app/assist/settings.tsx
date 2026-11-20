import { Ionicons } from '@expo/vector-icons';
import { useNetworkState } from 'expo-network';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import CallsSetupGuide from '../../components/assist/CallsSetupGuide';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  archiveCursorsActive,
  archiveCursorsResumable,
  cancelAssistArchive,
  dedupeArchiveCursorsForDisplay,
  formatArchiveCursorLine,
  getArchiveProgress,
  getAssistScheduleSettings,
  getAssistStatus,
  resumeAssistArchive,
  saveAssistScheduleSettings,
  setupAssistCalls,
  startAssistTestCall,
  summarizeArchiveSync,
} from '../../services/assistApi';
import { isNetworkError } from '../../utils/networkErrors';

const CANCELABLE_ARCHIVE = new Set(['running', 'paused_quota', 'paused_credits', 'paused_disconnected']);
const RESUMABLE_ARCHIVE = new Set(['paused_credits', 'paused_quota', 'cancelled', 'paused_disconnected']);

export default function AssistSettingsScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const network = useNetworkState();
  const [status, setStatus] = useState<any>(null);
  const [progress, setProgress] = useState<any>(null);
  const [offline, setOffline] = useState(false);
  const [metaReady, setMetaReady] = useState(false);

  const [schedulePolicy, setSchedulePolicy] = useState<'auto_when_complete' | 'confirm_always'>(
    'auto_when_complete',
  );
  const [scheduleSms, setScheduleSms] = useState(true);
  const [scheduleEmail, setScheduleEmail] = useState(true);
  const [scheduleCapture, setScheduleCapture] = useState<string | null>(null);
  const [scheduleOwnerPhone, setScheduleOwnerPhone] = useState<string | null>(null);
  const [schedulePhoneVerified, setSchedulePhoneVerified] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  const loadSettings = useCallback(async () => {
    // Light status first so setup_completed survives flaky/offline detail fetches.
    try {
      const light = await getAssistStatus(undefined, { light: true });
      setStatus((prev: any) => ({ ...(prev || {}), ...light }));
      setOffline(false);
    } catch (e: any) {
      if (isNetworkError(e)) setOffline(true);
    } finally {
      setMetaReady(true);
    }

    try {
      const [st, prog, schedule] = await Promise.all([
        getAssistStatus(),
        getArchiveProgress().catch(() => null),
        getAssistScheduleSettings().catch(() => null),
      ]);
      setStatus(st);
      if (prog) setProgress(prog);
      setOffline(false);
      if (schedule?.settings) {
        setSchedulePolicy(
          (schedule.settings.schedule_write_policy as 'auto_when_complete' | 'confirm_always') ||
            'auto_when_complete',
        );
        setScheduleSms(schedule.settings.schedule_sms_enabled !== false);
        setScheduleEmail(schedule.settings.schedule_email_enabled !== false);
        setScheduleCapture(schedule.capture_number || st?.capture_number || null);
        setScheduleOwnerPhone(schedule.settings.schedule_owner_phone || null);
        setSchedulePhoneVerified(Boolean(schedule.settings.schedule_owner_phone_verified_at));
      } else {
        setScheduleCapture(st?.capture_number || null);
      }
    } catch (e: any) {
      if (isNetworkError(e)) setOffline(true);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Refresh when connectivity returns without requiring a screen reopen.
  useEffect(() => {
    if (network.isConnected === true && offline) {
      void loadSettings();
    }
  }, [network.isConnected, offline, loadSettings]);

  const setupCompleted = Boolean(status?.setup_completed);
  const cursors = dedupeArchiveCursorsForDisplay(progress?.cursors || status?.cursors || []);
  const syncActive = archiveCursorsActive(cursors);
  const syncResumable = archiveCursorsResumable(cursors);
  const syncSummary = summarizeArchiveSync(cursors);

  useEffect(() => {
    if (!setupCompleted || (!syncActive && !syncResumable)) return undefined;
    const timer = setInterval(() => {
      void getArchiveProgress()
        .then(setProgress)
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [setupCompleted, syncActive, syncResumable]);

  const saveCalls = async () => {
    try {
      await setupAssistCalls({ forwarding_configured: true });
      Alert.alert(
        'Calls setup saved',
        'Forward your personal number to the GrabDocs capture number, then place a test call. Call 911 from your normal dialer — Assist is not an emergency service.',
      );
      setStatus(await getAssistStatus());
    } catch (e: any) {
      Alert.alert(
        'Calls setup failed',
        e?.response?.data?.message || e?.response?.data?.error || 'Failed',
      );
    }
  };

  const ringDisplay = status?.verified_phone || status?.settings?.ring_number || null;
  const hasVerifiedPhone = Boolean(status?.has_verified_phone && ringDisplay);

  const captureNumber = status?.capture_number || null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Assist settings</AppHeaderTitle>
        <View style={{ width: 40 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {offline ? (
          <View
            style={{
              marginBottom: 12,
              padding: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: '#FCD34D',
              backgroundColor: '#FFFBEB',
            }}
          >
            <Text style={{ color: '#92400E', fontWeight: '700', marginBottom: 4 }}>You’re offline</Text>
            <Text style={{ color: '#92400E', fontSize: 13 }}>
              {setupCompleted
                ? 'Showing the last known Assist setup. Archive progress may be out of date until you reconnect.'
                : 'Connect to the internet to load Assist settings.'}
            </Text>
            <TouchableOpacity style={{ marginTop: 8 }} onPress={() => void loadSettings()}>
              <Text style={{ color: '#0284C7', fontWeight: '700' }}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <TouchableOpacity
          style={styles.link}
          onPress={() => router.push('/assist/setup' as any)}
          disabled={offline && !setupCompleted}
        >
          <Text style={{ color: '#0284C7', fontWeight: '700' }}>
            {!metaReady
              ? 'Loading setup…'
              : setupCompleted
                ? 'Update / review setup'
                : offline
                  ? 'Setup unavailable offline'
                  : 'Finish Assist setup'}
          </Text>
        </TouchableOpacity>

        {setupCompleted ? (
          <View
            style={{
              marginBottom: 12,
              padding: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: syncActive ? '#BAE6FD' : '#A7F3D0',
              backgroundColor: syncActive ? '#F0F9FF' : '#ECFDF5',
            }}
          >
            <Text style={{ color: colors.text, fontWeight: '700', marginBottom: 4 }}>
              {syncActive ? 'Connected · syncing' : 'Connected'}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              {syncSummary ||
                'Mailbox is bound to Assist. Archive import and live sync run in the background.'}
            </Text>
          </View>
        ) : null}

        {cursors.length > 0 ? (
          <>
            <Text style={[styles.h, { color: colors.text }]}>Archive progress</Text>
            {cursors.map((c: any, i: number) => (
              <Text key={c.id || i} style={{ color: colors.textSecondary, marginBottom: 4 }}>
                {formatArchiveCursorLine(c)}
              </Text>
            ))}
            {cursors.some((c: any) => CANCELABLE_ARCHIVE.has(c.status)) ? (
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: '#64748B', marginTop: 8 }]}
                onPress={() =>
                  void cancelAssistArchive()
                    .then(() => getArchiveProgress().then(setProgress))
                    .catch(() => Alert.alert('Archive', 'Could not cancel'))
                }
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Cancel archive</Text>
              </TouchableOpacity>
            ) : null}
            {cursors.some((c: any) => RESUMABLE_ARCHIVE.has(c.status)) ? (
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: '#0369A1', marginTop: 8 }]}
                onPress={() =>
                  void resumeAssistArchive()
                    .then(() => getArchiveProgress().then(setProgress))
                    .then(() => Alert.alert('Archive', 'Resume requested.'))
                    .catch(() => Alert.alert('Archive', 'Could not resume'))
                }
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Resume archive</Text>
              </TouchableOpacity>
            ) : null}
          </>
        ) : null}

        <Text style={[styles.h, { color: colors.text }]}>Schedule by text / email</Text>
        {scheduleCapture ? (
          <Text style={{ color: colors.textSecondary, marginBottom: 8 }}>
            Text {scheduleCapture} to schedule. Forward appointments to a scheduling email alias.
          </Text>
        ) : (
          <Text style={{ color: '#B45309', marginBottom: 8 }}>
            Capture number required for SMS scheduling.
          </Text>
        )}
        <Text style={{ color: colors.textSecondary, marginBottom: 4 }}>
          Only your verified account phone can text Assist to schedule. Change that number in Settings
          → Profile → Phone.
        </Text>
        <Text style={{ color: colors.text, marginBottom: 8, fontFamily: 'monospace' }}>
          {scheduleOwnerPhone && schedulePhoneVerified
            ? scheduleOwnerPhone
            : 'No verified schedule phone yet'}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: '#64748B', paddingVertical: 8, paddingHorizontal: 12 }]}
            onPress={() =>
              void saveAssistScheduleSettings({ schedule_owner_phone: '' })
                .then((res: any) => {
                  const saved = res?.settings || {};
                  setScheduleOwnerPhone(saved.schedule_owner_phone || null);
                  setSchedulePhoneVerified(Boolean(saved.schedule_owner_phone_verified_at));
                  setScheduleSms(saved.schedule_sms_enabled !== false);
                  Alert.alert('Schedule phone', 'Cleared. SMS scheduling turned off.');
                })
                .catch((e: any) =>
                  Alert.alert(
                    'Clear failed',
                    e?.response?.data?.message || e?.response?.data?.error || 'Failed',
                  ),
                )
            }
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Clear schedule phone</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: '#0369A1', paddingVertical: 8, paddingHorizontal: 12 }]}
            onPress={() =>
              void saveAssistScheduleSettings({ schedule_sms_enabled: true })
                .then((res: any) => {
                  const saved = res?.settings || {};
                  setScheduleOwnerPhone(saved.schedule_owner_phone || null);
                  setSchedulePhoneVerified(Boolean(saved.schedule_owner_phone_verified_at));
                  setScheduleSms(saved.schedule_sms_enabled !== false);
                  Alert.alert('Schedule phone', 'Restored verified account phone for SMS.');
                })
                .catch((e: any) =>
                  Alert.alert(
                    'Restore failed',
                    e?.response?.data?.message ||
                      e?.response?.data?.error ||
                      'Verify your account phone in Settings first',
                  ),
                )
            }
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Use verified account phone</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={() => setScheduleSms((v) => !v)}
          style={{ marginBottom: 6 }}
        >
          <Text style={{ color: colors.text }}>
            SMS scheduling: {scheduleSms ? 'On' : 'Off'} (tap to toggle)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setScheduleEmail((v) => !v)}
          style={{ marginBottom: 6 }}
        >
          <Text style={{ color: colors.text }}>
            Email scheduling: {scheduleEmail ? 'On' : 'Off'} (tap to toggle)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() =>
            setSchedulePolicy((p) =>
              p === 'auto_when_complete' ? 'confirm_always' : 'auto_when_complete',
            )
          }
          style={{ marginBottom: 8 }}
        >
          <Text style={{ color: colors.text }}>
            Write policy:{' '}
            {schedulePolicy === 'auto_when_complete' ? 'Create when complete' : 'Always confirm'}{' '}
            (tap to switch)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: '#0369A1', marginBottom: 16 }]}
          onPress={() =>
            void saveAssistScheduleSettings({
              schedule_write_policy: schedulePolicy,
              schedule_sms_enabled: scheduleSms,
              schedule_email_enabled: scheduleEmail,
            })
              .then(() => Alert.alert('Saved', 'Schedule settings updated.'))
              .catch((e: any) =>
                Alert.alert(
                  'Save failed',
                  e?.response?.data?.message || e?.response?.data?.error || 'Failed',
                ),
              )
          }
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Save schedule settings</Text>
        </TouchableOpacity>

        {status?.calls_enabled ? (
          <>
            <View
              style={{
                marginTop: 18,
                marginBottom: 6,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <Text style={[styles.h, { color: colors.text, marginTop: 0, marginBottom: 0 }]}>
                Calls setup
              </Text>
              <TouchableOpacity onPress={() => setSetupOpen(true)}>
                <Text style={{ color: '#0284C7', fontWeight: '700' }}>Setup instructions</Text>
              </TouchableOpacity>
            </View>
            {captureNumber ? (
              <>
                <View style={{ marginTop: 12, marginBottom: 8 }}>
                  <Text style={[styles.h, { color: colors.text, marginTop: 0, marginBottom: 2 }]}>
                    Ring number
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 11, marginBottom: 6 }}>
                    Uses your verified phone from Settings
                  </Text>
                  {hasVerifiedPhone ? (
                    <Text style={{ color: colors.text, fontFamily: 'monospace', fontSize: 14 }}>
                      {ringDisplay}
                    </Text>
                  ) : (
                    <Text style={{ color: '#B45309', fontSize: 13 }}>No verified phone yet.</Text>
                  )}
                  <TouchableOpacity
                    onPress={() =>
                      router.push({
                        pathname: '/(tabs)/settings',
                        params: { openPhone: '1', section: 'profile' },
                      } as any)
                    }
                    style={{ marginTop: 8 }}
                  >
                    <Text style={{ color: '#0284C7', fontWeight: '700' }}>Change in Settings →</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  style={[styles.btn, !hasVerifiedPhone ? { opacity: 0.5 } : null]}
                  disabled={!hasVerifiedPhone}
                  onPress={() => void saveCalls()}
                >
                  <Text style={{ color: '#fff', fontWeight: '700' }}>Save Calls setup</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, { backgroundColor: '#0369A1', marginTop: 8 }]}
                  onPress={() =>
                    void startAssistTestCall()
                      .then(() =>
                        Alert.alert(
                          'Test call',
                          'GrabDocs is calling your ring number. Calls stays Needs attention until that call completes.',
                        ),
                      )
                      .catch((e) =>
                        Alert.alert('Test call', e?.response?.data?.reason || 'Could not place the test call'),
                      )
                  }
                >
                  <Text style={{ color: '#fff', fontWeight: '700' }}>Re-test ring path</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </>
        ) : null}

        <Text style={[styles.h, { color: colors.text }]}>Retention</Text>
        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
          Disconnecting the mailbox stops sync for Email Replies and Assist but keeps previously archived
          Assist mail. Account deletion removes Assist-owned data via a cleanup job; linked independent
          Files are left alone.
        </Text>
      </ScrollView>

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
            <CallsSetupGuide captureNumber={captureNumber} />
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
  h: { fontWeight: '700', marginTop: 18, marginBottom: 6 },
  link: { marginBottom: 8 },
  input: { borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 8 },
  btn: {
    backgroundColor: '#0284C7',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
});
