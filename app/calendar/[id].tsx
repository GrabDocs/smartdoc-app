import { Ionicons } from '@expo/vector-icons';
import { useNetworkState } from 'expo-network';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import LinkifiedText from '../../components/LinkifiedText';
import MinimizableBottomSheet from '../../components/MinimizableBottomSheet';
import ClientsButton from '../../components/clients/ClientsButton';
import { calendarIsCompanyAdmin, useCalendarProfile } from '../../hooks/useCalendarProfile';
import { resendCooldownKey, useResendCooldown, formatRemainingCountdown } from '../../hooks/useResendCooldown';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
    calendarDeleteEvent,
    calendarEventCanRemoveFromCalendar,
    calendarEventIsOrganizer,
    calendarEventMeeting,
    calendarGetEvent,
    calendarRemoveFromCalendar,
    calendarResendInvite,
    calendarRsvp,
    calendarSyncGoogleWithStaleConnectionRecovery,
    noteCreate,
    noteDelete,
    notesForCalendarEvent,
    noteUpdate,
    type CalendarEvent,
} from '../../services/calendarApi';
import {
    getCalendarEventDetailOffline,
    invalidateCalendarListCache,
    isCalendarFetchOfflineError,
    removeCalendarEventDetailOffline,
    saveCalendarEventDetailOffline,
} from '../../utils/calendarCache';
import { isDeviceOfflineForCalendar } from '../../utils/calendarOffline';
import { navigateJoinMeeting } from '../../utils/calendarReachJoin';
import { calendarDisplayLocation, formatUtcIsoForDevice } from '../../utils/calendarTime';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

function CalendarResendInviteButton({
  eventId,
  participantId,
  deviceOffline,
}: {
  eventId: number;
  participantId: number;
  deviceOffline: boolean;
}) {
  const { remainingSec, isCoolingDown, markSent } = useResendCooldown(
    resendCooldownKey('calendar', eventId, participantId),
  );

  return (
    <FeedbackTouchable
      spinnerColor="#007AFF"
      disabled={isCoolingDown}
      style={isCoolingDown ? { opacity: 0.55 } : undefined}
      onPress={async () => {
        if (deviceOffline) {
          Alert.alert('Offline', 'Resend requires a connection.');
          return;
        }
        if (isCoolingDown) {
          Alert.alert('Please wait', `You can resend in ${formatRemainingCountdown(remainingSec)}`);
          return;
        }
        try {
          await calendarResendInvite(eventId, participantId);
          markSent();
          Alert.alert('Sent', 'Invitation resent');
        } catch (e: any) {
          const status = e?.response?.status;
          Alert.alert(
            'Error',
            e?.response?.data?.error ||
              (status === 403 ? 'Only the organizer can resend invitations' : 'Resend failed')
          );
        }
      }}
    >
      <Text style={{ color: '#007AFF' }}>
        {isCoolingDown ? `Resend in ${formatRemainingCountdown(remainingSec)}` : 'Resend'}
      </Text>
    </FeedbackTouchable>
  );
}

function rsvpStatusBadge(status?: string | null): {
  label: string;
  backgroundColor: string;
  color: string;
} | null {
  const s = String(status ?? '').toLowerCase().trim();
  if (!s) return null;
  switch (s) {
    case 'accepted':
      return { label: 'accepted', backgroundColor: '#DCFCE7', color: '#166534' };
    case 'declined':
      return { label: 'declined', backgroundColor: '#FEE2E2', color: '#991B1B' };
    case 'tentative':
      return { label: 'tentative', backgroundColor: '#FEF3C7', color: '#92400E' };
    case 'needs-action':
      return { label: 'needs action', backgroundColor: '#F3F4F6', color: '#4B5563' };
    default:
      return { label: s, backgroundColor: '#F3F4F6', color: '#4B5563' };
  }
}

export default function CalendarEventDetailScreen() {
  const { id: idParam } = useLocalSearchParams<{ id?: string }>();
  const eventId = Number(idParam);
  const router = useRouter();
  const colors = useThemeColors();
  const { profile, refresh: refreshProfile } = useCalendarProfile();

  const networkState = useNetworkState();
  const deviceOffline = useMemo(
    () => isDeviceOfflineForCalendar(networkState),
    [networkState?.isConnected, networkState?.type, networkState?.isInternetReachable]
  );

  const [loading, setLoading] = useState(true);
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [meetingInfo, setMeetingInfo] = useState<any | null>(null);
  const [notes, setNotes] = useState<any[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesLoading, setNotesLoading] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [newNoteBody, setNewNoteBody] = useState('');
  const [editingNote, setEditingNote] = useState<any | null>(null);
  const [rsvpComment, setRsvpComment] = useState('');
  const [actionBusy, setActionBusy] = useState<'cancel' | 'remove' | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [deletingNoteId, setDeletingNoteId] = useState<number | null>(null);

  const loadEvent = useCallback(async () => {
    if (!Number.isFinite(eventId)) return;

    if (deviceOffline) {
      const cached = await getCalendarEventDetailOffline(eventId);
      if (cached) {
        setEvent(cached as CalendarEvent);
        setMeetingInfo(null);
      } else {
        setEvent(null);
      }
      return;
    }

    try {
      const ev = await calendarGetEvent(eventId);
      setEvent(ev);
      await saveCalendarEventDetailOffline(ev as Record<string, unknown>);
      try {
        const m = await calendarEventMeeting(eventId);
        if (m?.has_meeting && m.meeting) setMeetingInfo(m.meeting);
        else setMeetingInfo(null);
      } catch {
        setMeetingInfo(null);
      }
    } catch (e: any) {
      const cached = await getCalendarEventDetailOffline(eventId);
      if (cached) {
        setEvent(cached as CalendarEvent);
        setMeetingInfo(null);
        if (!isCalendarFetchOfflineError(e)) {
          Alert.alert('Error', e?.response?.data?.error || e?.message || 'Failed to load event');
        }
      } else {
        Alert.alert('Error', e?.response?.data?.error || e?.message || 'Failed to load event');
      }
    }
  }, [eventId, deviceOffline]);

  /** First paint for this event id shows spinner; later focuses (e.g. back from Edit) refresh silently. */
  const initialDetailLoadRef = useRef(false);

  useEffect(() => {
    initialDetailLoadRef.current = false;
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        if (!Number.isFinite(eventId)) {
          setLoading(false);
          return;
        }
        const blocking = !initialDetailLoadRef.current;
        if (blocking) setLoading(true);
        await loadEvent();
        initialDetailLoadRef.current = true;
        if (!cancelled) setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [eventId, loadEvent])
  );

  useEffect(() => {
    refreshProfile();
  }, [refreshProfile]);

  useFocusEffect(
    useCallback(() => {
      if (!deviceOffline) {
        calendarSyncGoogleWithStaleConnectionRecovery().catch(() => {});
      }
    }, [deviceOffline])
  );

  const loadNotes = useCallback(async () => {
    if (!Number.isFinite(eventId)) return;
    if (deviceOffline) {
      setNotes([]);
      return;
    }
    setNotesLoading(true);
    try {
      const list = await notesForCalendarEvent(eventId);
      setNotes(list);
    } catch {
      Alert.alert('Error', 'Failed to load notes');
    } finally {
      setNotesLoading(false);
    }
  }, [eventId, deviceOffline]);

  useEffect(() => {
    if (!event || !Number.isFinite(eventId)) return;
    if (deviceOffline) {
      setNotes([]);
      return;
    }
    notesForCalendarEvent(eventId).then(setNotes).catch(() => setNotes([]));
  }, [event, eventId, deviceOffline]);

  useEffect(() => {
    if (notesOpen && Number.isFinite(eventId)) loadNotes();
  }, [notesOpen, eventId, loadNotes]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { flexDirection: 'row', alignItems: 'center', padding: 12 , backgroundColor: colors.headerBackground },
        h1: {
          fontSize: 20,
          fontWeight: '700',
          color: colors.text,
          flex: 1,
          flexShrink: 1,
          minWidth: 0,
        },
        body: { padding: 16, paddingBottom: 48 },
        meta: { color: colors.textSecondary, fontSize: 14, marginBottom: 8 },
        pill: {
          alignSelf: 'flex-start',
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: 8,
          backgroundColor: colors.surface,
          marginBottom: 12,
        },
        statusPill: {
          alignSelf: 'flex-start',
          paddingHorizontal: 12,
          paddingVertical: 4,
          borderRadius: 999,
        },
        statusPillText: {
          fontSize: 13,
          fontWeight: '600',
          textTransform: 'lowercase',
        },
        btn: {
          backgroundColor: '#007AFF',
          padding: 14,
          borderRadius: 10,
          marginBottom: 10,
          alignItems: 'center',
        },
        btnRowHalf: { flex: 1, marginBottom: 0 },
        btnRowFull: { flex: 1, marginBottom: 0 },
        btnSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
        btnDanger: { backgroundColor: '#ef4444' },
        btnText: { color: '#fff', fontWeight: '600' },
        btnTextDark: { color: colors.text, fontWeight: '600' },
        rowBtn: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
        smallBtn: { flex: 1, padding: 10, borderRadius: 8, backgroundColor: colors.surface, alignItems: 'center' },
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
      }),
    [colors]
  );

  const userNumericId = profile?.id ?? null;
  const isPersonalAccount = useMemo(() => (profile?.company_id ?? 0) === 0, [profile?.company_id]);
  const isOrganizer = calendarEventIsOrganizer(event, profile);
  const isAdmin = calendarIsCompanyAdmin(profile);
  /** Organizer authority, or company-admin for company events (matches web). */
  const canManageEvent = !!(
    event &&
    (isOrganizer || (event.event_type === 'company' && isAdmin))
  );
  const canRemoveFromCalendar = calendarEventCanRemoveFromCalendar(event, profile, {
    canManageEvent,
  });
  const myRsvpBadge = useMemo(() => {
    const email = (profile?.email || '').trim().toLowerCase();
    if (!email || !Array.isArray(event?.participants)) return null;
    const me = event.participants.find((p) => (p.email || '').trim().toLowerCase() === email);
    return rsvpStatusBadge(me?.status);
  }, [event?.participants, profile?.email]);

  const leaveEventAndGoToList = useCallback(async () => {
    await removeCalendarEventDetailOffline(eventId);
    await invalidateCalendarListCache();
    router.replace('/calendar' as any);
  }, [eventId, router]);

  const handleEdit = useCallback(() => {
    if (deviceOffline) {
      Alert.alert('Offline', 'Editing requires a connection.');
      return;
    }
    router.push(`/calendar/edit/${eventId}` as any);
  }, [deviceOffline, eventId, router]);

  const performRemoveFromCalendar = useCallback(async () => {
    setActionBusy('remove');
    try {
      await calendarRemoveFromCalendar(eventId);
      await leaveEventAndGoToList();
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.error || 'Could not remove event from your calendar');
    } finally {
      setActionBusy(null);
    }
  }, [eventId, leaveEventAndGoToList]);

  const handleRemoveFromCalendar = useCallback(() => {
    if (deviceOffline) {
      Alert.alert('Offline', 'Removing from calendar requires a connection.');
      return;
    }
    Alert.alert(
      'Remove from my calendar',
      'This removes the event from your calendar only. Other participants will not be notified.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void performRemoveFromCalendar();
          },
        },
      ]
    );
  }, [deviceOffline, performRemoveFromCalendar]);

  const handleCancelEvent = useCallback(() => {
    if (deviceOffline) {
      Alert.alert('Offline', 'Canceling requires a connection.');
      return;
    }
    Alert.alert(
      'Cancel event',
      'This cancels the event for everyone. Participants will be notified.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel event',
          style: 'destructive',
          onPress: async () => {
            setActionBusy('cancel');
            try {
              await calendarDeleteEvent(eventId);
              await leaveEventAndGoToList();
            } catch (e: any) {
              const data = e?.response?.data;
              if (data?.code === 'use_remove_from_calendar') {
                setActionBusy(null);
                Alert.alert(
                  'Remove from calendar?',
                  data?.error ||
                    'You are not the organizer. Remove this event from your calendar only?',
                  [
                    { text: 'Keep', style: 'cancel' },
                    {
                      text: 'Remove',
                      style: 'destructive',
                      onPress: () => {
                        void performRemoveFromCalendar();
                      },
                    },
                  ]
                );
                return;
              }
              Alert.alert('Error', data?.error || 'Cancel failed');
            } finally {
              setActionBusy((prev) => (prev === 'cancel' ? null : prev));
            }
          },
        },
      ]
    );
  }, [deviceOffline, eventId, leaveEventAndGoToList, performRemoveFromCalendar]);

  const saveNote = async () => {
    if (deviceOffline) {
      Alert.alert('Offline', 'Notes require a connection.');
      return;
    }
    if (!newNoteTitle.trim() || !newNoteBody.trim()) {
      Alert.alert('Note', 'Enter title and content');
      return;
    }
    setNoteBusy(true);
    try {
      if (editingNote) {
        await noteUpdate(editingNote.id, { title: newNoteTitle.trim(), content: newNoteBody.trim() });
      } else {
        await noteCreate({
          source_type: 'calendar_event',
          source_id: eventId,
          title: newNoteTitle.trim(),
          content: newNoteBody.trim(),
        });
      }
      setNewNoteTitle('');
      setNewNoteBody('');
      setEditingNote(null);
      await loadNotes();
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.error || 'Could not save note');
    } finally {
      setNoteBusy(false);
    }
  };

  /** Reach hub assets experience (same as meeting list folder icon), not the legacy calendar assets page. */
  const openReachMeetingAssets = useCallback(() => {
    if (!Number.isFinite(eventId)) return;
    const rawId = meetingInfo?.meeting_id ?? meetingInfo?.meetingId;
    const mid = rawId != null ? String(rawId).trim() : '';
    if (!mid) {
      router.push(`/calendar/assets/${eventId}` as any);
      return;
    }
    const title =
      (meetingInfo?.room_name && String(meetingInfo.room_name).trim()) ||
      (typeof event?.title === 'string' && event.title.trim()) ||
      'Meeting';
    router.push({
      pathname: '/quick-reach/meeting-details',
      params: {
        meetingId: mid,
        meetingTitle: title,
        roomCode: mid,
        entry: 'assets',
      },
    } as any);
  }, [router, eventId, meetingInfo, event]);

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
        <View style={styles.header}>
          <AppBackButton />
        </View>
        <ActivityIndicator style={{ marginTop: 40 }} />
      </SafeAreaView>
    );
  }

  if (!event) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <AppBackButton />
        </View>
        <Text style={[styles.meta, { paddingHorizontal: 16, marginTop: 24 }]}>
          {deviceOffline
            ? 'This event is not saved on this device. Open it once while online to save a copy.'
            : 'Could not load this event.'}
        </Text>
      </SafeAreaView>
    );
  }

  const locationLabel = calendarDisplayLocation(event.location);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>
          {event.title || 'Event'}
        </AppHeaderTitle>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {deviceOffline ? (
          <Text style={[styles.meta, { marginBottom: 12, color: colors.text }]}>
            Offline — showing saved copy. Connect for live updates, notes, and RSVP.
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {(!isPersonalAccount || event.event_type === 'company') ? (
            <View style={[styles.pill, { marginBottom: 0 }]}>
              <Text style={{ color: colors.text, fontSize: 13 }}>
                {event.event_type === 'company' ? 'Company' : 'Personal'}
              </Text>
            </View>
          ) : null}
          {myRsvpBadge ? (
            <View style={[styles.statusPill, { backgroundColor: myRsvpBadge.backgroundColor }]}>
              <Text style={[styles.statusPillText, { color: myRsvpBadge.color }]}>{myRsvpBadge.label}</Text>
            </View>
          ) : null}
          {String(event.status ?? '').toLowerCase() === 'cancelled' ? (
            <View style={[styles.statusPill, { backgroundColor: '#FEE2E2' }]}>
              <Text style={[styles.statusPillText, { color: '#991B1B' }]}>cancelled</Text>
            </View>
          ) : null}
        </View>
        {event.start_time ? (
          <Text style={[styles.meta, { color: colors.text }]}>
            {formatUtcIsoForDevice(event.start_time, { dateStyle: 'full', timeStyle: 'short' })}
            {event.end_time
              ? ` → ${formatUtcIsoForDevice(event.end_time, { timeStyle: 'short' })}`
              : ''}
          </Text>
        ) : null}
        {locationLabel ? <Text style={styles.meta}>📍 {locationLabel}</Text> : null}
        {event.organizer ? (
          <Text style={styles.meta}>
            Organized by {event.organizer.name || event.organizer.email || '—'}
          </Text>
        ) : null}
        {event.description ? (
          <LinkifiedText style={[styles.meta, { color: colors.text }]} linkColor={colors.primary || '#007AFF'}>
            {event.description}
          </LinkifiedText>
        ) : null}
        {event.notes ? (
          <LinkifiedText style={[styles.meta, { color: colors.text }]} linkColor={colors.primary || '#007AFF'}>
            {`Event notes: ${event.notes}`}
          </LinkifiedText>
        ) : null}

        {(() => {
          const joinEligible =
            String(event.status ?? '').toLowerCase() !== 'cancelled' &&
            !!(event.meeting_url || event.video_call_id || meetingInfo);
          return (
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10, alignItems: 'stretch' }}>
              {joinEligible ? (
                <TouchableOpacity
                  style={[styles.btn, styles.btnRowHalf]}
                  onPress={() => navigateJoinMeeting(router, event.meeting_url, meetingInfo, event.video_call_id)}
                >
                  <Text style={styles.btnText}>Join meeting</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[styles.btn, styles.btnSecondary, joinEligible ? styles.btnRowHalf : styles.btnRowFull]}
                onPress={() => setNotesOpen(true)}
              >
                <Text style={styles.btnTextDark}>Notebook ({notes.length})</Text>
              </TouchableOpacity>
            </View>
          );
        })()}

        {meetingInfo &&
        (meetingInfo.has_recording ||
          meetingInfo.has_transcript ||
          meetingInfo.has_summary ||
          meetingInfo.has_chat) ? (
          <TouchableOpacity
            style={[styles.btn, styles.btnSecondary]}
            onPress={openReachMeetingAssets}
          >
            <Text style={styles.btnTextDark}>Meeting assets</Text>
          </TouchableOpacity>
        ) : null}

        {String(event.status ?? '').toLowerCase() !== 'cancelled' &&
        !isOrganizer &&
        Array.isArray(event.participants) &&
        event.participants.some((p: any) => (p.email || '').toLowerCase() === (profile?.email || '').toLowerCase()) ? (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.label}>RSVP note (optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="Message to the organizer…"
              placeholderTextColor={colors.textSecondary}
              value={rsvpComment}
              onChangeText={setRsvpComment}
              multiline
            />
            <View style={[styles.rowBtn, { marginTop: 8 }]}>
              <FeedbackTouchable
                style={styles.smallBtn}
                spinnerColor={colors.text}
                onPress={async () => {
                  if (deviceOffline) {
                    Alert.alert('Offline', 'RSVP requires a connection.');
                    return;
                  }
                  try {
                    await calendarRsvp(eventId, 'accepted', rsvpComment.trim() || undefined);
                    setRsvpComment('');
                    await loadEvent();
                  } catch (e: any) {
                    Alert.alert('RSVP', e?.response?.data?.error || 'Failed');
                  }
                }}
              >
                <Text style={{ color: colors.text }}>Accept</Text>
              </FeedbackTouchable>
              <FeedbackTouchable
                style={styles.smallBtn}
                spinnerColor={colors.text}
                onPress={async () => {
                  if (deviceOffline) {
                    Alert.alert('Offline', 'RSVP requires a connection.');
                    return;
                  }
                  try {
                    await calendarRsvp(eventId, 'tentative', rsvpComment.trim() || undefined);
                    setRsvpComment('');
                    await loadEvent();
                  } catch (e: any) {
                    Alert.alert('RSVP', e?.response?.data?.error || 'Failed');
                  }
                }}
              >
                <Text style={{ color: colors.text }}>Tentative</Text>
              </FeedbackTouchable>
              <FeedbackTouchable
                style={styles.smallBtn}
                spinnerColor={colors.text}
                onPress={async () => {
                  if (deviceOffline) {
                    Alert.alert('Offline', 'RSVP requires a connection.');
                    return;
                  }
                  try {
                    await calendarRsvp(eventId, 'declined', rsvpComment.trim() || undefined);
                    setRsvpComment('');
                    await loadEvent();
                  } catch (e: any) {
                    Alert.alert('RSVP', e?.response?.data?.error || 'Failed');
                  }
                }}
              >
                <Text style={{ color: colors.text }}>Decline</Text>
              </FeedbackTouchable>
            </View>
          </View>
        ) : null}

        {Array.isArray(event.participants) && event.participants.length > 0 ? (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.label}>Participants</Text>
            {event.participants.map((p: any) => {
              const statusBadge = rsvpStatusBadge(p.status);
              return (
              <View
                key={String(p.id ?? p.email)}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingVertical: 8,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.border,
                }}
              >
                <View style={{ flex: 1, gap: 6 }}>
                  <Text style={{ color: colors.text }}>{p.name || p.email}</Text>
                  {statusBadge ? (
                    <View style={[styles.statusPill, { backgroundColor: statusBadge.backgroundColor }]}>
                      <Text style={[styles.statusPillText, { color: statusBadge.color }]}>{statusBadge.label}</Text>
                    </View>
                  ) : (
                    <Text style={{ color: colors.textSecondary, fontSize: 12 }}>—</Text>
                  )}
                </View>
                {p.status === 'needs-action' && !p.is_organizer && canManageEvent && p.id ? (
                  <CalendarResendInviteButton
                    eventId={eventId}
                    participantId={p.id}
                    deviceOffline={deviceOffline}
                  />
                ) : null}
              </View>
              );
            })}
          </View>
        ) : null}

        {canManageEvent ? (
          <View style={{ marginTop: 24, gap: 10 }}>
            <TouchableOpacity style={styles.btn} onPress={handleEdit} accessibilityLabel="Edit event">
              <Text style={styles.btnText}>Edit event</Text>
            </TouchableOpacity>
            <FeedbackTouchable
              style={[styles.btn, styles.btnDanger]}
              onPress={handleCancelEvent}
              disabled={actionBusy != null}
              loading={actionBusy === 'cancel'}
              spinnerColor="#fff"
              accessibilityLabel="Cancel event"
            >
              <Text style={styles.btnText}>Cancel event</Text>
            </FeedbackTouchable>
          </View>
        ) : null}

        {canRemoveFromCalendar ? (
          <View style={{ marginTop: 24 }}>
            <FeedbackTouchable
              style={[styles.btn, styles.btnDanger]}
              onPress={handleRemoveFromCalendar}
              disabled={actionBusy != null}
              loading={actionBusy === 'remove'}
              spinnerColor="#fff"
              accessibilityLabel="Remove from my calendar"
            >
              <Text style={styles.btnText}>Remove from my calendar</Text>
            </FeedbackTouchable>
          </View>
        ) : null}
      </ScrollView>

      <MinimizableBottomSheet
        visible={notesOpen}
        onClose={() => setNotesOpen(false)}
        title="Notebook"
        heightRatio={0.92}
      >
        <View style={{ paddingHorizontal: 16, flex: 1 }}>
            {notesLoading ? <ActivityIndicator style={{ marginTop: 16 }} /> : null}
            {deviceOffline ? (
              <Text style={[styles.meta, { marginTop: 8 }]}>Notes are unavailable offline.</Text>
            ) : null}
            <ScrollView style={{ maxHeight: 220, marginTop: 12 }}>
              {notes.map((n) => (
                <View key={String(n.id)} style={{ marginBottom: 12, padding: 10, backgroundColor: colors.surface, borderRadius: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <Text style={{ fontWeight: '600', color: colors.text, flex: 1 }}>{n.title}</Text>
                    {n.id ? (
                      <ClientsButton itemType="note" itemId={Number(n.id)} compact />
                    ) : null}
                  </View>
                  <LinkifiedText
                    style={{ color: colors.textSecondary, marginTop: 4 }}
                    linkColor={colors.primary || '#007AFF'}
                  >
                    {n.content || ''}
                  </LinkifiedText>
                  {userNumericId != null && n.user_id === userNumericId ? (
                    <View style={{ flexDirection: 'row', marginTop: 8, gap: 12 }}>
                      <TouchableOpacity
                        onPress={() => {
                          setEditingNote(n);
                          setNewNoteTitle(n.title || '');
                          setNewNoteBody(n.content || '');
                        }}
                      >
                        <Text style={{ color: '#007AFF' }}>Edit</Text>
                      </TouchableOpacity>
                      <FeedbackTouchable
                        loading={deletingNoteId === n.id}
                        spinnerColor="#ef4444"
                        onPress={() => {
                          Alert.alert('Delete note', 'Remove this note?', [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Delete',
                              style: 'destructive',
                              onPress: async () => {
                                if (deviceOffline) {
                                  Alert.alert('Offline', 'Deleting notes requires a connection.');
                                  return;
                                }
                                setDeletingNoteId(n.id);
                                try {
                                  await noteDelete(n.id);
                                  await loadNotes();
                                } catch (e: any) {
                                  Alert.alert('Error', e?.response?.data?.error || 'Failed');
                                } finally {
                                  setDeletingNoteId(null);
                                }
                              },
                            },
                          ]);
                        }}
                      >
                        <Text style={{ color: '#ef4444' }}>Delete</Text>
                      </FeedbackTouchable>
                    </View>
                  ) : null}
                </View>
              ))}
            </ScrollView>
            <Text style={styles.label}>{editingNote ? 'Edit note' : 'New note'}</Text>
            <TextInput
              style={styles.input}
              placeholder="Title"
              placeholderTextColor={colors.textSecondary}
              value={newNoteTitle}
              onChangeText={setNewNoteTitle}
            />
            <TextInput
              style={[styles.input, { minHeight: 80 }]}
              placeholder="Content"
              placeholderTextColor={colors.textSecondary}
              multiline
              value={newNoteBody}
              onChangeText={setNewNoteBody}
            />
            <FeedbackTouchable
              style={styles.btn}
              onPress={saveNote}
              disabled={noteBusy}
              loading={noteBusy}
              spinnerColor="#fff"
            >
              <Text style={styles.btnText}>{editingNote ? 'Update note' : 'Add note'}</Text>
            </FeedbackTouchable>
            {editingNote ? (
              <TouchableOpacity
                onPress={() => {
                  setEditingNote(null);
                  setNewNoteTitle('');
                  setNewNoteBody('');
                }}
              >
                <Text style={{ color: '#007AFF', textAlign: 'center', marginTop: 8 }}>Cancel edit</Text>
              </TouchableOpacity>
            ) : null}
        </View>
      </MinimizableBottomSheet>
    </SafeAreaView>
  );
}
