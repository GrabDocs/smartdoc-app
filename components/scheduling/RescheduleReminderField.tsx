import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import React, { useState } from 'react';
import { Platform, Text, TouchableOpacity, View } from 'react-native';

const LEAD_MS = 5 * 60 * 1000;

export function reminderWindow(appointmentStart?: string | null, now = Date.now()) {
  const startMs = appointmentStart ? Date.parse(appointmentStart) : NaN;
  if (!Number.isFinite(startMs)) return null;
  const earliestMs = now + LEAD_MS;
  const latestMs = startMs - 60 * 1000;
  if (latestMs <= earliestMs) return null;
  return { earliestMs, latestMs };
}

export function defaultReminderDate(appointmentStart?: string | null, now = Date.now()) {
  const window = reminderWindow(appointmentStart, now);
  if (!window) return null;
  const preferred = now + 24 * 60 * 60 * 1000;
  return new Date(Math.min(Math.max(preferred, window.earliestMs), window.latestMs));
}

type Props = {
  appointmentStart?: string | null;
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  value: Date | null;
  onChange: (value: Date) => void;
  disabled?: boolean;
  textColor: string;
  secondaryColor: string;
};

export default function RescheduleReminderField({
  appointmentStart,
  enabled,
  onEnabledChange,
  value,
  onChange,
  disabled,
  textColor,
  secondaryColor,
}: Props) {
  const window = reminderWindow(appointmentStart);
  const [iosOpen, setIosOpen] = useState(false);

  const toggle = () => {
    if (!window || disabled) return;
    const next = !enabled;
    onEnabledChange(next);
    if (next && !value) {
      const picked = defaultReminderDate(appointmentStart);
      if (picked) onChange(picked);
    }
  };

  const chooseTime = () => {
    if (!window || disabled) return;
    const current = value || new Date(window.earliestMs);
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: current,
        mode: 'date',
        minimumDate: new Date(window.earliestMs),
        maximumDate: new Date(window.latestMs),
        onChange: (event, date) => {
          if (event.type !== 'set' || !date) return;
          DateTimePickerAndroid.open({
            value: current,
            mode: 'time',
            is24Hour: false,
            onChange: (timeEvent, time) => {
              if (timeEvent.type !== 'set' || !time) return;
              const next = new Date(date);
              next.setHours(time.getHours(), time.getMinutes(), 0, 0);
              const clamped = Math.min(Math.max(next.getTime(), window.earliestMs), window.latestMs);
              onChange(new Date(clamped));
            },
          });
        },
      });
      return;
    }
    setIosOpen(true);
  };

  return (
    <View style={{ marginTop: 12 }}>
      <TouchableOpacity
        onPress={toggle}
        disabled={disabled || !window}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: enabled, disabled: disabled || !window }}
      >
        <Ionicons
          name={enabled && window ? 'checkbox' : 'square-outline'}
          size={20}
          color={enabled && window ? '#2563eb' : secondaryColor}
        />
        <Text style={{ color: textColor, flex: 1 }}>
          Remind them if they haven't rebooked
        </Text>
      </TouchableOpacity>
      {!window ? (
        <Text style={{ color: secondaryColor, fontSize: 12, marginTop: 4 }}>
          This appointment is too soon to schedule a reminder.
        </Text>
      ) : enabled ? (
        <View style={{ marginTop: 8 }}>
          <TouchableOpacity onPress={chooseTime} disabled={disabled} accessibilityRole="button">
            <Text style={{ color: '#2563eb' }}>
              {value ? value.toLocaleString() : 'Choose a time'}
            </Text>
          </TouchableOpacity>
          <Text style={{ color: secondaryColor, fontSize: 12, marginTop: 4 }}>
            Sent only if they still haven't picked a new time. Must be before the current appointment.
          </Text>
          {Platform.OS === 'ios' && iosOpen ? (
            <DateTimePicker
              value={value || new Date(window.earliestMs)}
              mode="datetime"
              minimumDate={new Date(window.earliestMs)}
              maximumDate={new Date(window.latestMs)}
              onChange={(_, date) => {
                if (date) onChange(date);
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
