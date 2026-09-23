import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useNetworkState } from 'expo-network';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import MinimizableBottomSheet from '../../../components/MinimizableBottomSheet';
import LinkifiedMultilineInput from '../../../components/LinkifiedMultilineInput';
import { calendarIsCompanyAdmin, useCalendarProfile } from '../../../hooks/useCalendarProfile';
import { useThemeColors } from '../../../hooks/useThemeColors';
import {
  calendarCategoriesWithRecords,
  calendarConnections,
  calendarEventIsOrganizer,
  calendarGetEvent,
  calendarIdentityEmails,
  calendarSearchCompanyMembers,
  calendarSyncGoogleWithStaleConnectionRecovery,
  calendarUpdateEvent,
  scheduleReachMeeting,
} from '../../../services/calendarApi';
import { getCalendarIdentityEmails, invalidateCalendarListCache, saveCalendarIdentityEmails } from '../../../utils/calendarCache';
import { isDeviceOfflineForCalendar } from '../../../utils/calendarOffline';
import {
  combineLocalDateAndTimeStrings,
  convertLocalTimeToUTC,
  formatLocalTime12h,
  getDeviceIanaTimezone,
  parseUTC,
  toLocalDateString,
} from '../../../utils/calendarTime';
import { htmlToPlainText } from '../../../utils/linkifyPlainText';

import AppBackButton, { APP_BACK_BUTTON_SLOT } from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';
import EventRemindersEditor from '../../../components/calendar/EventRemindersEditor';
import { DEFAULT_REMINDERS, remindersFromEvent, type CalendarReminder } from '../../../utils/calendarReminders';

type Participant = { email: string; name: string; type: string };

/** Matches `app/calendar/create.tsx` and Reach meeting name limits. */
const MAX_EVENT_TITLE_LENGTH = 50;

/** Same presets as `app/calendar/create.tsx` */
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

export default function CalendarEditScreen() {
  const { id: idParam } = useLocalSearchParams<{ id?: string }>();
  const eventId = Number(idParam);
  const router = useRouter();
  const colors = useThemeColors();
  const { profile, loading: profileLoading, refresh } = useCalendarProfile();
  const isAdmin = calendarIsCompanyAdmin(profile);
  const networkState = useNetworkState();
  const deviceOffline = useMemo(
    () => isDeviceOfflineForCalendar(networkState),
    [networkState?.isConnected, networkState?.type, networkState?.isInternetReachable]
  );
  const tz = useMemo(() => getDeviceIanaTimezone(), []);

  useFocusEffect(
    useCallback(() => {
      if (!deviceOffline) {
        calendarSyncGoogleWithStaleConnectionRecovery().catch(() => {});
      }
    }, [deviceOffline])
  );

  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [notesField, setNotesField] = useState('');
  const [location, setLocation] = useState('');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [useReach, setUseReach] = useState(false);
  const [existingVideoCallId, setExistingVideoCallId] = useState<number | null>(null);

  const [eventDate, setEventDate] = useState('');
  const [eventTime, setEventTime] = useState('');
  const [durationMin, setDurationMin] = useState(60);

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');

  const [additionalExpanded, setAdditionalExpanded] = useState(false);
  const [reminders, setReminders] = useState<CalendarReminder[]>(DEFAULT_REMINDERS);

  const [eventType, setEventType] = useState<'personal' | 'company'>('personal');
  const [assignedMemberId, setAssignedMemberId] = useState<number | null>(null);
  const [selectedMemberLabel, setSelectedMemberLabel] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [memberHits, setMemberHits] = useState<any[]>([]);
  const [memberModal, setMemberModal] = useState(false);
  const [categories, setCategories] = useState<any[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [recordId, setRecordId] = useState<number | null>(null);
  const [categoryModal, setCategoryModal] = useState(false);

  const [showPicker, setShowPicker] = useState<'date' | 'time' | null>(null);
  const [durationPickerOpen, setDurationPickerOpen] = useState(false);
  const [datePickerExpandNonce, setDatePickerExpandNonce] = useState(0);
  const [timePickerExpandNonce, setTimePickerExpandNonce] = useState(0);
  const [durationPickerExpandNonce, setDurationPickerExpandNonce] = useState(0);
  const [memberPickerExpandNonce, setMemberPickerExpandNonce] = useState(0);
  const [submitting, setSubmitting] = useState(false);

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

  useEffect(() => {
    if (eventType !== 'company' || !isAdmin) {
      setCategories([]);
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

  const load = useCallback(async () => {
    if (!Number.isFinite(eventId)) return;
    const event = await calendarGetEvent(eventId);
    let identityEmails = await getCalendarIdentityEmails();
    try {
      const conns = await calendarConnections();
      identityEmails = calendarIdentityEmails(profile, conns, event.viewer_identity_emails);
      await saveCalendarIdentityEmails(identityEmails);
    } catch {
      identityEmails = calendarIdentityEmails(profile, null, [
        ...identityEmails,
        ...(event.viewer_identity_emails || []),
      ]);
    }
    // Wait for profile before gating — null profile is "not loaded yet", not "not organizer".
    if (profile) {
      const isOrganizer = calendarEventIsOrganizer(event, profile, identityEmails);
      const canManage =
        isOrganizer || (event.event_type === 'company' && calendarIsCompanyAdmin(profile));
      if (!canManage) {
        Alert.alert('Not allowed', 'Only the organizer can edit this event.', [
          { text: 'OK', onPress: () => router.replace(`/calendar/${eventId}` as any) },
        ]);
        return;
      }
    }

    setTitle(event.title || '');
    setDescription(htmlToPlainText(event.description || ''));
    setNotesField(
      htmlToPlainText(
        typeof event.notes === 'string' ? event.notes : event.notes != null ? String(event.notes) : '',
      ),
    );
    setLocation(event.location || '');
    setMeetingUrl(event.meeting_url || '');
    const rawVid = event.video_call_id;
    const vid = rawVid != null && rawVid !== '' ? Number(rawVid) : NaN;
    setExistingVideoCallId(Number.isFinite(vid) ? vid : null);
    const url = String(event.meeting_url || '');
    const isReachUrl = /join-meeting|\/meet\//i.test(url);
    const loc = String(event.location || '');
    setUseReach(!!(event.video_call_id || isReachUrl || (loc && loc.includes('Reach'))));

    setEventType(event.event_type === 'company' ? 'company' : 'personal');
    setAssignedMemberId(event.event_type === 'company' && event.user_id != null ? Number(event.user_id) : null);
    setSelectedMemberLabel(event.event_type === 'company' && event.user_id != null ? `Member #${event.user_id}` : '');
    setCategoryId(event.linked_category_id ?? null);
    setRecordId(event.linked_category_record_id ?? null);

    if (event.start_time) {
      const s = parseUTC(event.start_time);
      setEventDate(toLocalDateString(s));
      setEventTime(formatLocalTime12h(s));
      if (event.end_time) {
        const e = parseUTC(event.end_time);
        const mins = Math.round((e.getTime() - s.getTime()) / 60000);
        setDurationMin(Number.isFinite(mins) && mins > 0 ? mins : 60);
      } else {
        setDurationMin(60);
      }
    }

    const plist = Array.isArray(event.participants)
      ? event.participants.map((p: any) => ({
          email: p.email,
          name: p.name || p.email,
          type: p.type || 'required',
        }))
      : [];
    setParticipants(plist);

    setReminders(remindersFromEvent(event as Record<string, unknown>));
  }, [eventId, profile, router]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!Number.isFinite(eventId)) {
        setLoading(false);
        return;
      }
      if (profileLoading) return;
      setLoading(true);
      try {
        await load();
      } catch (e: any) {
        Alert.alert('Error', e?.response?.data?.error || e?.message || 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, load, profileLoading]);

  const durationLabel = useMemo(() => {
    const preset = DURATION_PRESETS.find((p) => p.minutes === durationMin);
    return preset?.label ?? `${durationMin} minutes`;
  }, [durationMin]);

  const getPickerDateTime = (): Date =>
    eventDate && eventTime ? combineLocalDateAndTimeStrings(eventDate, eventTime) : new Date();

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
        btn: { backgroundColor: '#007AFF', padding: 14, borderRadius: 10, marginTop: 20, alignItems: 'center' },
        btnText: { color: '#fff', fontWeight: '600' },
      }),
    [colors]
  );

  const iosPickerTheme = colors.isDark ? 'dark' : 'light';

  const additionalConfiguredCount = useMemo(() => {
    let n = participants.length;
    if (reminders.length > 0) n += 1;
    if (description.trim().length > 0) n += 1;
    if (notesField.trim().length > 0) n += 1;
    return n;
  }, [participants.length, reminders.length, description, notesField]);

  const addParticipant = () => {
    const email = newEmail.trim();
    if (!email) return;
    setParticipants((p) => [...p, { email, name: newName.trim() || email, type: 'required' }]);
    setNewEmail('');
    setNewName('');
  };

  const save = async () => {
    if (!Number.isFinite(eventId)) return;
    if (!title.trim()) {
      Alert.alert('Title', 'Required');
      return;
    }
    if (title.trim().length > MAX_EVENT_TITLE_LENGTH) {
      Alert.alert('Title', `Max ${MAX_EVENT_TITLE_LENGTH} characters`);
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
    if (!eventDate || !eventTime) {
      Alert.alert('Time', 'Select date and start time');
      return;
    }

    let startDt: Date;
    let endDt: Date;
    try {
      startDt = convertLocalTimeToUTC(eventDate, eventTime, tz);
      endDt = new Date(startDt.getTime() + Math.max(1, durationMin) * 60 * 1000);
    } catch {
      Alert.alert('Time', 'Enter a valid start time (for example 5:00 PM).');
      return;
    }

    if (categoryId != null && recordId == null) {
      Alert.alert('Category', 'Select both or clear');
      return;
    }
    if (categoryId == null && recordId != null) {
      Alert.alert('Category', 'Select both or clear');
      return;
    }
    if (eventType === 'company' && isAdmin && !assignedMemberId) {
      Alert.alert('Assigned member', 'Select a company member');
      return;
    }

    setSubmitting(true);
    try {
      let meetingUrlForPut = meetingUrl.trim() || undefined;

      if (useReach && !existingVideoCallId) {
        try {
          const durationMinutes = Math.max(1, durationMin);
          const videoMeetingData = {
            room_name: title.trim(),
            description: description.trim() || 'Reach Video Meeting',
            scheduled_time: startDt.toISOString(),
            duration_minutes: durationMinutes,
            max_participants: 10,
            enable_recording: false,
            enable_transcription: false,
            passcode_required: false,
            invitees: participants.map((p) => p.email),
            from_reach_page: true,
            link_calendar_event_id: eventId,
          };
          const videoResponse = await scheduleReachMeeting(videoMeetingData);
          if (videoResponse?.encoded_meeting_url) {
            meetingUrlForPut = videoResponse.encoded_meeting_url;
          } else if (videoResponse?.room) {
            const room = videoResponse.room;
            const mid = room.meeting_id || room.id;
            meetingUrlForPut = `https://grabdocs.com/join-meeting?meeting_id=${mid}`;
          }
        } catch (e: any) {
          Alert.alert('Reach', e?.response?.data?.error || e?.message || 'Failed');
          setSubmitting(false);
          return;
        }
      }

      const eventData: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim(),
        notes: notesField.trim() || undefined,
        start_time: startDt.toISOString(),
        end_time: endDt.toISOString(),
        timezone: tz,
        location: location.trim() || undefined,
        meeting_url: useReach ? meetingUrlForPut : meetingUrl.trim() || undefined,
        participants,
        reminders,
        reminder_minutes: reminders.map((r) => r.minutes),
        linked_category_id: categoryId ?? undefined,
        linked_category_record_id: recordId ?? undefined,
      };
      if (eventType === 'company' && isAdmin) {
        eventData.assigned_user_id = assignedMemberId;
      }

      await calendarUpdateEvent(eventId, eventData);
      await invalidateCalendarListCache();
      router.replace(`/calendar/${eventId}` as any);
    } catch (e: any) {
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.error ||
        e?.message ||
        (status === 403 ? 'Only the organizer can edit this event' : 'Update failed');
      Alert.alert('Error', msg, [
        {
          text: 'OK',
          onPress: () => {
            if (status === 403) router.replace(`/calendar/${eventId}` as any);
          },
        },
      ]);
    } finally {
      setSubmitting(false);
    }
  };

  if (!Number.isFinite(eventId)) {
    return (
      <SafeAreaView style={styles.safe}>
        <Text style={{ padding: 16, color: colors.text }}>Invalid event</Text>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 40 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Edit event</AppHeaderTitle>
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
          showsVerticalScrollIndicator={false}
        >
        <Text style={styles.label}>Title</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholderTextColor={colors.textSecondary}
          maxLength={MAX_EVENT_TITLE_LENGTH}
        />

        {isAdmin && eventType === 'company' ? (
          <>
            <Text style={styles.label}>Assigned member</Text>
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
            <TouchableOpacity style={[styles.input, { marginTop: 12 }]} onPress={() => setCategoryModal(true)}>
              <Text style={{ color: colors.text }}>
                {categoryId && recordId ? `Category #${categoryId} / record #${recordId}` : 'Link category & record'}
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

        {existingVideoCallId == null ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
            <Text style={{ flex: 1, color: colors.text, fontWeight: '600' }}>Add Reach meeting</Text>
            <Switch
              value={useReach}
              onValueChange={setUseReach}
              trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
              thumbColor={colors.switchThumbAndroid(useReach)}
              ios_backgroundColor={colors.switchTrackOff}
            />
          </View>
        ) : null}

        {!useReach || existingVideoCallId != null ? (
          <>
            <Text style={styles.label}>Meeting URL</Text>
            <TextInput style={styles.input} value={meetingUrl} onChangeText={setMeetingUrl} placeholderTextColor={colors.textSecondary} />
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
                autoCapitalize="none"
                keyboardType="email-address"
                placeholderTextColor={colors.textSecondary}
              />
              <TextInput style={styles.input} placeholder="Name" value={newName} onChangeText={setNewName} placeholderTextColor={colors.textSecondary} />
              <TouchableOpacity
                style={[styles.btn, { marginTop: 8, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }]}
                onPress={addParticipant}
              >
                <Text style={[styles.btnText, { color: colors.text }]}>+ Add participant</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        <FeedbackTouchable
          style={[styles.btn, submitting && { opacity: 0.6 }]}
          disabled={submitting}
          loading={submitting}
          onPress={save}
          spinnerColor="#fff"
        >
          <Text style={styles.btnText}>Save</Text>
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
            value={getPickerDateTime()}
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
            value={getPickerDateTime()}
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
              value={getPickerDateTime()}
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
              value={getPickerDateTime()}
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
                setSelectedMemberLabel(m.name || m.email || `Member #${m.id}`);
                setMemberModal(false);
                setMemberQuery('');
              }}
            >
              <Text style={{ color: colors.text }}>{m.name || m.email || `Member #${m.id}`}</Text>
              {m.email ? <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{m.email}</Text> : null}
            </TouchableOpacity>
          ))}
        </ScrollView>
      </MinimizableBottomSheet>

      <Modal visible={categoryModal} transparent animationType="fade">
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
            <ScrollView>
              {categories.map((c) => (
                <View key={String(c.id)} style={{ marginBottom: 12 }}>
                  <Text style={{ fontWeight: '600', color: colors.text }}>{c.name || c.title || `Cat ${c.id}`}</Text>
                  {(c.records || []).map((r: any) => (
                    <TouchableOpacity
                      key={String(r.id)}
                      style={{ paddingVertical: 8, paddingLeft: 8 }}
                      onPress={() => {
                        setCategoryId(c.id);
                        setRecordId(r.id);
                        setCategoryModal(false);
                      }}
                    >
                      <Text style={{ color: colors.textSecondary }}>{r.title || r.name || `Rec ${r.id}`}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
            </ScrollView>
            <TouchableOpacity onPress={() => { setCategoryId(null); setRecordId(null); setCategoryModal(false); }}>
              <Text style={{ color: '#007AFF', marginTop: 8 }}>Clear</Text>
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
