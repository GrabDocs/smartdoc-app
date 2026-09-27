import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { summarizeMeetingChat } from '../../utils/parseMeetingChat';

const AVATAR_COLORS = ['#8b5cf6', '#0ea5e9', '#14b8a6', '#f59e0b', '#f43f5e', '#6366f1'];

function speakerColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

export default function MeetingChatView({ chatContent }: { chatContent?: string | null }) {
  const colors = useThemeColors();
  const summary = useMemo(() => summarizeMeetingChat(chatContent), [chatContent]);
  const [query, setQuery] = useState('');
  const [senderFilter, setSenderFilter] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return summary.messages.filter((message) => {
      if (senderFilter && message.sender !== senderFilter) return false;
      if (!needle) return true;
      return (
        message.content.toLowerCase().includes(needle) ||
        message.sender.toLowerCase().includes(needle) ||
        message.timestamp.includes(needle)
      );
    });
  }, [summary.messages, query, senderFilter]);

  if (!summary.messageCount) return null;

  const metrics = [
    { label: 'Messages', value: String(summary.messageCount) },
    { label: 'People', value: String(summary.senderCount) },
    { label: 'Words', value: String(summary.wordCount) },
    summary.spanLabel ? { label: 'Span', value: summary.spanLabel } : null,
    summary.senders[0] ? { label: 'Most active', value: summary.senders[0].sender } : null,
    summary.firstTimestamp && summary.lastTimestamp
      ? { label: 'Window', value: `${summary.firstTimestamp}–${summary.lastTimestamp}` }
      : null,
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <View style={{ gap: 12 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.metrics}>
        {metrics.map((metric) => (
          <View
            key={metric.label}
            style={[styles.metric, { backgroundColor: colors.inputBackground || colors.surface, borderColor: colors.border }]}
          >
            <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{metric.label}</Text>
            <Text style={[styles.metricValue, { color: colors.text }]}>{metric.value}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={[styles.card, { backgroundColor: colors.surface || colors.card, borderColor: colors.border }]}>
        <Text style={[styles.section, { color: colors.textSecondary }]}>By sender</Text>
        {summary.senders.map((row) => (
          <TouchableOpacity
            key={row.sender}
            onPress={() => setSenderFilter((prev) => (prev === row.sender ? null : row.sender))}
            style={[
              styles.senderRow,
              senderFilter === row.sender ? { backgroundColor: colors.inputBackground || colors.border, borderRadius: 8, padding: 6 } : null,
            ]}
          >
            <View style={styles.senderHeader}>
              <Text style={[styles.senderName, { color: colors.text }]} numberOfLines={1}>
                {row.sender}
              </Text>
              <Text style={[styles.senderMeta, { color: colors.textSecondary }]}>
                {row.messages} · {row.percent}%
              </Text>
            </View>
            <View style={[styles.track, { backgroundColor: colors.inputBackground || colors.border }]}>
              <View style={[styles.fill, { width: `${row.percent}%`, backgroundColor: speakerColor(row.sender) }]} />
            </View>
          </TouchableOpacity>
        ))}
      </View>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search chat"
        placeholderTextColor={colors.textSecondary}
        style={[
          styles.search,
          { color: colors.text, backgroundColor: colors.inputBackground || colors.surface, borderColor: colors.border },
        ]}
      />
      {senderFilter ? (
        <TouchableOpacity
          onPress={() => setSenderFilter(null)}
          style={[styles.filterChip, { backgroundColor: colors.inputBackground || colors.surface }]}
        >
          <Text style={[styles.filterChipText, { color: colors.text }]}>{senderFilter}</Text>
          <Text style={{ color: colors.textSecondary }}> ×</Text>
        </TouchableOpacity>
      ) : null}

      {visible.map((message, index) => (
        <View key={`${message.timestamp}-${message.sender}-${index}`} style={styles.message}>
          <View style={[styles.avatar, { backgroundColor: speakerColor(message.sender) }]}>
            <Text style={styles.avatarText}>{initials(message.sender)}</Text>
          </View>
          <View style={[styles.bubble, { backgroundColor: colors.inputBackground || colors.surface }]}>
            <View style={styles.meta}>
              <Text style={[styles.name, { color: colors.text }]}>{message.sender}</Text>
              <Text style={[styles.time, { color: colors.textSecondary }]}>{message.timestamp}</Text>
            </View>
            <Text style={[styles.body, { color: colors.text }]}>{message.content}</Text>
          </View>
        </View>
      ))}
      {!visible.length ? (
        <Text style={[styles.empty, { color: colors.textSecondary }]}>No matching messages</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  metrics: { gap: 8, paddingRight: 8 },
  metric: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, minWidth: 88 },
  metricLabel: { fontSize: 10, fontWeight: '600', textTransform: 'uppercase' },
  metricValue: { fontSize: 15, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
  card: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 10 },
  section: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  senderRow: { gap: 6 },
  senderHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  senderName: { flex: 1, fontSize: 13 },
  senderMeta: { fontSize: 12, fontVariant: ['tabular-nums'] },
  track: { height: 6, borderRadius: 999, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 999 },
  search: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  filterChip: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  filterChipText: { fontSize: 12, fontWeight: '600' },
  message: { flexDirection: 'row', gap: 10 },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  bubble: { flex: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  name: { fontSize: 12, fontWeight: '700' },
  time: { fontSize: 11, fontVariant: ['tabular-nums'] },
  body: { fontSize: 15, lineHeight: 21 },
  empty: { textAlign: 'center', paddingVertical: 24, fontSize: 13 },
});
