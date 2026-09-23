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

function cycle<T>(list: T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length];
}

export default function EventRemindersEditor({ reminders, onChange, colors }: Props) {
  const [draftAmounts, setDraftAmounts] = useState<Record<number, string>>({});

  const update = (index: number, patch: Partial<CalendarReminder>) => {
    onChange(reminders.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <View style={{ gap: 8 }}>
      {reminders.map((row, index) => {
        const parts = partsFromMinutes(row.minutes);
        const amountText = draftAmounts[index] ?? String(parts.amount);
        return (
          <View key={index} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <TouchableOpacity
              onPress={() => update(index, { method: cycle(METHODS, row.method) })}
              style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6 }}
            >
              <Text style={{ color: colors.text, fontSize: 12 }}>
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
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 8,
                paddingHorizontal: 8,
                paddingVertical: 6,
                minWidth: 48,
                color: colors.text,
                fontSize: 13,
              }}
            />
            <TouchableOpacity
              onPress={() => {
                const nextUnit = cycle(UNITS, parts.unit);
                update(index, { minutes: minutesFromParts(parts.amount, nextUnit) });
              }}
              style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6 }}
            >
              <Text style={{ color: colors.text, fontSize: 12 }}>{parts.unit}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onChange(reminders.filter((_, i) => i !== index))}>
              <Text style={{ color: '#ef4444', fontSize: 12 }}>Remove</Text>
            </TouchableOpacity>
          </View>
        );
      })}
      {reminders.length < MAX_CALENDAR_REMINDERS ? (
        <TouchableOpacity onPress={() => onChange([...reminders, { minutes: 30, method: 'notification' }])}>
          <Text style={{ color: colors.tint, fontSize: 13 }}>Add notification</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
