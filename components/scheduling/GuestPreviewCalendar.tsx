import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AdaptiveListPickerModal from '../AdaptiveListPickerModal';
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

function monthStart(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function parseIsoDateLocal(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d);
}

function addDaysLocal(value: Date, days: number) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

/** Months guests can reach from booking window + optional Available from/until. */
function guestMonthBounds(settings: Record<string, unknown>, timeZone: string) {
  const zone =
    (typeof settings.timezone === 'string' && settings.timezone.trim()) || timeZone || 'UTC';
  const todayKey = dayKeyInZone(new Date(), zone);
  const today = parseIsoDateLocal(todayKey) || new Date();
  const windowDays = Math.max(1, Math.min(365, Number(settings.booking_window_days) || 1));
  let first = today;
  let last = addDaysLocal(today, windowDays - 1);
  const periodStart = parseIsoDateLocal(settings.availability_start_date);
  const periodEnd = parseIsoDateLocal(settings.availability_end_date);
  if (periodStart && periodStart > first) first = periodStart;
  if (periodEnd && periodEnd < last) last = periodEnd;
  if (last < first) last = first;
  return { minMonth: monthStart(first), maxMonth: monthStart(last) };
}

function clampMonth(value: Date, minMonth: Date, maxMonth: Date) {
  const start = monthStart(value);
  if (start < minMonth) return minMonth;
  if (start > maxMonth) return maxMonth;
  return start;
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
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [timezone, setTimezone] = useState('UTC');
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedDay, setSelectedDay] = useState('');
  const requestId = useRef(0);
  const settingsKey = JSON.stringify(settings);
  const { minMonth, maxMonth } = useMemo(
    () => guestMonthBounds(settings, timezone),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsKey, timezone],
  );
  const canGoPrev = monthStart(month) > minMonth;
  const canGoNext = monthStart(month) < maxMonth;
  const atFutureLimit = !canGoNext;
  const selectedType = activeTypes.find((t) => t.id === typeId);
  const selectedLabel = selectedType
    ? `${selectedType.name} (${selectedType.duration_minutes} min)`
    : 'Choose event type';

  useEffect(() => {
    if (typeId == null || !activeTypes.some((t) => t.id === typeId)) setTypeId(activeTypes[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIds]);

  useEffect(() => {
    setMonth((current) => clampMonth(current, minMonth, maxMonth));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minMonth.getTime(), maxMonth.getTime()]);

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
      <TouchableOpacity
        style={styles.dropdown}
        onPress={() => setTypePickerOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Event type to preview"
      >
        <Text style={styles.dropdownText} numberOfLines={1}>{selectedLabel}</Text>
        <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
      </TouchableOpacity>
      <AdaptiveListPickerModal
        visible={typePickerOpen}
        onClose={() => setTypePickerOpen(false)}
        title="Event type"
        itemCount={activeTypes.length}
      >
        {activeTypes.map((t) => {
          const selected = t.id === typeId;
          return (
            <TouchableOpacity
              key={t.id}
              style={[styles.pickerItem, selected && styles.pickerItemSelected]}
              onPress={() => {
                setTypeId(t.id);
                setTypePickerOpen(false);
              }}
            >
              <Text style={[styles.pickerItemText, selected && styles.pickerItemTextSelected]}>
                {t.name} ({t.duration_minutes} min)
              </Text>
            </TouchableOpacity>
          );
        })}
      </AdaptiveListPickerModal>
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
          style={[styles.navButton, !canGoPrev && styles.navButtonDisabled]}
          disabled={!canGoPrev}
          onPress={() => setMonth((current) => clampMonth(new Date(current.getFullYear(), current.getMonth() - 1, 1), minMonth, maxMonth))}
        >
          <Text style={[styles.navText, !canGoPrev && styles.navTextDisabled]}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.monthLabel}>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
        <TouchableOpacity
          accessibilityLabel="Next month"
          style={[styles.navButton, !canGoNext && styles.navButtonDisabled]}
          disabled={!canGoNext}
          onPress={() => setMonth((current) => clampMonth(new Date(current.getFullYear(), current.getMonth() + 1, 1), minMonth, maxMonth))}
        >
          <Text style={[styles.navText, !canGoNext && styles.navTextDisabled]}>›</Text>
        </TouchableOpacity>
      </View>
      {atFutureLimit ? (
        <Text style={styles.limitHint}>Past your booking window — guests will not see times beyond this month.</Text>
      ) : null}
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
    dropdown: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 8,
      backgroundColor: colors.card,
    },
    dropdownText: { flex: 1, fontSize: 14, color: colors.text, fontWeight: '500' },
    pickerItem: { paddingHorizontal: 16, paddingVertical: 12 },
    pickerItemSelected: { backgroundColor: colors.isDark ? 'rgba(59,130,246,0.2)' : '#eff6ff' },
    pickerItemText: { fontSize: 15, color: colors.text },
    pickerItemTextSelected: { fontWeight: '600', color: colors.isDark ? '#bfdbfe' : '#1d4ed8' },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
    problem: { fontSize: 12, color: colors.isDark ? '#fecaca' : '#991b1b', marginBottom: 6 },
    monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
    navButton: { paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 6 },
    navButtonDisabled: { opacity: 0.4 },
    navText: { fontSize: 16, color: colors.text },
    navTextDisabled: { color: colors.textSecondary },
    monthLabel: { fontSize: 14, fontWeight: '600', color: colors.text },
    limitHint: { fontSize: 11, color: colors.textSecondary, marginBottom: 6 },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    cell: { width: `${100 / 7}%` as `${number}%`, alignItems: 'center', paddingVertical: 2 },
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
