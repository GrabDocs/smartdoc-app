import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  cancelAssistArchive,
  getArchiveProgress,
  getAssistScheduleSettings,
  getAssistStatus,
  resumeAssistArchive,
  saveAssistScheduleSettings,
  setupAssistCalls,
  startAssistTestCall,
} from '../../services/assistApi';

const CANCELABLE_ARCHIVE = new Set(['running', 'paused_quota', 'paused_credits', 'paused_disconnected']);
const RESUMABLE_ARCHIVE = new Set(['paused_credits', 'paused_quota', 'cancelled', 'paused_disconnected']);

type ForwardClient = 'iphone' | 'android' | 'carrier';

const FORWARD_STEPS: Record<ForwardClient, { title: string; steps: (capture: string) => string[] }> = {
  iphone: {
    title: 'iPhone',
    steps: (capture) => [
      'Open Settings → Phone → Call Forwarding.',
      'Turn Call Forwarding on.',
      `Enter ${capture} as the forward-to number.`,
      'Save. New calls to your personal number go to GrabDocs, then ring your eSIM.',
    ],
  },
  android: {
    title: 'Android',
    steps: (capture) => [
      'Open the Phone app → ⋮ → Settings → Calling accounts / Calls → Call forwarding.',
      'Choose Always forward (or your carrier’s unconditional forwarding).',
      `Enter ${capture}.`,
      'Confirm. Test by calling your personal number from another phone.',
    ],
  },
  carrier: {
    title: 'Carrier',
    steps: (capture) => [
      'Open your carrier app or account site (AT&T, T-Mobile, Verizon, etc.).',
      'Find Call Forwarding for your personal line.',
      `Set always forward to ${capture}.`,
      'Save. Keep 911 on your normal dialer — Assist is not an emergency service.',
    ],
  },
};

function CallsSetupGuide({ captureNumber }: { captureNumber: string | null }) {
  const [client, setClient] = useState<ForwardClient>('iphone');

  if (!captureNumber) {
    return (
      <View style={[styles.card, { backgroundColor: '#FFFBEB', borderColor: '#FDE68A' }]}>
        <Text style={{ color: '#92400E', fontSize: 13 }}>
          Waiting for an admin to assign your GrabDocs capture number. After that, this section shows
          the number to forward to and eSIM setup steps.
        </Text>
      </View>
    );
  }

  const guide = FORWARD_STEPS[client];

  return (
    <View style={{ gap: 10 }}>
      <View style={[styles.card, { backgroundColor: '#F0F9FF', borderColor: '#BAE6FD' }]}>
        <Text style={{ color: '#0C4A6E', fontWeight: '700', fontSize: 13, marginBottom: 4 }}>
          Your GrabDocs capture number
        </Text>
        <Text style={{ color: '#082F49', fontFamily: 'monospace', fontSize: 18, fontWeight: '700' }}>
          {captureNumber}
        </Text>
        <Text style={{ color: '#075985', fontSize: 12, marginTop: 8 }}>
          Forward your personal number to this address. Do not enter this as your eSIM ring number.
        </Text>
        <TouchableOpacity
          style={[styles.btn, { marginTop: 10, marginBottom: 0 }]}
          onPress={async () => {
            await Clipboard.setStringAsync(captureNumber);
            Alert.alert('Copied', captureNumber);
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Copy number</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.card, { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' }]}>
        <Text style={{ color: '#1E3A8A', fontWeight: '700', fontSize: 13, marginBottom: 6 }}>
          Ring number = verified phone
        </Text>
        {[
          'Assist rings your account verified phone (managed in Settings).',
          'If you use an eSIM as that line, confirm it rings when dialed.',
          'Change the number only in Settings → Profile → Phone.',
          'Then return here to finish forwarding and Save Calls setup.',
        ].map((step, i) => (
          <Text key={i} style={{ color: '#1E40AF', fontSize: 12, marginBottom: 4 }}>
            {i + 1}. {step}
          </Text>
        ))}
      </View>

      <View style={[styles.card, { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' }]}>
        <Text style={{ color: '#1E3A8A', fontWeight: '700', fontSize: 13, marginBottom: 8 }}>
          Forward your personal number — {guide.title}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {(['iphone', 'android', 'carrier'] as const).map((c) => {
            const on = client === c;
            return (
              <TouchableOpacity
                key={c}
                onPress={() => setClient(c)}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 999,
                  backgroundColor: on ? '#2563EB' : '#DBEAFE',
                }}
              >
                <Text style={{ color: on ? '#fff' : '#1D4ED8', fontSize: 12, fontWeight: '600' }}>
                  {c === 'iphone' ? 'iPhone' : c === 'android' ? 'Android' : 'Carrier'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {guide.steps(captureNumber).map((step, i) => (
          <Text key={i} style={{ color: '#1E40AF', fontSize: 12, marginBottom: 4 }}>
            {i + 1}. {step}
          </Text>
        ))}
        <Text style={{ color: '#1D4ED8', fontSize: 12, marginTop: 8 }}>
          Callers hear: “This call may be recorded by GrabDocs Assist for the account holder.” Hang up
          to decline.
        </Text>
      </View>
    </View>
  );
}

export default function AssistSettingsScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const [status, setStatus] = useState<any>(null);
  const [progress, setProgress] = useState<any>(null);

  const [schedulePolicy, setSchedulePolicy] = useState<'auto_when_complete' | 'confirm_always'>(
    'auto_when_complete',
  );
  const [scheduleSms, setScheduleSms] = useState(true);
  const [scheduleEmail, setScheduleEmail] = useState(true);
  const [scheduleCapture, setScheduleCapture] = useState<string | null>(null);
  const [scheduleOwnerPhone, setScheduleOwnerPhone] = useState<string | null>(null);
  const [schedulePhoneVerified, setSchedulePhoneVerified] = useState(false);
  const [schedulePhoneDraft, setSchedulePhoneDraft] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [st, prog, schedule] = await Promise.all([
          getAssistStatus(),
          getArchiveProgress(),
          getAssistScheduleSettings().catch(() => null),
        ]);
        setStatus(st);
        setProgress(prog);
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
      } catch {
        /* ignore */
      }
    })();
  }, []);

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
        <TouchableOpacity style={styles.link} onPress={() => router.push('/assist/setup' as any)}>
          <Text style={{ color: '#0284C7', fontWeight: '700' }}>
            {status?.setup_completed ? 'Re-run / review setup' : 'Finish Assist setup'}
          </Text>
        </TouchableOpacity>

        {(progress?.cursors || []).length > 0 ? (
          <>
            <Text style={[styles.h, { color: colors.text }]}>Archive progress</Text>
            {(progress?.cursors || []).map((c: any, i: number) => (
              <Text key={i} style={{ color: colors.textSecondary, marginBottom: 4 }}>
                {c.cursor_kind}: {c.status} · imported {c.messages_imported}
              </Text>
            ))}
            {(progress?.cursors || []).some((c: any) => CANCELABLE_ARCHIVE.has(c.status)) ? (
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
            {(progress?.cursors || []).some((c: any) => RESUMABLE_ARCHIVE.has(c.status)) ? (
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
        <Text style={{ color: colors.textSecondary, marginBottom: 8 }}>
          Schedule phone:{' '}
          {scheduleOwnerPhone && schedulePhoneVerified
            ? scheduleOwnerPhone
            : 'Uses your verified account phone from Settings.'}
        </Text>
        <TextInput
          value={schedulePhoneDraft}
          onChangeText={setSchedulePhoneDraft}
          placeholder="+1 415 555 0100"
          placeholderTextColor={colors.textSecondary}
          keyboardType="phone-pad"
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
            padding: 10,
            color: colors.text,
            marginBottom: 8,
          }}
        />
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: '#0F766E', marginBottom: 8 }]}
          onPress={() =>
            void saveAssistScheduleSettings({ schedule_owner_phone: schedulePhoneDraft.trim() })
              .then((res: any) => {
                const saved = res?.settings || {};
                setScheduleOwnerPhone(saved.schedule_owner_phone || null);
                setSchedulePhoneVerified(Boolean(saved.schedule_owner_phone_verified_at));
                setScheduleSms(saved.schedule_sms_enabled !== false);
                setSchedulePhoneDraft('');
                Alert.alert('Schedule phone', 'Saved.');
              })
              .catch((e: any) =>
                Alert.alert(
                  'Schedule phone',
                  e?.response?.data?.message ||
                    e?.response?.data?.error ||
                    'Verify that number with a code first',
                ),
              )
          }
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Save schedule phone</Text>
        </TouchableOpacity>
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
            <Text style={[styles.h, { color: colors.text }]}>Calls setup</Text>
            <CallsSetupGuide captureNumber={captureNumber} />
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
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
});
