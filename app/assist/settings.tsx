import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useNetworkState } from 'expo-network';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
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
  archiveCursorKindLabel,
  archiveCursorStatusLabel,
  archiveCursorStoppable,
  assistConnectionStatusPills,
  cancelAssistArchive,
  dedupeArchiveCursorsForDisplay,
  getArchiveProgress,
  getAssistScheduleSettings,
  getAssistStatus,
  groupArchiveCursorsByMailbox,
  resumeAssistArchive,
  saveAssistScheduleSettings,
  setupAssistCalls,
  startAssistTestCall,
  summarizeArchiveSync,
} from '../../services/assistApi';
import {
  createInboxAlias,
  emailSyncWorkspaceId,
  listInboxAliases,
  type EmailInboxAlias,
} from '../../services/emailSyncApi';
import { isNetworkError } from '../../utils/networkErrors';

const RESUMABLE_ARCHIVE = new Set(['paused_credits', 'paused_quota', 'cancelled', 'paused_disconnected']);

type ScheduleDraft = {
  schedulePolicy: 'auto_when_complete' | 'confirm_always';
  scheduleSms: boolean;
  scheduleEmail: boolean;
};

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
  const [savedSchedule, setSavedSchedule] = useState<ScheduleDraft>({
    schedulePolicy: 'auto_when_complete',
    scheduleSms: true,
    scheduleEmail: true,
  });
  const [scheduleCapture, setScheduleCapture] = useState<string | null>(null);
  const [scheduleOwnerPhone, setScheduleOwnerPhone] = useState<string | null>(null);
  const [schedulePhoneVerified, setSchedulePhoneVerified] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [schedulingAlias, setSchedulingAlias] = useState<EmailInboxAlias | null>(null);
  const [aliasBusy, setAliasBusy] = useState(false);

  const applyScheduleFromServer = useCallback((schedule: any, st?: any) => {
    if (schedule?.settings) {
      const policy =
        (schedule.settings.schedule_write_policy as 'auto_when_complete' | 'confirm_always') ||
        'auto_when_complete';
      const sms = schedule.settings.schedule_sms_enabled !== false;
      const email = schedule.settings.schedule_email_enabled !== false;
      setSchedulePolicy(policy);
      setScheduleSms(sms);
      setScheduleEmail(email);
      setSavedSchedule({ schedulePolicy: policy, scheduleSms: sms, scheduleEmail: email });
      setScheduleCapture(schedule.capture_number || st?.capture_number || null);
      setScheduleOwnerPhone(schedule.settings.schedule_owner_phone || null);
      setSchedulePhoneVerified(Boolean(schedule.settings.schedule_owner_phone_verified_at));
    } else {
      setScheduleCapture(st?.capture_number || null);
    }
  }, []);

  const loadSchedulingAlias = useCallback(async (assistWs?: number | null) => {
    try {
      const ids: number[] = [];
      try {
        const emailWs = await emailSyncWorkspaceId();
        if (Number.isFinite(emailWs)) ids.push(emailWs);
      } catch {
        // Fall through to the Assist workspace when the mailbox workspace is unavailable.
      }
      if (assistWs != null && Number.isFinite(assistWs) && !ids.includes(assistWs)) {
        ids.push(assistWs);
      }
      const lists = await Promise.all(ids.map((id) => listInboxAliases(id).catch(() => [] as EmailInboxAlias[])));
      const found =
        lists.flat().find((a) => a.purpose === 'scheduling' && a.is_active !== false) || null;
      setSchedulingAlias(found);
    } catch {
      // Alias list is optional; settings still works without it.
    }
  }, []);

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
      applyScheduleFromServer(schedule, st);
      const ws =
        schedule?.settings?.workspace_id ??
        st?.settings?.workspace_id ??
        st?.workspace?.id ??
        null;
      void loadSchedulingAlias(ws != null ? Number(ws) : null);
    } catch (e: any) {
      if (isNetworkError(e)) setOffline(true);
    }
  }, [applyScheduleFromServer, loadSchedulingAlias]);

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
  const connectionPills = assistConnectionStatusPills(cursors, setupCompleted);
  const mailboxGroups = groupArchiveCursorsByMailbox(cursors);

  const scheduleDirty = useMemo(
    () =>
      schedulePolicy !== savedSchedule.schedulePolicy ||
      scheduleSms !== savedSchedule.scheduleSms ||
      scheduleEmail !== savedSchedule.scheduleEmail,
    [schedulePolicy, scheduleSms, scheduleEmail, savedSchedule],
  );

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

  const discardScheduleDraft = () => {
    setSchedulePolicy(savedSchedule.schedulePolicy);
    setScheduleSms(savedSchedule.scheduleSms);
    setScheduleEmail(savedSchedule.scheduleEmail);
  };

  const createSchedulingAddress = async () => {
    setAliasBusy(true);
    try {
      const ws = await emailSyncWorkspaceId();
      const created = await createInboxAlias({
        workspace_id: ws,
        purpose: 'scheduling',
        display_name: 'Assist scheduling',
      });
      setSchedulingAlias(created);
      if (created?.alias_address) {
        await Clipboard.setStringAsync(created.alias_address);
        Alert.alert(
          'Scheduling address ready',
          `${created.alias_address}\n\nCopied. Forward appointment emails here from your verified account email.`,
        );
      }
    } catch (e: any) {
      Alert.alert(
        'Could not create address',
        e?.response?.data?.message || e?.response?.data?.error || 'Failed',
      );
    } finally {
      setAliasBusy(false);
    }
  };

  const ringDisplay = status?.verified_phone || status?.settings?.ring_number || null;
  const hasVerifiedPhone = Boolean(status?.has_verified_phone && ringDisplay);
  const captureNumber = status?.capture_number || null;
  const setupDisabled = offline && !setupCompleted;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Assist settings</AppHeaderTitle>
        <TouchableOpacity
          onPress={() => router.push('/assist/setup' as any)}
          disabled={setupDisabled}
          style={{ width: 40, alignItems: 'flex-end', padding: 8, opacity: setupDisabled ? 0.4 : 1 }}
          accessibilityLabel={
            !metaReady
              ? 'Loading setup'
              : setupCompleted
                ? 'Update or review setup'
                : offline
                  ? 'Setup unavailable offline'
                  : 'Finish Assist setup'
          }
        >
          <Ionicons name="create-outline" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      {scheduleDirty ? (
        <View
          style={{
            marginHorizontal: 16,
            marginBottom: 8,
            padding: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: '#FCD34D',
            backgroundColor: '#FFFBEB',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 13 }}>
              Unsaved schedule changes
            </Text>
            <Text style={{ color: '#92400E', fontSize: 12, marginTop: 2 }}>
              Save to apply SMS, email, and when-to-save settings.
            </Text>
          </View>
          <TouchableOpacity onPress={discardScheduleDraft} hitSlop={8}>
            <Text style={{ color: '#92400E', fontWeight: '600', fontSize: 13 }}>Discard</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() =>
              void saveAssistScheduleSettings({
                schedule_write_policy: schedulePolicy,
                schedule_sms_enabled: scheduleSms,
                schedule_email_enabled: scheduleEmail,
              })
                .then((res: any) => {
                  applyScheduleFromServer(res, status);
                  Alert.alert('Saved', 'Schedule settings updated.');
                })
                .catch((e: any) =>
                  Alert.alert(
                    'Save failed',
                    e?.response?.data?.message || e?.response?.data?.error || 'Failed',
                  ),
                )
            }
            hitSlop={8}
          >
            <Text style={{ color: '#0284C7', fontWeight: '700', fontSize: 13 }}>Save</Text>
          </TouchableOpacity>
        </View>
      ) : null}

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

        {!metaReady ? (
          <Text style={{ color: colors.textSecondary, marginBottom: 12 }}>Loading setup…</Text>
        ) : !setupCompleted ? (
          <TouchableOpacity
            style={styles.link}
            onPress={() => router.push('/assist/setup' as any)}
            disabled={offline}
          >
            <Text style={{ color: offline ? colors.textSecondary : '#0284C7', fontWeight: '700' }}>
              {offline ? 'Setup unavailable offline' : 'Finish Assist setup'}
            </Text>
          </TouchableOpacity>
        ) : null}

        {setupCompleted && connectionPills.length > 0 ? (
          <View
            style={{
              marginBottom: 12,
              padding: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: connectionPills.some((p) => p.tone === 'warn') ? '#FDE68A' : '#A7F3D0',
              backgroundColor: connectionPills.some((p) => p.tone === 'warn') ? '#FFFBEB' : '#ECFDF5',
            }}
          >
            <View style={styles.statusRow}>
              {connectionPills.map((p) => (
                <View key={p.key} style={styles.statusOn}>
                  <Ionicons
                    name={p.tone === 'ok' ? 'checkmark-circle' : 'warning'}
                    size={14}
                    color={p.tone === 'ok' ? '#16a34a' : '#D97706'}
                  />
                  <Text
                    style={[
                      styles.statusOnText,
                      p.tone === 'warn' ? { color: '#D97706' } : null,
                    ]}
                  >
                    {p.label}
                  </Text>
                </View>
              ))}
            </View>
            {syncSummary ? (
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 8 }}>
                {syncSummary}
              </Text>
            ) : (
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 8 }}>
                Mailbox is bound to Assist. Archive import and live sync run in the background.
              </Text>
            )}
          </View>
        ) : null}

        {mailboxGroups.length > 0 ? (
          <>
            <Text style={[styles.h, { color: colors.text }]}>Archive progress</Text>
            {mailboxGroups.map((group) => (
              <View key={group.label} style={{ marginBottom: 10 }}>
                <Text style={{ color: colors.text, fontWeight: '600', marginBottom: 4 }}>
                  {group.label}
                </Text>
                {group.cursors.map((c: any, i: number) => {
                  const imported = Number(c.messages_imported || 0);
                  const statusLabel = archiveCursorStatusLabel(c);
                  return (
                    <Text
                      key={c.id || `${group.label}-${i}`}
                      style={{ color: colors.textSecondary, marginBottom: 2, marginLeft: 4 }}
                    >
                      {archiveCursorKindLabel(c.cursor_kind)} · {statusLabel}
                      {imported > 0 || c.cursor_kind === 'backfill'
                        ? ` · ${imported} messages`
                        : ''}
                    </Text>
                  );
                })}
              </View>
            ))}
            {cursors.some((c: any) => archiveCursorStoppable(c)) ? (
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: '#64748B', marginTop: 8 }]}
                onPress={() =>
                  Alert.alert(
                    'Stop archive until resume?',
                    'Historical import and new-mail sync stop until you tap Resume. Mail already imported stays in Assist.',
                    [
                      { text: 'Keep running', style: 'cancel' },
                      {
                        text: 'Stop until resume',
                        style: 'destructive',
                        onPress: () =>
                          void cancelAssistArchive()
                            .then(() => getArchiveProgress().then(setProgress))
                            .catch(() => Alert.alert('Archive', 'Could not stop archive')),
                      },
                    ],
                  )
                }
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Stop archive until resume</Text>
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
            Text {scheduleCapture} from your verified account phone to schedule.
          </Text>
        ) : (
          <Text style={{ color: '#B45309', marginBottom: 8 }}>
            Capture number required for SMS scheduling.
          </Text>
        )}

        <Text style={{ color: colors.textSecondary, marginBottom: 4, fontSize: 13 }}>
          Scheduling email address
        </Text>
        {schedulingAlias?.alias_address ? (
          <View style={{ marginBottom: 10 }}>
            <Text style={{ color: colors.text, fontFamily: 'monospace', marginBottom: 6 }}>
              {schedulingAlias.alias_address}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 8 }}>
              Forward appointment emails here from your verified account email. Assist uses your note
              above the forward as the instruction.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: '#0369A1', paddingVertical: 8, paddingHorizontal: 12 }]}
                onPress={() =>
                  void Clipboard.setStringAsync(schedulingAlias.alias_address).then(() =>
                    Alert.alert('Copied', schedulingAlias.alias_address),
                  )
                }
              >
                <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Copy address</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: '#64748B', paddingVertical: 8, paddingHorizontal: 12 }]}
                onPress={() => router.push(`/email-sync/alias/${schedulingAlias.id}` as any)}
              >
                <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Open alias</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={{ marginBottom: 10 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 8 }}>
              Create a scheduling address to forward appointments for Assist. This is separate from
              document-import aliases.
            </Text>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: '#0369A1', paddingVertical: 8, paddingHorizontal: 12, opacity: aliasBusy ? 0.6 : 1 }]}
              disabled={aliasBusy || offline}
              onPress={() => void createSchedulingAddress()}
            >
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>
                {aliasBusy ? 'Creating…' : 'Create scheduling address'}
              </Text>
            </TouchableOpacity>
          </View>
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
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: '#64748B', paddingVertical: 8, paddingHorizontal: 12 }]}
            onPress={() =>
              Alert.alert(
                'Clear schedule phone?',
                'Turns off text scheduling until you restore your verified account phone. Email scheduling stays on.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Clear',
                    style: 'destructive',
                    onPress: () =>
                      void saveAssistScheduleSettings({ schedule_owner_phone: '' })
                        .then((res: any) => {
                          const saved = res?.settings || {};
                          setScheduleOwnerPhone(saved.schedule_owner_phone || null);
                          setSchedulePhoneVerified(Boolean(saved.schedule_owner_phone_verified_at));
                          const sms = saved.schedule_sms_enabled !== false;
                          setScheduleSms(sms);
                          setSavedSchedule((prev) => ({ ...prev, scheduleSms: sms }));
                          Alert.alert(
                            'Schedule phone cleared',
                            'SMS scheduling is off. Email scheduling is unchanged.',
                          );
                        })
                        .catch((e: any) =>
                          Alert.alert(
                            'Clear failed',
                            e?.response?.data?.message || e?.response?.data?.error || 'Failed',
                          ),
                        ),
                  },
                ],
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
                  const sms = saved.schedule_sms_enabled !== false;
                  setScheduleSms(sms);
                  setSavedSchedule((prev) => ({ ...prev, scheduleSms: sms }));
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

        <View style={[styles.rowBetween, { marginBottom: 10 }]}>
          <Text style={{ color: colors.text, flex: 1, paddingRight: 12 }}>SMS scheduling</Text>
          <Switch
            value={scheduleSms}
            onValueChange={setScheduleSms}
            trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
            ios_backgroundColor={colors.switchTrackOff}
            thumbColor={colors.switchThumbAndroid(scheduleSms)}
          />
        </View>
        <View style={[styles.rowBetween, { marginBottom: 12 }]}>
          <Text style={{ color: colors.text, flex: 1, paddingRight: 12 }}>Email scheduling</Text>
          <Switch
            value={scheduleEmail}
            onValueChange={setScheduleEmail}
            trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
            ios_backgroundColor={colors.switchTrackOff}
            thumbColor={colors.switchThumbAndroid(scheduleEmail)}
          />
        </View>

        <Text style={{ color: colors.textSecondary, marginBottom: 6, fontSize: 13 }}>
          When to save events
        </Text>
        <TouchableOpacity
          onPress={() =>
            setSchedulePolicy((p) =>
              p === 'auto_when_complete' ? 'confirm_always' : 'auto_when_complete',
            )
          }
          style={[
            styles.optionBtn,
            { borderColor: colors.border, backgroundColor: colors.background },
          ]}
        >
          <Text style={{ color: colors.text, fontWeight: '600', flex: 1 }}>
            {schedulePolicy === 'auto_when_complete' ? 'Create when complete' : 'Always confirm'}
          </Text>
          <Ionicons name="swap-horizontal" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 12, marginTop: 6 }}>
          {schedulePolicy === 'auto_when_complete'
            ? 'Saves the event as soon as the text or email has what it needs.'
            : 'Sends a summary and waits for you to reply YES before saving.'}
        </Text>

        <TouchableOpacity
          style={[
            styles.btn,
            { backgroundColor: scheduleDirty ? '#0369A1' : '#94A3B8', marginBottom: 16 },
          ]}
          disabled={!scheduleDirty}
          onPress={() =>
            void saveAssistScheduleSettings({
              schedule_write_policy: schedulePolicy,
              schedule_sms_enabled: scheduleSms,
              schedule_email_enabled: scheduleEmail,
            })
              .then((res: any) => {
                applyScheduleFromServer(res, status);
                Alert.alert('Saved', 'Schedule settings updated.');
              })
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
  statusRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  statusOn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusOnText: { fontSize: 12, fontWeight: '600', color: '#16a34a' },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
