import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Linking,
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
import AdaptiveListPickerModal from '../../components/AdaptiveListPickerModal';
import ShareAccessSheet from '../../components/share/ShareAccessSheet';
import { createBookingShareAdapter } from '../../components/share/resourceAdapters';
import { FRONTEND_URL } from '../../constants/Config';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  bookingCreateEventType,
  bookingDeactivateEventType,
  bookingGetProfile,
  bookingListEventTypes,
  bookingListForms,
  bookingListSignups,
  bookingUpdateProfile,
} from '../../services/bookingApi';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABELS: Record<(typeof DAYS)[number], string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};
const INTERVALS = [15, 30, 60];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Interval = { start: string; end: string };
type Hours = Record<string, Interval[]>;
type EventType = {
  id: number;
  name: string;
  public_path: string;
  duration_minutes: number;
  kind: string;
  active: boolean;
  form_id?: number | null;
  seat_limit?: number | null;
  add_reach_link?: boolean;
};
type Signup = {
  id: number;
  guest_name: string;
  guest_email: string;
  start_time: string;
  status: string;
  form_response_id?: number | null;
  form_response?: Record<string, unknown> | null;
};

function slugFromName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255);
}

function kindLabel(kind: string) {
  return kind === 'group' ? 'Group' : 'One-on-one';
}

function answerLines(response: Record<string, unknown> | null | undefined) {
  if (!response) return [];
  return Object.entries(response).map(([key, value]) => {
    const text = value != null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    return { key, text };
  });
}

export default function CalendarSchedulingScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const [types, setTypes] = useState<EventType[]>([]);
  const [forms, setForms] = useState<{ id: number; title: string }[]>([]);
  const [hours, setHours] = useState<Hours>({});
  const [timezone, setTimezone] = useState('UTC');
  const [interval, setInterval] = useState('30');
  const [notice, setNotice] = useState('0');
  const [windowDays, setWindowDays] = useState('60');
  const [bufferBefore, setBufferBefore] = useState('0');
  const [bufferAfter, setBufferAfter] = useState('0');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [duration, setDuration] = useState('30');
  const [seatLimit, setSeatLimit] = useState('5');
  const [addReach, setAddReach] = useState(false);
  const [kind, setKind] = useState<'one_on_one' | 'group'>('one_on_one');
  const [formId, setFormId] = useState<number | null>(null);
  const [formPickerOpen, setFormPickerOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<number | null>(null);
  const [accessTypeId, setAccessTypeId] = useState<number | null>(null);
  const [signups, setSignups] = useState<Signup[]>([]);
  const [message, setMessage] = useState('');
  const [savingHours, setSavingHours] = useState(false);
  const [creating, setCreating] = useState(false);

  const styles = useMemo(() => createStyles(colors), [colors]);

  const load = useCallback(async () => {
    const [profile, list, formList] = await Promise.all([
      bookingGetProfile(),
      bookingListEventTypes(),
      bookingListForms(),
    ]);
    const saved = profile.profile || {};
    setTimezone(saved.timezone || 'UTC');
    setHours(saved.weekly_hours || {});
    setInterval(String(saved.slot_interval_minutes ?? 30));
    setNotice(String(saved.minimum_notice_minutes ?? 0));
    setWindowDays(String(saved.booking_window_days ?? 60));
    setBufferBefore(String(saved.buffer_before_minutes ?? 0));
    setBufferAfter(String(saved.buffer_after_minutes ?? 0));
    setTypes(list.event_types || []);
    setForms(formList.forms || []);
  }, []);

  React.useEffect(() => {
    load().catch(() => setMessage('Could not load scheduling.'));
  }, [load]);

  const setDayIntervals = (day: string, next: Interval[]) => setHours({ ...hours, [day]: next });

  const formTitle = forms.find((form) => form.id === formId)?.title || 'No form';
  const slugInvalid = !!slug && !SLUG_RE.test(slug);
  const messageIsError = /could not/i.test(message);

  const saveHours = async () => {
    setSavingHours(true);
    try {
      await bookingUpdateProfile({
        timezone,
        weekly_hours: hours,
        slot_interval_minutes: Number(interval),
        minimum_notice_minutes: Number(notice),
        booking_window_days: Number(windowDays),
        buffer_before_minutes: Number(bufferBefore),
        buffer_after_minutes: Number(bufferAfter),
      });
      setMessage('Hours saved.');
    } catch (err: any) {
      setMessage(err?.response?.data?.error || 'Could not save hours.');
    } finally {
      setSavingHours(false);
    }
  };

  const createType = async () => {
    setCreating(true);
    try {
      await bookingCreateEventType({
        name,
        slug: slug.toLowerCase(),
        duration_minutes: Number(duration) || 30,
        kind,
        seat_limit: kind === 'group' ? Number(seatLimit) || 1 : null,
        form_id: formId,
        add_reach_link: addReach,
      });
      setName('');
      setSlug('');
      setSlugEdited(false);
      setMessage('Event type created.');
      await load();
    } catch (err: any) {
      setMessage(err?.response?.data?.error || 'Could not create this event type.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton onPress={() => router.back()} />
        <AppHeaderTitle>Scheduling</AppHeaderTitle>
        <View style={{ width: 40 }} />
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {message ? (
          <Text style={[styles.banner, messageIsError ? styles.bannerError : styles.bannerOk]}>{message}</Text>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Weekly hours</Text>
          <Text style={styles.sectionHint}>{timezone}</Text>
          {DAYS.map((day) => {
            const intervals = hours[day] || [];
            const open = intervals.length > 0;
            return (
              <View key={day} style={styles.dayRow}>
                <TouchableOpacity
                  style={styles.dayToggle}
                  onPress={() => {
                    if (open) setDayIntervals(day, []);
                    else setDayIntervals(day, [{ start: '09:00', end: '17:00' }]);
                  }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: open }}
                  accessibilityLabel={`${DAY_LABELS[day]} available`}
                >
                  <Ionicons
                    name={open ? 'checkbox' : 'square-outline'}
                    size={18}
                    color={open ? '#2563eb' : colors.textSecondary}
                  />
                  <Text style={styles.dayLabel}>{DAY_LABELS[day]}</Text>
                </TouchableOpacity>
                {!open ? (
                  <Text style={styles.unavailable}>Unavailable</Text>
                ) : (
                  <View style={styles.intervalCol}>
                    {intervals.map((row, index) => (
                      <View key={`${day}-${index}`} style={styles.intervalRow}>
                        <TextInput
                          style={styles.time}
                          value={row.start}
                          onChangeText={(start) =>
                            setDayIntervals(
                              day,
                              intervals.map((item, itemIndex) => (itemIndex === index ? { ...item, start } : item)),
                            )
                          }
                          autoCapitalize="none"
                          accessibilityLabel={`${DAY_LABELS[day]} start`}
                        />
                        <Text style={styles.dash}>–</Text>
                        <TextInput
                          style={styles.time}
                          value={row.end}
                          onChangeText={(end) =>
                            setDayIntervals(
                              day,
                              intervals.map((item, itemIndex) => (itemIndex === index ? { ...item, end } : item)),
                            )
                          }
                          autoCapitalize="none"
                          accessibilityLabel={`${DAY_LABELS[day]} end`}
                        />
                        <TouchableOpacity
                          onPress={() => setDayIntervals(day, intervals.filter((_, itemIndex) => itemIndex !== index))}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove ${DAY_LABELS[day]} hours`}
                          style={styles.removeBtn}
                        >
                          <Ionicons name="close" size={16} color={colors.textSecondary} />
                        </TouchableOpacity>
                      </View>
                    ))}
                    <TouchableOpacity
                      onPress={() => setDayIntervals(day, [...intervals, { start: '13:00', end: '17:00' }])}
                    >
                      <Text style={styles.link}>Add hours</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Booking rules</Text>
          <View style={styles.grid}>
            <View style={styles.field}>
              <Text style={styles.label}>Timezone</Text>
              <TextInput style={styles.input} value={timezone} onChangeText={setTimezone} autoCapitalize="none" />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Slot interval</Text>
              <View style={styles.chipRow}>
                {INTERVALS.map((minutes) => {
                  const on = interval === String(minutes);
                  return (
                    <TouchableOpacity
                      key={minutes}
                      style={[styles.chip, on && styles.chipOn]}
                      onPress={() => setInterval(String(minutes))}
                    >
                      <Text style={[styles.chipText, on && styles.chipTextOn]}>{minutes}m</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Min notice (min)</Text>
              <TextInput style={styles.input} value={notice} onChangeText={setNotice} keyboardType="number-pad" />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Window (days)</Text>
              <TextInput style={styles.input} value={windowDays} onChangeText={setWindowDays} keyboardType="number-pad" />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Buffer before</Text>
              <TextInput style={styles.input} value={bufferBefore} onChangeText={setBufferBefore} keyboardType="number-pad" />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Buffer after</Text>
              <TextInput style={styles.input} value={bufferAfter} onChangeText={setBufferAfter} keyboardType="number-pad" />
            </View>
          </View>
          <TouchableOpacity style={styles.button} onPress={() => void saveHours()} disabled={savingHours}>
            <Text style={styles.buttonText}>{savingHours ? 'Saving…' : 'Save hours'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>New event type</Text>
          <View style={styles.grid}>
            <View style={styles.field}>
              <Text style={styles.label}>Name</Text>
              <TextInput
                style={styles.input}
                placeholder="Intro call"
                placeholderTextColor={colors.textSecondary}
                value={name}
                onChangeText={(value) => {
                  setName(value);
                  if (!slugEdited) setSlug(slugFromName(value));
                }}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Link slug</Text>
              <TextInput
                style={styles.input}
                placeholder="intro-call"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                value={slug}
                onChangeText={(value) => {
                  const next = value.toLowerCase();
                  if (!next) {
                    setSlugEdited(false);
                    setSlug(slugFromName(name));
                    return;
                  }
                  setSlugEdited(true);
                  setSlug(next);
                }}
              />
            </View>
          </View>
          <View style={styles.pair}>
            <View style={styles.pairField}>
              <Text style={styles.label}>Duration (min)</Text>
              <TextInput style={styles.input} value={duration} onChangeText={setDuration} keyboardType="number-pad" />
            </View>
            {kind === 'group' ? (
              <View style={styles.pairField}>
                <Text style={styles.label}>Seats</Text>
                <TextInput style={styles.input} value={seatLimit} onChangeText={setSeatLimit} keyboardType="number-pad" />
              </View>
            ) : (
              <View style={styles.pairField} />
            )}
          </View>
          <View style={styles.pair}>
            <View style={styles.pairField}>
              <Text style={styles.label}>Kind</Text>
              <View style={styles.chipRow}>
                <TouchableOpacity
                  style={[styles.chip, kind === 'one_on_one' && styles.chipOn]}
                  onPress={() => setKind('one_on_one')}
                >
                  <Text style={[styles.chipText, kind === 'one_on_one' && styles.chipTextOn]}>1:1</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.chip, kind === 'group' && styles.chipOn]}
                  onPress={() => setKind('group')}
                >
                  <Text style={[styles.chipText, kind === 'group' && styles.chipTextOn]}>Group</Text>
                </TouchableOpacity>
              </View>
            </View>
            <TouchableOpacity style={styles.pairField} onPress={() => setFormPickerOpen(true)}>
              <Text style={styles.label}>Form</Text>
              <View style={styles.pickerField}>
                <Text style={styles.pickerValue} numberOfLines={1}>{formTitle}</Text>
                <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
              </View>
            </TouchableOpacity>
          </View>
          {slugInvalid ? (
            <Text style={styles.slugError}>Use lowercase letters, numbers, and hyphens, like intro-call.</Text>
          ) : null}
          <TouchableOpacity
            style={styles.checkRow}
            onPress={() => setAddReach((value) => !value)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: addReach }}
          >
            <Ionicons
              name={addReach ? 'checkbox' : 'square-outline'}
              size={18}
              color={addReach ? '#2563eb' : colors.textSecondary}
            />
            <Text style={styles.checkLabel}>Add a Reach meeting link</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, (!name.trim() || !SLUG_RE.test(slug) || creating) && styles.buttonDisabled]}
            disabled={!name.trim() || !SLUG_RE.test(slug) || creating}
            onPress={() => void createType()}
          >
            <Text style={styles.buttonText}>{creating ? 'Creating…' : 'Create event type'}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.listTitle}>Event types</Text>
        {types.length === 0 ? (
          <Text style={styles.empty}>No event types yet. Create one above to get a booking link.</Text>
        ) : (
          types.map((item) => {
            const open = selectedType === item.id;
            return (
              <View key={item.id} style={styles.card}>
                <View style={styles.typeHead}>
                  <Text style={styles.typeName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.badge}>{item.duration_minutes}m</Text>
                  <Text style={styles.badge}>{kindLabel(item.kind)}</Text>
                  {!item.active ? <Text style={styles.badgeMuted}>Inactive</Text> : null}
                </View>
                <Text style={styles.path} numberOfLines={1}>{item.public_path}</Text>
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.action}
                    onPress={async () => {
                      const base = FRONTEND_URL.replace(/\/$/, '');
                      await Clipboard.setStringAsync(`${base}${item.public_path}`);
                      setMessage('Link copied.');
                    }}
                  >
                    <Text style={styles.actionText}>Copy</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.action} onPress={() => setAccessTypeId(item.id)}>
                    <Text style={styles.actionText}>Share</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.action}
                    onPress={() => {
                      if (open) {
                        setSelectedType(null);
                        setSignups([]);
                        return;
                      }
                      setSelectedType(item.id);
                      bookingListSignups(item.id)
                        .then((data) => setSignups(data.signups || []))
                        .catch(() => Alert.alert('Scheduling', 'Could not load signups.'));
                    }}
                  >
                    <Text style={styles.actionText}>{open ? 'Hide' : 'Signups'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.action}
                    onPress={() => {
                      void bookingDeactivateEventType(item.id)
                        .then(load)
                        .catch((err: any) =>
                          Alert.alert('Scheduling', err?.response?.data?.error || 'Could not deactivate this event type.'),
                        );
                    }}
                  >
                    <Text style={styles.actionDanger}>Deactivate</Text>
                  </TouchableOpacity>
                </View>
                {open ? (
                  <View style={styles.signupBox}>
                    {signups.length === 0 ? (
                      <Text style={styles.unavailable}>No signups yet.</Text>
                    ) : (
                      signups.map((row) => {
                        const answers = answerLines(row.form_response);
                        return (
                          <View key={row.id} style={styles.signup}>
                            <Text style={styles.signupName} numberOfLines={1}>
                              {row.guest_name}
                              <Text style={styles.signupMeta}> · {row.status}</Text>
                            </Text>
                            <Text style={styles.signupMeta} numberOfLines={1}>{row.guest_email}</Text>
                            <Text style={styles.signupMeta}>{new Date(row.start_time).toLocaleString()}</Text>
                            {answers.map((answer) => (
                              <Text key={answer.key} style={styles.signupMeta} numberOfLines={2}>
                                {answer.key}: {answer.text}
                              </Text>
                            ))}
                            {row.form_response_id && item.form_id ? (
                              <TouchableOpacity
                                onPress={() =>
                                  Linking.openURL(`${FRONTEND_URL}/form-builder/${item.form_id}?response=${row.form_response_id}`)
                                }
                              >
                                <Text style={styles.link}>Form response</Text>
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        );
                      })
                    )}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>

      <AdaptiveListPickerModal
        visible={formPickerOpen}
        onClose={() => setFormPickerOpen(false)}
        title="Form"
        itemCount={forms.length + 1}
      >
        <TouchableOpacity
          style={styles.pickerItem}
          onPress={() => {
            setFormId(null);
            setFormPickerOpen(false);
          }}
        >
          <Text style={styles.pickerItemText}>No form</Text>
          {formId == null ? <Ionicons name="checkmark" size={18} color="#2563eb" /> : null}
        </TouchableOpacity>
        {forms.map((form) => (
          <TouchableOpacity
            key={form.id}
            style={styles.pickerItem}
            onPress={() => {
              setFormId(form.id);
              setFormPickerOpen(false);
            }}
          >
            <Text style={styles.pickerItemText} numberOfLines={1}>{form.title}</Text>
            {formId === form.id ? <Ionicons name="checkmark" size={18} color="#2563eb" /> : null}
          </TouchableOpacity>
        ))}
      </AdaptiveListPickerModal>

      <ShareAccessSheet
        visible={accessTypeId != null}
        adapter={accessTypeId != null ? createBookingShareAdapter(accessTypeId) : null}
        onClose={() => setAccessTypeId(null)}
      />
    </SafeAreaView>
  );
}

function createStyles(colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 8,
      paddingBottom: 4,
    },
    body: { paddingHorizontal: 12, paddingBottom: 28, gap: 10 },
    banner: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
    bannerOk: { backgroundColor: colors.isDark ? '#064e3b' : '#ecfdf5', color: colors.isDark ? '#a7f3d0' : '#065f46' },
    bannerError: { backgroundColor: colors.isDark ? '#450a0a' : '#fef2f2', color: colors.isDark ? '#fecaca' : '#991b1b' },
    card: {
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: 10,
      paddingVertical: 8,
      gap: 6,
    },
    sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
    sectionHint: { fontSize: 11, color: colors.textSecondary, marginTop: -4 },
    dayRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 3 },
    dayToggle: { width: 62, flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: 4 },
    dayLabel: { fontSize: 13, fontWeight: '600', color: colors.text },
    unavailable: { fontSize: 12, color: colors.textSecondary, paddingTop: 5 },
    intervalCol: { flex: 1, gap: 4 },
    intervalRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    time: {
      width: 72,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 4,
      fontSize: 13,
      color: colors.text,
      backgroundColor: colors.background,
      textAlign: 'center',
    },
    dash: { fontSize: 12, color: colors.textSecondary },
    removeBtn: { padding: 2 },
    link: { color: '#2563eb', fontSize: 12, fontWeight: '600' },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    pair: { flexDirection: 'row', gap: 8 },
    field: { width: '48%', flexGrow: 1, gap: 2 },
    pairField: { flex: 1, minWidth: 0, gap: 2 },
    label: { fontSize: 11, fontWeight: '600', color: colors.textSecondary },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      fontSize: 14,
      color: colors.text,
      backgroundColor: colors.background,
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
    chip: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 5,
      backgroundColor: colors.background,
    },
    chipOn: { borderColor: '#2563eb', backgroundColor: colors.isDark ? '#1e3a5f' : '#eff6ff' },
    chipText: { fontSize: 12, color: colors.text },
    chipTextOn: { color: '#2563eb', fontWeight: '700' },
    button: { backgroundColor: '#2563eb', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, alignSelf: 'flex-start' },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
    slugError: { fontSize: 11, color: '#dc2626' },
    pickerField: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      backgroundColor: colors.background,
    },
    pickerValue: { flex: 1, fontSize: 14, color: colors.text },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    checkLabel: { fontSize: 13, color: colors.text },
    listTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginTop: 2 },
    empty: { fontSize: 13, color: colors.textSecondary },
    typeHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    typeName: { fontSize: 14, fontWeight: '700', color: colors.text, flexShrink: 1 },
    badge: {
      fontSize: 11,
      color: colors.textSecondary,
      backgroundColor: colors.background,
      borderRadius: 8,
      overflow: 'hidden',
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    badgeMuted: {
      fontSize: 11,
      color: '#b45309',
      backgroundColor: colors.isDark ? '#451a03' : '#fffbeb',
      borderRadius: 8,
      overflow: 'hidden',
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    path: { fontSize: 12, color: colors.textSecondary },
    actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    action: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    actionText: { fontSize: 12, fontWeight: '600', color: colors.text },
    actionDanger: { fontSize: 12, fontWeight: '600', color: '#dc2626' },
    signupBox: { gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 6 },
    signup: { gap: 1 },
    signupName: { fontSize: 13, fontWeight: '600', color: colors.text },
    signupMeta: { fontSize: 12, fontWeight: '400', color: colors.textSecondary },
    pickerItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 4,
      gap: 8,
    },
    pickerItemText: { flex: 1, fontSize: 15, color: colors.text },
  });
}
