import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  computeTalkTime,
  formatTalkDuration,
  parseMeetingTranscript,
  talkTimelineDuration,
} from '../../utils/parseMeetingTranscript';

export default function SpeakerTalkBreakdown({
  transcriptContent,
  meetingDurationSeconds,
  onPlaySpeaker,
}: {
  transcriptContent?: string | null;
  meetingDurationSeconds?: number | null;
  onPlaySpeaker?: (startSeconds: number) => void;
}) {
  const colors = useThemeColors();
  const rows = useMemo(() => {
    const parsed = parseMeetingTranscript(transcriptContent);
    return computeTalkTime(parsed.turns, meetingDurationSeconds);
  }, [transcriptContent, meetingDurationSeconds]);
  const duration = talkTimelineDuration(rows, meetingDurationSeconds);

  if (!rows.length) return null;

  const listHeight = Math.min(224, rows.length * 52);

  return (
    <View style={[styles.card, { backgroundColor: colors.surface || colors.card, borderColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.text }]}>
        Speaking time
        {rows.some((row) => row.estimated) ? '  · estimated' : ''}
      </Text>
      <ScrollView
        style={{ height: listHeight }}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        persistentScrollbar
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
            <Text style={[styles.percent, { color: colors.textSecondary }]}>
              {formatTalkDuration(row.seconds)} · {row.percent}%
            </Text>
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
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 12 },
  title: { fontSize: 14, fontWeight: '600' },
  row: { gap: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  play: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: { fontSize: 8 },
  name: { flex: 1, fontSize: 14 },
  percent: { fontSize: 14, fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: 999, overflow: 'hidden', position: 'relative' },
  tick: { position: 'absolute', top: 0, bottom: 0 },
});
