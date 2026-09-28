import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  computeTalkTime,
  formatTalkDuration,
  parseMeetingTranscript,
  talkTimelineDuration,
  type SpeakerTalkTime,
} from '../../utils/parseMeetingTranscript';

function mergeSpeakerRows(talkRows: SpeakerTalkTime[], extraNames?: string[]): SpeakerTalkTime[] {
  const rows = [...talkRows];
  const seen = new Set(rows.map((r) => r.speaker.trim().toLowerCase()));
  for (const name of extraNames || []) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ speaker: trimmed, seconds: 0, percent: 0, segments: [] });
  }
  return rows;
}

export default function SpeakerTalkBreakdown({
  transcriptContent,
  meetingDurationSeconds,
  extraSpeakerNames,
  onPlaySpeaker,
}: {
  transcriptContent?: string | null;
  meetingDurationSeconds?: number | null;
  extraSpeakerNames?: string[];
  onPlaySpeaker?: (startSeconds: number) => void;
}) {
  const colors = useThemeColors();
  const rows = useMemo(() => {
    const parsed = parseMeetingTranscript(transcriptContent);
    return mergeSpeakerRows(
      computeTalkTime(parsed.turns, meetingDurationSeconds),
      extraSpeakerNames
    );
  }, [transcriptContent, meetingDurationSeconds, extraSpeakerNames]);
  const duration = talkTimelineDuration(rows, meetingDurationSeconds);

  if (!rows.length) return null;

  const maxVisible = 5;
  const rowHeight = 40;
  const needsScroll = rows.length > maxVisible;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.isDark ? '#134e4a' : '#f0fdfa' },
      ]}
    >
      <Text style={[styles.title, { color: colors.text }]}>
        Speakers
        {rows.some((row) => row.estimated) ? '  · estimated' : ''}
      </Text>
      <ScrollView
        style={needsScroll ? { maxHeight: maxVisible * rowHeight } : undefined}
        scrollEnabled={needsScroll}
        nestedScrollEnabled={needsScroll}
        showsVerticalScrollIndicator={needsScroll}
        persistentScrollbar={needsScroll}
      >
        {rows.map((row) => (
          <View key={row.speaker} style={styles.row}>
            <View style={styles.header}>
              <TouchableOpacity
                disabled={!onPlaySpeaker || row.firstStartSeconds == null}
                onPress={() => row.firstStartSeconds != null && onPlaySpeaker?.(row.firstStartSeconds)}
                style={[styles.play, { borderColor: colors.border }]}
              >
                <Text style={[styles.playIcon, { color: colors.textSecondary }]}>▶</Text>
              </TouchableOpacity>
              <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                {row.speaker}
              </Text>
              {row.seconds > 0 ? (
                <Text style={[styles.percent, { color: colors.textSecondary }]}>
                  {formatTalkDuration(row.seconds)} · {row.percent}%
                </Text>
              ) : null}
            </View>
            {row.segments.length > 0 && duration > 0 ? (
              <View style={[styles.track, { backgroundColor: colors.inputBackground || colors.border }]}>
                {row.segments.map((seg, index) => {
                  const left = `${(seg.start / duration) * 100}%`;
                  const width = `${Math.max(0.35, ((seg.end - seg.start) / duration) * 100)}%`;
                  return (
                    <View
                      key={`${seg.start}-${index}`}
                      style={[styles.tick, { left, width, backgroundColor: '#9ca3af' }]}
                    />
                  );
                })}
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, padding: 14, gap: 8 },
  title: { fontSize: 15, fontWeight: '700' },
  row: { gap: 4, paddingBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  play: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: { fontSize: 7 },
  name: { flex: 1, fontSize: 13 },
  percent: { fontSize: 12, fontVariant: ['tabular-nums'] },
  track: { height: 5, borderRadius: 999, overflow: 'hidden', position: 'relative' },
  tick: { position: 'absolute', top: 0, bottom: 0 },
});
