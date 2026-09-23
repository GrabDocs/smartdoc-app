import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useNetworkState } from 'expo-network';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import MinimizableBottomSheet from '../../components/MinimizableBottomSheet';
import LinkifiedMultilineInput from '../../components/LinkifiedMultilineInput';
import { calendarIsCompanyAdmin, useCalendarProfile } from '../../hooks/useCalendarProfile';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  calendarCategoriesWithRecords,
  calendarCreateEvent,
  calendarSearchCompanyMembers,
  calendarSyncGoogleWithStaleConnectionRecovery,
  scheduleReachMeeting,
} from '../../services/calendarApi';
import { invalidateCalendarListCache, isCalendarFetchOfflineError } from '../../utils/calendarCache';
import { isDeviceOfflineForCalendar } from '../../utils/calendarOffline';
import { enqueuePendingCalendarCreate } from '@/utils/calendarPendingCreates';
import {
  combineLocalDateAndTimeStrings,
  convertLocalTimeToUTC,
  formatLocalTime12h,
  getDeviceIanaTimezone,
  toLocalDateString,
} from '../../utils/calendarTime';

import AppBackButton, { APP_BACK_BUTTON_SLOT } from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import EventRemindersEditor from '../../components/calendar/EventRemindersEditor';
import { DEFAULT_REMINDERS, type CalendarReminder } from '../../utils/calendarReminders';

type Participant = { email: string; name: string; type: string };

/** End time = start + duration; presets aligned with web-style dropdown */
const DURATION_PRESETS: { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 45, label: '45 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 90, label: '1.5 hours' },
  { minutes: 120, label: '2 hours' },
  { minutes: 180, label: '3 hours' },
  { minutes: 240, label: '4 hours' },
  { minutes: 480, label: '8 hours' },
];

function paramString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Accept YYYY-MM-DD from calendar selection; otherwise today. */
function initialEventDateFromParam(raw?: string): string {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (!Number.isNaN(dt.getTime()) && toLocalDateString(dt) === raw) return raw;
  }
  return toLocalDateString(new Date());
}

export default function CalendarCreateScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const params = useLocalSearchParams<{ viewUserId?: string; date?: string }>();
  const { profile, refresh } = useCalendarProfile();
  const networkState = useNetworkState();
  const isAdmin = calendarIsCompanyAdmin(profile);
  const isPersonalAccount = useMemo(() => (profile?.company_id ?? 0) === 0, [profile?.company_id]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [notesField, setNotesField] = useState('');
  const [location, setLocation] = useState('');
  const [meetingUrlManual, setMeetingUrlManual] = useState('');
  const [useReach, setUseReach] = useState(false);
  const [eventType, setEventType] = useState<'personal' | 'company'>('personal');
  const [assignedMemberId, setAssignedMemberId] = useState<number | null>(
    params.viewUserId ? Number(params.viewUserId) : null
  );
  const [memberQuery, setMemberQuery] = useState('');
  const [memberHits, setMemberHits] = useState<any[]>([]);
  const [memberModal, setMemberModal] = useState(false);
  const [selectedMemberLabel, setSelectedMemberLabel] = useState('');

  const [categories, setCategories] = useState<any[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [recordId, setRecordId] = useState<number | null>(null);
  const [categoryModal, setCategoryModal] = useState(false);

  const tz = useMemo(() => getDeviceIanaTimezone(), []);
  const [eventDate, setEventDate] = useState(() => initialEventDateFromParam(paramString(params.date)));
  const [eventTime, setEventTime] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return formatLocalTime12h(d);
  });
  const [durationMin, setDurationMin] = useState(60);

  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFreq, setRecurringFreq] = useState('WEEKLY');
  const [recurringCount, setRecurringCount] = useState(10);

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');

  const [additionalExpanded, setAdditionalExpanded] = useState(false);
  const [reminders, setReminders] = useState<CalendarReminder[]>(DEFAULT_REMINDERS);

  const [showPicker, setShowPicker] = useState<'date' | 'time' | null>(null);
  const [durationPickerOpen, setDurationPickerOpen] = useState(false);
  const [datePickerExpandNonce, setDatePickerExpandNonce] = useState(0);
  const [timePickerExpandNonce, setTimePickerExpandNonce] = useState(0);
  const [durationPickerExpandNonce, setDurationPickerExpandNonce] = useState(0);
  const [memberPickerExpandNonce, setMemberPickerExpandNonce] = useState(0);

  const [submitting, setSubmitting] = useState(false);

  const durationLabel = useMemo(() => {
    const preset = DURATION_PRESETS.find((p) => p.minutes === durationMin);
    return preset?.label ?? `${durationMin} minutes`;
  }, [durationMin]);

  const dismissFormOverlays = useCallback(() => {
    Keyboard.dismiss();
    setShowPicker(null);
    setDurationPickerOpen(false);
  }, []);

  const openDatePicker = useCallback(() => {
    setDurationPickerOpen(false);
    setMemberModal(false);
    setShowPicker('date');
    setDatePickerExpandNonce((n) => n + 1);
  }, []);

  const openTimePicker = useCallback(() => {
    setDurationPickerOpen(false);
    setMemberModal(false);
    setShowPicker('time');
    setTimePickerExpandNonce((n) => n + 1);
  }, []);

  const openDurationPicker = useCallback(() => {
    setShowPicker(null);
    setMemberModal(false);
    setDurationPickerOpen(true);
    setDurationPickerExpandNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      if (!isDeviceOfflineForCalendar(networkState)) {
        calendarSyncGoogleWithStaleConnectionRecovery().catch(() => {});
      }
    }, [networkState?.isConnected, networkState?.type, networkState?.isInternetReachable])
  );

  useEffect(() => {
    if (isPersonalAccount) {
      setEventType('personal');
    }
  }, [isPersonalAccount]);

  useEffect(() => {
    if (eventType !== 'company' || !isAdmin) {
      setCategories([]);
      setCategoryId(null);
      setRecordId(null);
      return;
    }
    calendarCategoriesWithRecords().then(setCategories).catch(() => setCategories([]));
  }, [eventType, isAdmin]);

  useEffect(() => {
    if (!memberModal || memberQuery.trim().length < 1) {
      setMemberHits([]);
      return;
    }
    const t = setTimeout(() => {
      calendarSearchCompanyMembers(memberQuery, 12).then(setMemberHits).catch(() => setMemberHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [memberQuery, memberModal]);

  const buildRRule = () => {
    if (!isRecurring) return undefined;
    let r = `FREQ=${recurringFreq}`;
    if (recurringCount > 0) r += `;COUNT=${recurringCount}`;
    return r;
  };

  const additionalConfiguredCount = useMemo(() => {
    let n = participants.length;
    if (isRecurring) n += 1;
    if (reminders.length > 0) n += 1;
    if (description.trim().length > 0) n += 1;
    if (notesField.trim().length > 0) n += 1;
    return n;
  }, [participants.length, isRecurring, reminders.length, description, notesField]);

  const addParticipant = () => {
    const email = newEmail.trim();
    if (!email) {
      Alert.alert('Participant', 'Enter an email');
      return;
    }
    setParticipants((p) => [
      ...p,
      { email, name: newName.trim() || email, type: 'required' },
    ]);
    setNewEmail('');
    setNewName('');
  };

  const getPickerDateTime = (dateStr: string, timeStr: string): Date => combineLocalDateAndTimeStrings(dateStr, timeStr);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { flexDirection: 'row', alignItems: 'center', padding: 12 , backgroundColor: colors.headerBackground },
        h1: { fontSize: 20, fontWeight: '700', color: colors.text, flex: 1 },
        body: { padding: 16, paddingBottom: 120 },
        label: { fontWeight: '600', color: colors.text, marginTop: 12 },
        input: {
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
          padding: 10,
          marginTop: 6,
          color: colors.text,
          backgroundColor: colors.surface,
        },
        chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
        chip: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 16,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.isDark ? colors.border : '#b8bec4',
        },
        chipOn: {
          borderWidth: 1,
          borderColor: colors.tint,
          backgroundColor: colors.isDark ? 'rgba(59,130,246,0.24)' : colors.primaryLight,
        },
        additionalSection: {
          marginTop: 16,
          borderRadius: 12,
          borderWidth: 1,
          overflow: 'hidden',
          backgroundColor: colors.surface,
          borderColor: colors.border,
        },
        additionalHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          paddingVertical: 14,
        },
        additionalBody: {
          paddingHorizontal: 14,
          paddingBottom: 16,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
        },
        btn: {
          backgroundColor: colors.tint,
          padding: 14,
          borderRadius: 10,
          marginTop: 20,
          alignItems: 'center',
        },
        btnText: { color: '#fff', fontWeight: '600' },
      }),
    [colors]
  );

  const iosPickerTheme = colors.isDark ? 'dark' : 'light';

  const submit = useCallback(async () => {
    const t = title.trim();
    if (!t) {
      Alert.alert('Title required', '');
      return;
    }
    if (t.length > 50) {
      Alert.alert('Title', 'Max 50 characters');
      return;
    }
    if (eventType === 'company' && !assignedMemberId) {
      Alert.alert('Company event', 'Select an assigned member');
      return;
    }
    if (newEmail.trim().length > 0) {
      Alert.alert(
        'Participant not added',
        'Tap "+ Add participant" to save this guest before saving the event. Or clear the email field.'
      );
      return;
    }
    if (newName.trim().length > 0) {
      Alert.alert(
        'Participant not added',
        'Enter an email and tap "+ Add participant", or clear the name field.'
      );
      return;
    }

    let startUtc: Date;
    try {
      startUtc = convertLocalTimeToUTC(eventDate, eventTime, tz);
    } catch {
      Alert.alert('Time', 'Enter a valid start time (for example 5:00 PM).');
      return;
    }
    const endUtc = new Date(startUtc.getTime() + Math.max(1, durationMin) * 60 * 1000);

    setSubmitting(true);
    try {
      const deviceOffline = isDeviceOfflineForCalendar(networkState);
      let videoMeetingUrl = meetingUrlManual.trim() || undefined;
      let videoCallId: string | number | undefined = undefined;
      let loc = location.trim();

      if (useReach && deviceOffline) {
        Alert.alert('Offline', 'Reach video meetings require an internet connection.');
        setSubmitting(false);
        return;
      }

      if (useReach) {
        try {
          const durationMinutes = Math.max(1, Math.ceil((endUtc.getTime() - startUtc.getTime()) / 60000));
          const videoMeetingData: Record<string, unknown> = {
            room_name: t,
            description: description.trim() || 'Reach Video Meeting',
            scheduled_time: startUtc.toISOString(),
            duration_minutes: durationMinutes,
            max_participants: 10,
            enable_recording: false,
            enable_transcription: false,
            passcode_required: false,
            invitees: participants.map((p) => p.email),
            from_reach_page: true,
          };
          const videoResponse = await scheduleReachMeeting(videoMeetingData);
          const room = videoResponse.room || (videoResponse.room_id ? { id: videoResponse.room_id, meeting_id: videoResponse.meeting_id } : null);
          if (room) {
            const mid = room.meeting_id ?? room.id;
            videoCallId = room.id;
            videoMeetingUrl = `https://grabdocs.com/join-meeting?meeting_id=${mid}`;
            if (!loc.includes('Reach')) loc = loc ? `${loc}, Reach` : 'Reach';
          }
          if (videoResponse.calendar_event_id) {
            videoCallId = 'skip-calendar-creation';
          }
        } catch (e: any) {
          const msg = e?.response?.data?.error || e?.message || 'Reach meeting failed';
          Alert.alert('Reach', msg);
          setSubmitting(false);
          return;
        }
      }

      if (!useReach || !videoCallId) {
        const eventData: Record<string, unknown> = {
          title: t,
          description: description.trim(),
          notes: notesField.trim() || undefined,
          start_time: startUtc.toISOString(),
          end_time: endUtc.toISOString(),
          timezone: tz,
          location: loc || undefined,
          meeting_url: videoMeetingUrl,
          participants,
          reminders,
          reminder_minutes: reminders.map((r) => r.minutes),
          rrule: buildRRule(),
          event_type: eventType,
          assigned_user_id: eventType === 'company' ? assignedMemberId : undefined,
          linked_category_id: categoryId ?? undefined,
          linked_category_record_id: recordId ?? undefined,
        };
        if (typeof videoCallId === 'number') {
          eventData.video_call_id = videoCallId;
        }
        if (categoryId != null && recordId == null) {
          Alert.alert('Category', 'Select both category and record, or neither');
          setSubmitting(false);
          return;
        }
        if (categoryId == null && recordId != null) {
          Alert.alert('Category', 'Select both category and record, or neither');
          setSubmitting(false);
          return;
        }

        if (deviceOffline) {
          if (profile?.id == null) {
            Alert.alert('Sign in required', 'Sign in to save events on this device.');
            setSubmitting(false);
            return;
          }
          await enqueuePendingCalendarCreate(eventData, profile.id);
          Alert.alert(
            'Saved on device',
            'This event will sync when you are online. Invitations and emails are sent after it is saved on the server.'
          );
          router.replace('/calendar' as any);
          setSubmitting(false);
          return;
        }

        const crid =
          typeof globalThis !== 'undefined' && globalThis.crypto && 'randomUUID' in globalThis.crypto
            ? globalThis.crypto.randomUUID()
            : `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        const onlinePayload: Record<string, unknown> = {
          ...eventData,
          client_request_id: crid,
          created_from_offline_queue: false,
          original_client_timestamp: new Date().toISOString(),
        };

        try {
          await calendarCreateEvent(onlinePayload);
        } catch (e: any) {
          if (isCalendarFetchOfflineError(e) && profile?.id != null) {
            await enqueuePendingCalendarCreate(eventData, profile.id);
            Alert.alert(
              'Saved on device',
              'Could not reach the server. This event will sync when you are back online; invitations go out after sync.'
            );
            router.replace('/calendar' as any);
            setSubmitting(false);
            return;
          }
          throw e;
        }
      }

      await invalidateCalendarListCache();
      router.replace('/calendar' as any);
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.error || e?.message || 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }, [
    title,
    eventType,
    assignedMemberId,
    newEmail,
    newName,
    eventDate,
    eventTime,
    tz,
    durationMin,
    useReach,
    meetingUrlManual,
    description,
    notesField,
    location,
    participants,
    isRecurring,
    recurringFreq,
    recurringCount,
    categoryId,
    recordId,
    reminders,
    router,
    networkState,
    profile?.id,
  ]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>New event</AppHeaderTitle>
        <View style={{ width: APP_BACK_BUTTON_SLOT }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 52 : 0}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="on-drag"
          onScrollBeginDrag={dismissFormOverlays}
          showsVerticalScrollIndicator={false}
        >
        <Text style={styles.label}>Title *</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="Event title" placeholderTextColor={colors.textSecondary} />

        {isAdmin && !isPersonalAccount ? (
          <>
            <Text style={styles.label}>Event type</Text>
            <View style={styles.chipRow}>
              <TouchableOpacity style={[styles.chip, eventType === 'personal' && styles.chipOn]} onPress={() => setEventType('personal')}>
                <Text style={{ color: eventType === 'personal' ? colors.tint : colors.text, fontWeight: eventType === 'personal' ? '700' : '500' }}>
                  Personal
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.chip, eventType === 'company' && styles.chipOn]} onPress={() => setEventType('company')}>
                <Text style={{ color: eventType === 'company' ? colors.tint : colors.text, fontWeight: eventType === 'company' ? '700' : '500' }}>
                  Company
                </Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}

        {eventType === 'company' && isAdmin ? (
          <>
            <Text style={styles.label}>Assigned member *</Text>
            <TouchableOpacity
              style={styles.input}
              onPress={() => {
                setShowPicker(null);
                setDurationPickerOpen(false);
                setMemberModal(true);
                setMemberPickerExpandNonce((n) => n + 1);
              }}
            >
              <Text style={{ color: assignedMemberId ? colors.text : colors.textSecondary }}>
                {selectedMemberLabel || 'Tap to search member'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.chip, { alignSelf: 'flex-start', marginTop: 8 }]}
              onPress={() => setCategoryModal(true)}
            >
              <Text style={{ color: colors.text }}>
                {categoryId && recordId ? `Category link #${categoryId} / record #${recordId}` : 'Link category & record (optional)'}
              </Text>
            </TouchableOpacity>
          </>
        ) : null}

        <Text style={styles.label}>Starts</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity style={[styles.input, { flex: 1 }]} onPress={openDatePicker}>
            <Text style={{ color: colors.text }}>{eventDate}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.input, { flex: 1 }]} onPress={openTimePicker}>
            <Text style={{ color: colors.text }}>{eventTime}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.label}>Duration</Text>
        <TouchableOpacity
          style={[styles.input, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
          onPress={openDurationPicker}
          accessibilityRole="button"
          accessibilityLabel={`Duration, ${durationLabel}`}
        >
          <Text style={{ color: colors.text }}>{durationLabel}</Text>
          <Ionicons name="chevron-down" size={20} color={colors.textSecondary} />
        </TouchableOpacity>

        <Text style={styles.label}>Location</Text>
        <TextInput style={styles.input} value={location} onChangeText={setLocation} placeholderTextColor={colors.textSecondary} />

        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
          <Text style={{ flex: 1, color: colors.text, fontWeight: '600' }}>Create Reach meeting</Text>
          <Switch
            value={useReach}
            onValueChange={setUseReach}
            trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
            thumbColor={colors.switchThumbAndroid(useReach)}
            ios_backgroundColor={colors.switchTrackOff}
          />
        </View>

        {!useReach ? (
          <>
            <Text style={styles.label}>Meeting URL (optional)</Text>
            <TextInput style={styles.input} value={meetingUrlManual} onChangeText={setMeetingUrlManual} placeholderTextColor={colors.textSecondary} />
          </>
        ) : null}

        <View style={styles.additionalSection}>
          <TouchableOpacity
            style={styles.additionalHeader}
            onPress={() => setAdditionalExpanded((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: additionalExpanded }}
            accessibilityLabel={`Additional settings, ${additionalConfiguredCount} configured`}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontWeight: '600', color: colors.text, fontSize: 16 }}>Additional Settings</Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                ({additionalConfiguredCount} configured)
              </Text>
            </View>
            <Ionicons name={additionalExpanded ? 'chevron-up' : 'chevron-down'} size={22} color={colors.textSecondary} />
          </TouchableOpacity>

          {additionalExpanded ? (
            <View style={styles.additionalBody}>
              <Text style={[styles.label, { marginTop: 0 }]}>Description</Text>
              <LinkifiedMultilineInput
                style={[styles.input, { minHeight: 72 }]}
                multiline
                value={description}
                onChangeText={setDescription}
                placeholder="Add details about the event…"
                placeholderTextColor={colors.textSecondary}
                linkColor={colors.primary || '#007AFF'}
              />

              <Text style={styles.label}>Notes (on invite)</Text>
              <LinkifiedMultilineInput
                style={styles.input}
                value={notesField}
                onChangeText={setNotesField}
                placeholder="Optional note shown on the invite…"
                placeholderTextColor={colors.textSecondary}
                multiline
                linkColor={colors.primary || '#007AFF'}
              />

              <Text style={styles.label}>Reminders</Text>
              <EventRemindersEditor reminders={reminders} onChange={setReminders} colors={colors} />

              <Text style={styles.label}>Participants</Text>
              {participants.map((p) => (
                <View key={p.email} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
                  <Text style={{ color: colors.text }}>{p.name}</Text>
                  <TouchableOpacity onPress={() => setParticipants((x) => x.filter((q) => q.email !== p.email))}>
                    <Text style={{ color: '#ef4444' }}>Remove</Text>
                  </TouchableOpacity>
                </View>
              ))}
              <TextInput
                style={styles.input}
                placeholder="Email"
                value={newEmail}
                onChangeText={setNewEmail}
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                keyboardType="email-address"
              />
              <TextInput
                style={styles.input}
                placeholder="Name (optional)"
                value={newName}
                onChangeText={setNewName}
                placeholderTextColor={colors.textSecondary}
              />
              <TouchableOpacity style={[styles.btn, { marginTop: 8 }]} onPress={addParticipant}>
                <Text style={styles.btnText}>+ Add participant</Text>
              </TouchableOpacity>

              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16 }}>
                <Text style={{ flex: 1, color: colors.text, fontWeight: '600' }}>Recurring event</Text>
                <Switch
                  value={isRecurring}
                  onValueChange={setIsRecurring}
                  trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                  thumbColor={colors.switchThumbAndroid(isRecurring)}
                  ios_backgroundColor={colors.switchTrackOff}
                />
              </View>
              {isRecurring ? (
                <>
                  <Text style={styles.label}>Frequency</Text>
                  <View style={styles.chipRow}>
                    {['DAILY', 'WEEKLY', 'MONTHLY'].map((f) => (
                      <TouchableOpacity key={f} style={[styles.chip, recurringFreq === f && styles.chipOn]} onPress={() => setRecurringFreq(f)}>
                        <Text style={{ color: recurringFreq === f ? colors.tint : colors.text, fontWeight: recurringFreq === f ? '700' : '500' }}>
                          {f}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={styles.label}>Occurrence count</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="number-pad"
                    value={String(recurringCount)}
                    onChangeText={(x) => setRecurringCount(Math.max(1, parseInt(x || '1', 10) || 1))}
                  />
                </>
              ) : null}
            </View>
          ) : null}
        </View>

        <FeedbackTouchable
          style={[styles.btn, submitting && { opacity: 0.6 }]}
          disabled={submitting}
          loading={submitting}
          onPress={submit}
          spinnerColor="#fff"
        >
          <Text style={styles.btnText}>Create event</Text>
        </FeedbackTouchable>
      </ScrollView>
      </KeyboardAvoidingView>

      {showPicker === 'date' && Platform.OS === 'ios' ? (
        <MinimizableBottomSheet
          visible
          minimizable={false}
          expandNonce={datePickerExpandNonce}
          onClose={() => setShowPicker(null)}
          title="Date"
          sheetHeight={300}
        >
          <DateTimePicker
            value={getPickerDateTime(eventDate, eventTime)}
            mode="date"
            display="spinner"
            themeVariant={iosPickerTheme}
            onChange={(_, d) => {
              if (d) setEventDate(toLocalDateString(d));
            }}
          />
        </MinimizableBottomSheet>
      ) : null}

      {showPicker === 'time' && Platform.OS === 'ios' ? (
        <MinimizableBottomSheet
          visible
          minimizable={false}
          expandNonce={timePickerExpandNonce}
          onClose={() => setShowPicker(null)}
          title="Time"
          sheetHeight={300}
        >
          <DateTimePicker
            value={getPickerDateTime(eventDate, eventTime)}
            mode="time"
            display="spinner"
            themeVariant={iosPickerTheme}
            onChange={(_, d) => {
              if (d) setEventTime(formatLocalTime12h(d));
            }}
          />
        </MinimizableBottomSheet>
      ) : null}

      <MinimizableBottomSheet
        visible={durationPickerOpen}
        minimizable={false}
        expandNonce={durationPickerExpandNonce}
        onClose={() => setDurationPickerOpen(false)}
        title="Duration"
        heightRatio={0.52}
      >
        <ScrollView keyboardShouldPersistTaps="handled">
          {DURATION_PRESETS.map((p) => {
            const selected = durationMin === p.minutes;
            return (
              <TouchableOpacity
                key={p.minutes}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.border,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
                onPress={() => {
                  setDurationMin(p.minutes);
                  setDurationPickerOpen(false);
                }}
              >
                <Text style={{ fontSize: 16, color: colors.text, fontWeight: selected ? '700' : '400' }}>{p.label}</Text>
                {selected ? <Ionicons name="checkmark" size={22} color={colors.tint} /> : null}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </MinimizableBottomSheet>

      {Platform.OS === 'android' ? (
        <>
          {showPicker === 'date' ? (
            <DateTimePicker
              value={getPickerDateTime(eventDate, eventTime)}
              mode="date"
              display="default"
              positiveButton={{ label: 'OK', textColor: colors.tint }}
              negativeButton={{ label: 'Cancel', textColor: colors.textSecondary }}
              onChange={(e, d) => {
                if (e.type === 'dismissed') {
                  setShowPicker(null);
                  return;
                }
                if (e.type === 'set' && d) {
                  setEventDate(toLocalDateString(d));
                  setShowPicker(null);
                }
              }}
            />
          ) : null}
          {showPicker === 'time' ? (
            <DateTimePicker
              value={getPickerDateTime(eventDate, eventTime)}
              mode="time"
              display="default"
              positiveButton={{ label: 'OK', textColor: colors.tint }}
              negativeButton={{ label: 'Cancel', textColor: colors.textSecondary }}
              onChange={(e, d) => {
                if (e.type === 'dismissed') {
                  setShowPicker(null);
                  return;
                }
                if (e.type === 'set' && d) {
                  setEventTime(formatLocalTime12h(d));
                  setShowPicker(null);
                }
              }}
            />
          ) : null}
        </>
      ) : null}

      <MinimizableBottomSheet
        visible={memberModal}
        minimizable={false}
        expandNonce={memberPickerExpandNonce}
        onClose={() => {
          Keyboard.dismiss();
          setMemberModal(false);
        }}
        title="Search member"
        heightRatio={0.75}
      >
        <TextInput
          style={styles.input}
          placeholder="Name or email"
          placeholderTextColor={colors.textSecondary}
          value={memberQuery}
          onChangeText={setMemberQuery}
        />
        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
          {memberHits.map((m) => (
            <TouchableOpacity
              key={String(m.id)}
              style={{ paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
              onPress={() => {
                setAssignedMemberId(Number(m.id));
                setSelectedMemberLabel(m.name || m.email);
                setMemberModal(false);
                setMemberQuery('');
              }}
            >
              <Text style={{ color: colors.text }}>{m.name || m.email}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </MinimizableBottomSheet>

      <Modal visible={categoryModal} animationType="fade" transparent statusBarTranslucent>
        <View style={{ flex: 1, justifyContent: 'center', padding: 16 }}>
          <Pressable
            style={[StyleSheet.absoluteFillObject, { backgroundColor: '#0008' }]}
            onPress={() => setCategoryModal(false)}
          />
          <View
            style={{
              backgroundColor: colors.background,
              borderRadius: 12,
              padding: 16,
              maxHeight: '80%',
              zIndex: 1,
              elevation: 4,
            }}
          >
            <Text style={{ fontWeight: '600', marginBottom: 8, color: colors.text }}>Category & record</Text>
            <ScrollView>
              {categories.map((c) => (
                <View key={String(c.id)} style={{ marginBottom: 12 }}>
                  <Text style={{ fontWeight: '600', color: colors.text }}>{c.name || c.title || `Category ${c.id}`}</Text>
                  {(c.records || []).map((e: any) => (
                    <TouchableOpacity
                      key={String(e.id)}
                      style={{ paddingVertical: 8, paddingLeft: 8 }}
                      onPress={() => {
                        setCategoryId(c.id);
                        setRecordId(e.id);
                        setCategoryModal(false);
                      }}
                    >
                      <Text style={{ color: colors.textSecondary }}>{e.title || e.name || `Record ${e.id}`}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
            </ScrollView>
            <TouchableOpacity onPress={() => { setCategoryId(null); setRecordId(null); setCategoryModal(false); }}>
              <Text style={{ color: colors.tint, marginTop: 8 }}>Clear link</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setCategoryModal(false)} style={{ marginTop: 8 }}>
              <Text style={{ color: colors.textSecondary }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
