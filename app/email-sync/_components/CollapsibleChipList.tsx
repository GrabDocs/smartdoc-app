import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../../../hooks/useThemeColors';

export function CollapsibleChipList({
  title,
  hint,
  value,
  onChange,
  placeholder,
  emptyLabel = 'None',
  defaultExpanded = false,
}: {
  title: string;
  hint?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  emptyLabel?: string;
  defaultExpanded?: boolean;
}) {
  const colors = useThemeColors();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [draft, setDraft] = useState('');
  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          marginHorizontal: 16,
          marginTop: 8,
          borderRadius: 12,
          overflow: 'hidden',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        },
        head: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 12,
          backgroundColor: colors.isDark ? 'rgba(255,255,255,0.04)' : '#F9FAFB',
        },
        title: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text },
        count: { fontSize: 13, color: colors.textSecondary },
        view: { fontSize: 13, fontWeight: '600', color: '#007AFF' },
        body: {
          padding: 12,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          backgroundColor: colors.surface,
        },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
        chip: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          backgroundColor: colors.isDark ? '#1e3a5f' : '#DBEAFE',
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 999,
        },
        chipTxt: { fontSize: 13, color: colors.isDark ? '#93C5FD' : '#1E40AF' },
        input: { color: colors.text, fontSize: 15, paddingVertical: 6 },
        hint: { fontSize: 12, color: colors.textSecondary, marginTop: 8, lineHeight: 16 },
      }),
    [colors]
  );

  const add = () => {
    const parts = draft
      .split(/[,;]+/)
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) {
      setDraft('');
      return;
    }
    const next = [...value];
    for (const t of parts) {
      if (!next.includes(t)) next.push(t);
    }
    if (next.length !== value.length) onChange(next);
    setDraft('');
  };

  return (
    <View style={styles.wrap}>
      <TouchableOpacity style={styles.head} onPress={() => setExpanded((v) => !v)} activeOpacity={0.7}>
        <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={16} color={colors.textSecondary} />
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.count}>{value.length > 0 ? String(value.length) : emptyLabel}</Text>
        <Text style={styles.view}>{expanded ? 'Hide' : 'View'}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.body}>
          <View style={styles.chips}>
            {value.map((chip) => (
              <TouchableOpacity
                key={chip}
                style={styles.chip}
                onPress={() => onChange(value.filter((c) => c !== chip))}
              >
                <Text style={styles.chipTxt}>{chip}</Text>
                <Ionicons name="close" size={12} color={colors.isDark ? '#93C5FD' : '#1E40AF'} />
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            autoFocus
            style={styles.input}
            value={draft}
            onChangeText={(t) => {
              if (t.includes(',')) {
                const parts = t.split(',');
                const last = parts.pop() || '';
                const next = [...value];
                for (const p of parts) {
                  const n = p.trim().toLowerCase();
                  if (n && !next.includes(n)) next.push(n);
                }
                onChange(next);
                setDraft(last);
                return;
              }
              setDraft(t);
            }}
            placeholder={placeholder}
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={add}
            onBlur={add}
            returnKeyType="done"
          />
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
