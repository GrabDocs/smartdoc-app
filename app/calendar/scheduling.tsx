import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
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

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
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
  form_response?: unknown;
};

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
  const [duration, setDuration] = useState('30');
  const [seatLimit, setSeatLimit] = useState('5');
  const [addReach, setAddReach] = useState(false);
  const [kind, setKind] = useState<'one_on_one' | 'group'>('one_on_one');
  const [formId, setFormId] = useState<number | null>(null);
  const [selectedType, setSelectedType] = useState<number | null>(null);
  const [accessTypeId, setAccessTypeId] = useState<number | null>(null);
  const [signups, setSignups] = useState<Signup[]>([]);

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

  React.useEffect(() => { load().catch(() => Alert.alert('Scheduling', 'Could not load scheduling.')); }, [load]);

  const setDayIntervals = (day: string, next: Interval[]) => setHours({ ...hours, [day]: next });

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton onPress={() => router.back()} />
        <AppHeaderTitle>Scheduling</AppHeaderTitle>
        <View style={{ width: 40 }} />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={{ color: colors.text }}>Weekly hours ({timezone})</Text>
        <TextInput style={styles.input} value={timezone} onChangeText={setTimezone} autoCapitalize="none" />
        {DAYS.map((day) => {
          const intervals = hours[day] || [];
          const open = intervals.length > 0;
          return (
            <View key={day} style={styles.day}>
              <View style={styles.row}>
                <Text style={{ color: colors.text, width: 40 }}>{day}</Text>
                <Switch
                  value={open}
                  onValueChange={(value) => {
                    if (!value) setDayIntervals(day, []);
                    else if (intervals.length === 0) setDayIntervals(day, [{ start: '09:00', end: '17:00' }]);
                  }}
                />
              </View>
              {intervals.map((row, index) => (
                <View key={`${day}-${index}`} style={styles.row}>
                  <TextInput
                    style={styles.time}
                    value={row.start}
                    onChangeText={(start) => setDayIntervals(day, intervals.map((item, itemIndex) => itemIndex === index ? { ...item, start } : item))}
                  />
                  <TextInput
                    style={styles.time}
                    value={row.end}
                    onChangeText={(end) => setDayIntervals(day, intervals.map((item, itemIndex) => itemIndex === index ? { ...item, end } : item))}
                  />
                </View>
              ))}
              {open && (
                <TouchableOpacity onPress={() => setDayIntervals(day, [...intervals, { start: '13:00', end: '17:00' }])}>
                  <Text style={styles.link}>Add hours</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}
        <Text style={{ color: colors.text }}>Slot interval (15, 30, or 60)</Text>
        <TextInput style={styles.input} value={interval} onChangeText={setInterval} keyboardType="number-pad" />
        <Text style={{ color: colors.text }}>Minimum notice (minutes)</Text>
        <TextInput style={styles.input} value={notice} onChangeText={setNotice} keyboardType="number-pad" />
        <Text style={{ color: colors.text }}>Booking window (days)</Text>
        <TextInput style={styles.input} value={windowDays} onChangeText={setWindowDays} keyboardType="number-pad" />
        <Text style={{ color: colors.text }}>Buffer before (minutes)</Text>
        <TextInput style={styles.input} value={bufferBefore} onChangeText={setBufferBefore} keyboardType="number-pad" />
        <Text style={{ color: colors.text }}>Buffer after (minutes)</Text>
        <TextInput style={styles.input} value={bufferAfter} onChangeText={setBufferAfter} keyboardType="number-pad" />
        <TouchableOpacity
          style={styles.button}
          onPress={async () => {
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
              Alert.alert('Scheduling', 'Hours saved.');
            } catch (err: any) {
              Alert.alert('Scheduling', err?.response?.data?.error || 'Could not save hours.');
            }
          }}
        >
          <Text style={styles.buttonText}>Save hours</Text>
        </TouchableOpacity>

        <TextInput style={styles.input} placeholder="Event name" value={name} onChangeText={setName} />
        <TextInput style={styles.input} placeholder="link-slug" autoCapitalize="none" value={slug} onChangeText={(value) => setSlug(value.toLowerCase())} />
        <Text style={{ color: colors.text }}>Duration (minutes)</Text>
        <TextInput style={styles.input} value={duration} onChangeText={setDuration} keyboardType="number-pad" />
        <View style={styles.row}>
          <TouchableOpacity onPress={() => setKind('one_on_one')}><Text style={{ color: kind === 'one_on_one' ? '#2563eb' : colors.text }}>One-on-one</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => setKind('group')}><Text style={{ color: kind === 'group' ? '#2563eb' : colors.text }}>Group</Text></TouchableOpacity>
        </View>
        {kind === 'group' && (
          <>
            <Text style={{ color: colors.text }}>Seats</Text>
            <TextInput style={styles.input} value={seatLimit} onChangeText={setSeatLimit} keyboardType="number-pad" />
          </>
        )}
        <View style={styles.row}>
          <Text style={{ color: colors.text }}>Add Reach link</Text>
          <Switch value={addReach} onValueChange={setAddReach} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <TouchableOpacity onPress={() => setFormId(null)} style={styles.chip}><Text>No form</Text></TouchableOpacity>
          {forms.map((form) => (
            <TouchableOpacity key={form.id} onPress={() => setFormId(form.id)} style={styles.chip}>
              <Text style={{ color: formId === form.id ? '#2563eb' : '#111' }}>{form.title}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity
          style={styles.button}
          onPress={async () => {
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
              await load();
            } catch (err: any) {
              Alert.alert('Scheduling', err?.response?.data?.error || 'Could not create this event type.');
            }
          }}
        >
          <Text style={styles.buttonText}>Create link</Text>
        </TouchableOpacity>
        {types.map((item) => (
          <View key={item.id} style={styles.card}>
            <Text style={{ color: colors.text }}>{item.name} · {item.duration_minutes}m · {item.kind}{item.kind === 'group' ? ` · ${item.seat_limit || 1} seats` : ''}{item.add_reach_link ? ' · Reach' : ''}{item.active ? '' : ' · inactive'}</Text>
            <TouchableOpacity onPress={() => setAccessTypeId(item.id)}>
              <Text style={styles.link}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => {
              setSelectedType(item.id);
              bookingListSignups(item.id).then((data) => setSignups(data.signups || []));
            }}>
              <Text style={styles.link}>View signups</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => bookingDeactivateEventType(item.id).then(load)}>
              <Text style={styles.link}>Deactivate</Text>
            </TouchableOpacity>
          </View>
        ))}
        {signups.map((row) => {
          const formForType = types.find((item) => item.id === selectedType)?.form_id;
          return (
            <View key={row.id} style={styles.card}>
              <Text style={{ color: colors.text }}>
                {row.guest_name} ({row.guest_email}) · {row.status} · {new Date(row.start_time).toLocaleString()}
                {row.form_response ? ` · ${JSON.stringify(row.form_response)}` : ''}
              </Text>
              {row.form_response_id && formForType ? (
                <TouchableOpacity onPress={() => Linking.openURL(`${FRONTEND_URL}/form-builder/${formForType}?response=${row.form_response_id}`)}>
                  <Text style={styles.link}>Form response</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      <ShareAccessSheet
        visible={accessTypeId != null}
        adapter={accessTypeId != null ? createBookingShareAdapter(accessTypeId) : null}
        onClose={() => setAccessTypeId(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  body: { padding: 16, gap: 10 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10 },
  time: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 6, width: 80 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  day: { gap: 6 },
  button: { backgroundColor: '#2563eb', borderRadius: 8, padding: 12 },
  buttonText: { color: '#fff', textAlign: 'center' },
  card: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, gap: 4 },
  link: { color: '#2563eb' },
  chip: { borderWidth: 1, borderColor: '#ddd', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8 },
});
