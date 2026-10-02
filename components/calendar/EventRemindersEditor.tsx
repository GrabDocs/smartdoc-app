import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  MAX_CALENDAR_REMINDERS,
  minutesFromParts,
  partsFromMinutes,
  type CalendarReminder,
  type ReminderMethod,
  type ReminderUnit,
} from '../../utils/calendarReminders';

type Colors = {
  text: string;
  textSecondary: string;
  border: string;
  tint: string;
  background: string;
};

type Props = {
  reminders: CalendarReminder[];
  onChange: (next: CalendarReminder[]) => void;
  colors: Colors;
};

const METHODS: ReminderMethod[] = ['notification', 'email', 'both'];
const UNITS: ReminderUnit[] = ['minutes', 'hours', 'days', 'weeks'];

const ROW_HEIGHT = 46;

function cycle<T>(list: T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length];
}

export default function EventRemindersEditor({ reminders, onChange, colors }: Props) {
  const [draftAmounts, setDraftAmounts] = useState<Record<number, string>>({});

  const update = (index: number, patch: Partial<CalendarReminder>) => {
    onChange(reminders.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  // Every row uses the same flex/fixed widths, so the method dropdown is the same size whether it says
  // "Notification", "Email" or "Both", and the amount / unit columns line up across rows.
  const box = {
    height: ROW_HEIGHT,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  return (
    <View style={{ gap: 10 }}>
      {reminders.map((row, index) => {
        const parts = partsFromMinutes(row.minutes);
        const amountText = draftAmounts[index] ?? String(parts.amount);
        return (
          <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity
              onPress={() => update(index, { method: cycle(METHODS, row.method) })}
              style={[box, { flex: 1.45 }]}
              accessibilityRole="button"
              accessibilityLabel="Reminder type"
            >
              <Text style={{ color: colors.text, fontSize: 15 }} numberOfLines={1}>
                {row.method === 'email' ? 'Email' : row.method === 'both' ? 'Both' : 'Notification'}
              </Text>
            </TouchableOpacity>
            <TextInput
              value={amountText}
              keyboardType="number-pad"
              onChangeText={(v) => setDraftAmounts((prev) => ({ ...prev, [index]: v }))}
              onEndEditing={() => {
                const amount = Number(draftAmounts[index] ?? parts.amount);
                update(index, { minutes: minutesFromParts(amount, parts.unit) });
                setDraftAmounts((prev) => {
                  const next = { ...prev };
                  delete next[index];
                  return next;
                });
              }}
              style={[box, { width: 64, color: colors.text, fontSize: 15, textAlign: 'center', paddingVertical: 0 }]}
            />
            <TouchableOpacity
              onPress={() => {
                const nextUnit = cycle(UNITS, parts.unit);
                update(index, { minutes: minutesFromParts(parts.amount, nextUnit) });
              }}
              style={[box, { flex: 1 }]}
              accessibilityRole="button"
              accessibilityLabel="Reminder unit"
            >
              <Text style={{ color: colors.text, fontSize: 15 }} numberOfLines={1}>
                {parts.unit}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onChange(reminders.filter((_, i) => i !== index))}
              style={{ width: 40, height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' }}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Remove reminder"
            >
              <Ionicons name="close" size={24} color="#ef4444" />
            </TouchableOpacity>
          </View>
        );
      })}
      {reminders.length < MAX_CALENDAR_REMINDERS ? (
        <TouchableOpacity
          onPress={() => onChange([...reminders, { minutes: 30, method: 'notification' }])}
          style={{ paddingVertical: 6 }}
        >
          <Text style={{ color: colors.tint, fontSize: 15 }}>Add notification</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
