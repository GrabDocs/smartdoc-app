import { Ionicons } from '@expo/vector-icons';
import { Video, type AVPlaybackStatus } from 'expo-av';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  computeTalkTime,
  formatTalkDuration,
  formatTurnClock,
  parseMeetingTranscript,
  type MeetingTranscriptTurn,
} from '../../utils/parseMeetingTranscript';
import {
  collapseRecapRecordings,
  isAudioTrackType,
  pickPreferredRecording,
  recordingLabel,
  type MeetingRecapRecording,
} from './meetingRecapTypes';

const AVATAR_COLORS = ['#6366f1', '#14b8a6', '#f59e0b', '#f43f5e', '#0ea5e9', '#8b5cf6', '#10b981'];

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

function highlightText(text: string, query: string, textColor: string, highlightBg: string) {
  const q = query.trim();
  if (!q) return <Text style={[styles.turnText, { color: textColor }]}>{text}</Text>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let idx = lower.indexOf(needle);
  let key = 0;
  while (idx >= 0) {
    if (idx > cursor) {
      nodes.push(
        <Text key={`t-${key}`} style={{ color: textColor }}>
          {text.slice(cursor, idx)}
        </Text>
      );
      key += 1;
    }
    nodes.push(
      <Text key={`h-${key}`} style={{ backgroundColor: highlightBg, color: textColor }}>
        {text.slice(idx, idx + q.length)}
      </Text>
    );
    key += 1;
    cursor = idx + q.length;
    idx = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) {
    nodes.push(
      <Text key={`t-${key}`} style={{ color: textColor }}>
        {text.slice(cursor)}
      </Text>
    );
  }
  return <Text style={styles.turnText}>{nodes}</Text>;
}

export default function MeetingTranscriptView({
  transcriptContent,
  loading,
  recording,
  recordings,
  meetingDurationSeconds,
  seekToSeconds,
  onPlayRecording,
}: {
  transcriptContent?: string | null;
  loading?: boolean;
  recording?: MeetingRecapRecording | null;
  recordings?: MeetingRecapRecording[] | null;
  meetingDurationSeconds?: number | null;
  seekToSeconds?: number | null;
  onPlayRecording?: (recording: MeetingRecapRecording) => void;
}) {
  const colors = useThemeColors();
  const parsed = useMemo(() => parseMeetingTranscript(transcriptContent), [transcriptContent]);
  const talk = useMemo(
    () => computeTalkTime(parsed.turns, meetingDurationSeconds),
    [parsed.turns, meetingDurationSeconds]
  );
  const [query, setQuery] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
  const [hitIndex, setHitIndex] = useState(0);
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const recordingOptions = useMemo(() => {
    const list = collapseRecapRecordings((recordings || []).filter((row) => row?.streamUrl));
    if (list.length) return list;
    return recording?.streamUrl ? collapseRecapRecordings([recording]) : [];
  }, [recordings, recording]);
  const [selectedStreamUrl, setSelectedStreamUrl] = useState<string | null>(null);
  const activeRecording = useMemo(
    () =>
      recordingOptions.find((row) => row.streamUrl === selectedStreamUrl) ||
      pickPreferredRecording(recordingOptions),
    [recordingOptions, selectedStreamUrl]
  );
  const videoRef = useRef<Video | null>(null);
  const listRef = useRef<ScrollView | null>(null);
  const turnY = useRef<Record<number, number>>({});

  const filteredTurns = useMemo(() => {
    return parsed.turns
      .map((turn, index) => ({ turn, index }))
      .filter(({ turn }) => !speakerFilter || turn.speaker === speakerFilter);
  }, [parsed.turns, speakerFilter]);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return filteredTurns.filter(
      ({ turn }) => turn.text.toLowerCase().includes(q) || turn.speaker.toLowerCase().includes(q)
    );
  }, [filteredTurns, query]);

  useEffect(() => {
    setHitIndex(0);
  }, [query, speakerFilter]);

  useEffect(() => {
    if (!hits.length) return;
    const current = hits[Math.min(hitIndex, hits.length - 1)];
    const y = turnY.current[current.index];
    if (y != null) {
      listRef.current?.scrollTo({ y: Math.max(0, y - 80), animated: true });
    }
  }, [hitIndex, hits]);

  const hasTimestamps = parsed.turns.some((t) => t.startSeconds != null);
  const showPlayer = !!activeRecording?.streamUrl;
  const audio = isAudioTrackType(activeRecording?.trackType);

  const onPlaybackStatus = (status: AVPlaybackStatus) => {
    if (!status.isLoaded || status.positionMillis == null) return;
    const t = status.positionMillis / 1000;
    let current: number | null = null;
    for (let i = 0; i < parsed.turns.length; i += 1) {
      const start = parsed.turns[i].startSeconds;
      if (start == null) continue;
      const next = parsed.turns[i + 1]?.startSeconds;
      if (t >= start && (next == null || t < next)) current = i;
    }
    setActiveTurn(current);
  };

  const seekTo = async (turn: MeetingTranscriptTurn, index: number) => {
    if (!hasTimestamps || turn.startSeconds == null) return;
    if (onPlayRecording && activeRecording) {
      onPlayRecording(activeRecording);
      setActiveTurn(index);
      return;
    }
    if (!activeRecording?.streamUrl) return;
    const millis = Math.round(turn.startSeconds * 1000);
    try {
      await videoRef.current?.setPositionAsync(millis);
      await videoRef.current?.playAsync();
      setActiveTurn(index);
    } catch {
      setPlayerError('Unable to play this recording.');
    }
  };

  useEffect(() => {
    if (seekToSeconds == null || !hasTimestamps) return;
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    parsed.turns.forEach((turn, index) => {
      if (turn.startSeconds == null) return;
      const delta = Math.abs(turn.startSeconds - seekToSeconds);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) return;
    void seekTo(parsed.turns[bestIndex], bestIndex);
  }, [seekToSeconds]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.tint} />
        <Text style={[styles.muted, { color: colors.textSecondary }]}>Loading transcript…</Text>
      </View>
    );
  }

  if (!transcriptContent?.trim()) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No transcript for this meeting</Text>
        <Text style={[styles.muted, { color: colors.textSecondary }]}>It may still be processing.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {showPlayer ? (
        <View style={[styles.player, { backgroundColor: colors.surface || colors.card, borderColor: colors.border }]}>
          {recordingOptions.length > 1 ? (
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
              {recordingOptions.map((row) => {
                const selected = activeRecording?.streamUrl === row.streamUrl;
                return (
                  <TouchableOpacity
                    key={row.streamUrl}
                    onPress={() => setSelectedStreamUrl(row.streamUrl)}
                    style={[
                      styles.speakerChip,
                      { backgroundColor: selected ? '#4f46e5' : colors.inputBackground || colors.border },
                    ]}
                  >
                    <Text style={{ color: selected ? '#fff' : colors.text, fontSize: 12 }}>
                      {row.label || recordingLabel(row.trackType)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
          {onPlayRecording ? (
            <TouchableOpacity
              onPress={() => onPlayRecording(activeRecording!)}
              style={styles.playExisting}
            >
              <Ionicons name="play-circle" size={28} color="#007AFF" />
              <Text style={styles.playExistingText}>
                Play {activeRecording!.label || recordingLabel(activeRecording!.trackType)}
              </Text>
            </TouchableOpacity>
          ) : (
            <Video
              ref={(el) => {
                videoRef.current = el;
              }}
              source={{ uri: activeRecording!.streamUrl }}
              useNativeControls
              style={{ width: '100%', height: audio ? 48 : 160, borderRadius: 8 }}
              onPlaybackStatusUpdate={onPlaybackStatus}
              onError={() => setPlayerError('Unable to play this recording.')}
            />
          )}
          {playerError && !onPlayRecording ? <Text style={styles.error}>{playerError}</Text> : null}
          {!hasTimestamps ? (
            <Text style={[styles.muted, { color: colors.textSecondary, textAlign: 'left' }]}>
              Play/pause is available. This transcript has no timestamps to seek.
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.searchRow}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search transcript"
          placeholderTextColor={colors.textSecondary}
          style={[
            styles.search,
            { color: colors.text, backgroundColor: colors.inputBackground || colors.surface, borderColor: colors.border },
          ]}
        />
        {hits.length > 0 ? (
          <TouchableOpacity
            onPress={() => setHitIndex((i) => (i + 1) % hits.length)}
            style={[styles.nextBtn, { backgroundColor: colors.inputBackground || colors.border }]}
          >
            <Text style={{ color: colors.text, fontSize: 12 }}>
              {Math.min(hitIndex + 1, hits.length)}/{hits.length} Next
            </Text>
          </TouchableOpacity>
        ) : query.trim() ? (
          <Text style={[styles.muted, { color: colors.textSecondary, marginTop: 0 }]}>No matches</Text>
        ) : null}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {parsed.speakers.map((name) => {
          const selected = speakerFilter === name;
          const row = talk.find((t) => t.speaker === name);
          return (
            <TouchableOpacity
              key={name}
              onPress={() => setSpeakerFilter((prev) => (prev === name ? null : name))}
              style={[
                styles.speakerChip,
                { backgroundColor: selected ? '#4f46e5' : colors.inputBackground || colors.border },
              ]}
            >
              <Text style={{ color: selected ? '#fff' : colors.text, fontSize: 12 }}>
                {name}
                {row ? `  ${formatTalkDuration(row.seconds)} · ${row.percent}%` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView ref={listRef} style={{ maxHeight: 520 }} nestedScrollEnabled>
        {filteredTurns.map(({ turn, index }) => {
          const clock = formatTurnClock(turn.startSeconds);
          const isActive = activeTurn === index;
          return (
            <View
              key={`${turn.speaker}-${index}`}
              onLayout={(e) => {
                turnY.current[index] = e.nativeEvent.layout.y;
              }}
              style={[
                styles.turn,
                isActive ? { backgroundColor: colors.isDark ? '#1e1b4b' : '#eef2ff' } : null,
              ]}
            >
              <View style={[styles.avatar, { backgroundColor: speakerColor(turn.speaker) }]}>
                <Text style={styles.avatarText}>{initials(turn.speaker)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.turnHeader}>
                  <Text style={[styles.speaker, { color: colors.text }]}>{turn.speaker}</Text>
                  {clock ? (
                    <TouchableOpacity
                      disabled={!hasTimestamps || !showPlayer}
                      onPress={() => void seekTo(turn, index)}
                      style={[styles.clock, { backgroundColor: colors.inputBackground || colors.border }]}
                    >
                      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{clock}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                <TouchableOpacity onPress={() => void seekTo(turn, index)} activeOpacity={0.7}>
                  {highlightText(turn.text, query, colors.text, colors.isDark ? '#854d0e' : '#fde68a')}
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { paddingVertical: 48, alignItems: 'center', paddingHorizontal: 16 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginBottom: 6, textAlign: 'center' },
  muted: { fontSize: 12, textAlign: 'center', marginTop: 8 },
  player: { borderRadius: 10, borderWidth: 1, padding: 8 },
  playExisting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
  },
  playExistingText: { fontSize: 16, fontWeight: '600', color: '#007AFF' },
  error: { color: '#dc2626', fontSize: 12, marginTop: 6 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  search: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  nextBtn: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 8 },
  chipRow: { gap: 6, paddingVertical: 2 },
  speakerChip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  turn: { flexDirection: 'row', gap: 10, paddingVertical: 8, paddingHorizontal: 6, borderRadius: 10 },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  turnHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  speaker: { fontSize: 12, fontWeight: '700' },
  clock: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  turnText: { fontSize: 15, lineHeight: 22 },
});
