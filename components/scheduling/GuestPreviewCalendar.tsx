import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { bookingPreviewSlots } from '../../services/bookingApi';

type PreviewType = { id: number; name: string; duration_minutes: number; active: boolean };
type Slot = { start_time: string; end_time: string; seats_remaining?: number };

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const FORM_PROBLEM_TEXT: Record<string, string> = {
  deleted: 'The linked form was deleted, so guests see "not accepting bookings".',
  unpublished: 'The linked form is unpublished, so guests see "not accepting bookings".',
};

function dayKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function dayKeyInZone(value: Date, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  } catch {
    return dayKey(value);
  }
}

function clockInZone(iso: string, timeZone: string) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { timeZone, hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(iso).toLocaleTimeString();
  }
}

function calendarCells(month: Date) {
  const offset = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  return Array.from({ length: 42 }, (_, index) => new Date(month.getFullYear(), month.getMonth(), 1 - offset + index));
}

/** Shows the exact slots guests would get if the host saved `settings` now. */
export default function GuestPreviewCalendar({
  types,
  settings,
}: {
  types: PreviewType[];
  settings: Record<string, unknown>;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const activeTypes = types.filter((t) => t.active);
  const activeIds = activeTypes.map((t) => t.id).join(',');
  const [typeId, setTypeId] = useState<number | null>(activeTypes[0]?.id ?? null);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [timezone, setTimezone] = useState('UTC');
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedDay, setSelectedDay] = useState('');
  const requestId = useRef(0);
  const settingsKey = JSON.stringify(settings);

  useEffect(() => {
    if (typeId == null || !activeTypes.some((t) => t.id === typeId)) setTypeId(activeTypes[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIds]);

  useEffect(() => {
    if (typeId == null) return;
    const id = ++requestId.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
        const res = await bookingPreviewSlots({
          event_type_id: typeId,
          start: month.toISOString(),
          end: end.toISOString(),
          settings: JSON.parse(settingsKey),
        });
        if (id !== requestId.current) return;
        setSlots(res?.slots || []);
        setTimezone(res?.timezone || 'UTC');
        setFormProblem(res?.form_problem || null);
        setError('');
      } catch (err: any) {
        if (id !== requestId.current) return;
        setSlots([]);
        setError(err?.response?.data?.error || 'Could not load the preview.');
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [typeId, month, settingsKey]);

  const slotsByDay = useMemo(() => {
    const grouped = new Map<string, Slot[]>();
    slots.forEach((slot) => {
      const key = dayKeyInZone(new Date(slot.start_time), timezone);
      grouped.set(key, [...(grouped.get(key) || []), slot]);
    });
    return grouped;
  }, [slots, timezone]);

  useEffect(() => {
    setSelectedDay((current) => (current && slotsByDay.has(current) ? current : Array.from(slotsByDay.keys()).sort()[0] || ''));
  }, [slotsByDay]);

  if (!activeTypes.length) {
    return <Text style={styles.muted}>Create or turn on an event type to preview the guest calendar.</Text>;
  }

  const daySlots = selectedDay ? slotsByDay.get(selectedDay) || [] : [];

  return (
    <View>
      <View style={styles.chips}>
        {activeTypes.map((t) => (
          <TouchableOpacity
            key={t.id}
            style={[styles.chip, t.id === typeId && styles.chipActive]}
            onPress={() => setTypeId(t.id)}
          >
            <Text style={[styles.chipText, t.id === typeId && styles.chipTextActive]}>
              {t.name} ({t.duration_minutes}m)
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.statusRow}>
        {loading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        <Text style={styles.muted}>
          {loading
            ? 'Loading what guests see…'
            : `${slotsByDay.size} day${slotsByDay.size === 1 ? '' : 's'} with times this month · ${timezone}`}
        </Text>
      </View>
      {formProblem ? <Text style={styles.problem}>{FORM_PROBLEM_TEXT[formProblem] || 'Guests cannot book this event right now.'}</Text> : null}
      {error ? <Text style={styles.problem}>{error}</Text> : null}
      <View style={[styles.monthRow, loading && styles.dim]}>
        <TouchableOpacity
          accessibilityLabel="Previous month"
          style={styles.navButton}
          onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
        >
          <Text style={styles.navText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.monthLabel}>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
        <TouchableOpacity
          accessibilityLabel="Next month"
          style={styles.navButton}
          onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        >
          <Text style={styles.navText}>›</Text>
        </TouchableOpacity>
      </View>
      <View style={[styles.grid, loading && styles.dim]}>
        {WEEKDAYS.map((label, index) => (
          <Text key={`${label}-${index}`} style={[styles.cell, styles.weekday]}>{label}</Text>
        ))}
        {calendarCells(month).map((day) => {
          const key = dayKey(day);
          const inMonth = day.getMonth() === month.getMonth();
          const open = inMonth && slotsByDay.has(key);
          const active = key === selectedDay;
          return (
            <TouchableOpacity key={key} disabled={!open} onPress={() => setSelectedDay(key)} style={styles.cell}>
              <View style={[styles.dayInner, open && styles.dayOpen, active && styles.dayActive]}>
                <Text style={[styles.dayText, !inMonth && styles.dayOut, open && styles.dayOpenText, active && styles.dayActiveText]}>
                  {day.getDate()}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.dayHeading}>
        {selectedDay
          ? new Date(`${selectedDay}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
          : 'No times this month'}
      </Text>
      <View style={styles.times}>
        {daySlots.map((slot) => (
          <Text key={slot.start_time} style={styles.time}>
            {clockInZone(slot.start_time, timezone)}
            {slot.seats_remaining != null ? ` · ${slot.seats_remaining} left` : ''}
          </Text>
        ))}
      </View>
    </View>
  );
}

function createStyles(colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    muted: { fontSize: 12, color: colors.textSecondary },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
    chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
    chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: { fontSize: 12, color: colors.text },
    chipTextActive: { color: '#fff', fontWeight: '600' },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
    problem: { fontSize: 12, color: colors.isDark ? '#fecaca' : '#991b1b', marginBottom: 6 },
    monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
    navButton: { paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 6 },
    navText: { fontSize: 16, color: colors.text },
    monthLabel: { fontSize: 14, fontWeight: '600', color: colors.text },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    cell: { width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 2 },
    weekday: { fontSize: 11, color: colors.textSecondary, textAlign: 'center' },
    dayInner: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    dayOpen: { backgroundColor: colors.isDark ? 'rgba(59,130,246,0.25)' : '#eff6ff' },
    dayActive: { backgroundColor: colors.primary },
    dayText: { fontSize: 13, color: colors.textSecondary },
    dayOut: { opacity: 0.35 },
    dayOpenText: { color: colors.isDark ? '#bfdbfe' : '#1d4ed8', fontWeight: '600' },
    dayActiveText: { color: '#fff' },
    dayHeading: { fontSize: 12, fontWeight: '600', color: colors.text, marginTop: 8 },
    times: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
    time: {
      fontSize: 12,
      color: colors.text,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    dim: { opacity: 0.6 },
  });
}
