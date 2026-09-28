import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  parseMeetingSummary,
  type MeetingSummaryKind,
  type MeetingSummarySection,
} from '../../utils/parseMeetingSummary';
import { computeTalkTime, parseMeetingTranscript } from '../../utils/parseMeetingTranscript';
import type { MeetingRecapEnrichment, MeetingRecapHero } from './meetingRecapTypes';
import SpeakerTalkBreakdown from './SpeakerTalkBreakdown';

const KIND_BG: Record<MeetingSummaryKind, string> = {
  overview: '#eef2ff',
  action_items: '#fffbeb',
  key_points: '#dbeafe',
  agenda: '#fff7ed',
  speakers: '#f0fdfa',
  decisions: '#ecfdf5',
  questions: '#fff1f2',
  follow_up: '#fae8ff',
  generic: '#f8fafc',
};

const KIND_BG_DARK: Record<MeetingSummaryKind, string> = {
  overview: '#1e1b4b',
  action_items: '#451a03',
  key_points: '#1e3a8a',
  agenda: '#7c2d12',
  speakers: '#134e4a',
  decisions: '#064e3b',
  questions: '#4c0519',
  follow_up: '#701a75',
  generic: '#1f2937',
};

function SectionCard({
  section,
  textColor,
  isDark,
}: {
  section: MeetingSummarySection;
  textColor: string;
  isDark: boolean;
}) {
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: isDark ? KIND_BG_DARK[section.kind] : KIND_BG[section.kind] },
      ]}
    >
      <Text style={[styles.cardTitle, { color: textColor }]}>{section.title}</Text>
      {section.kind === 'action_items' && section.bullets.length > 0 ? (
        <View style={{ gap: 8 }}>
          {section.bullets.map((item, index) => (
            <View key={`${section.title}-${index}`} style={styles.actionRow}>
              <View style={styles.checkbox} />
              <Text style={[styles.body, { color: textColor, flex: 1 }]}>{item}</Text>
            </View>
          ))}
        </View>
      ) : section.format === 'bullets' && section.bullets.length > 0 ? (
        <View style={{ gap: 6 }}>
          {section.bullets.map((item, index) => (
            <Text key={`${section.title}-${index}`} style={[styles.body, { color: textColor }]}>
              • {item}
            </Text>
          ))}
        </View>
      ) : (
        <Text style={[styles.body, { color: textColor }]}>
          {section.paragraph || section.bullets.join('\n')}
        </Text>
      )}
    </View>
  );
}

export default function MeetingRecapView({
  summaryContent,
  loading,
  hero,
  extraSpeakerNames,
  enrichment,
  transcriptContent,
  meetingDurationSeconds,
  onSeekTo,
}: {
  summaryContent?: string | null;
  loading?: boolean;
  hero?: MeetingRecapHero;
  extraSpeakerNames?: string[];
  enrichment?: MeetingRecapEnrichment | null;
  transcriptContent?: string | null;
  meetingDurationSeconds?: number | null;
  onSeekTo?: (startSeconds: number) => void;
}) {
  const colors = useThemeColors();
  const [showAllParticipants, setShowAllParticipants] = useState(false);
  const parsed = useMemo(() => parseMeetingSummary(summaryContent), [summaryContent]);
  const speakerNames = useMemo(() => {
    const fromSummary = parsed.sections.find((s) => s.kind === 'speakers');
    const names = new Set<string>();
    (fromSummary?.bullets || []).forEach((n) => names.add(n));
    (hero?.attendees || []).forEach((n) => names.add(n));
    (extraSpeakerNames || []).forEach((n) => names.add(n));
    return Array.from(names).filter(Boolean);
  }, [parsed.sections, hero?.attendees, extraSpeakerNames]);
  const talkRows = useMemo(
    () => computeTalkTime(parseMeetingTranscript(transcriptContent).turns, meetingDurationSeconds),
    [transcriptContent, meetingDurationSeconds]
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.tint} />
        <Text style={[styles.muted, { color: colors.textSecondary }]}>Loading recap…</Text>
      </View>
    );
  }

  const chapters = enrichment?.chapters || [];
  const timedActions = enrichment?.action_items || [];

  if (!summaryContent?.trim() && !parsed.sections.length && !chapters.length && !timedActions.length && !talkRows.length) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No summary for this meeting</Text>
        <Text style={[styles.muted, { color: colors.textSecondary }]}>
          Open the Transcript tab to read the conversation.
        </Text>
      </View>
    );
  }

  const topVisible = 5;
  const topNames = speakerNames.slice(0, topVisible);
  const moreCount = Math.max(0, speakerNames.length - topVisible);

  return (
    <View style={{ gap: 12 }}>
      {(hero?.title || hero?.dateLabel || hero?.durationLabel || speakerNames.length > 0) && (
        <View style={[styles.card, { backgroundColor: colors.surface || colors.card }]}>
          {hero?.title ? <Text style={[styles.heroTitle, { color: colors.text }]}>{hero.title}</Text> : null}
          {hero?.dateLabel || hero?.durationLabel || speakerNames.length > 0 ? (
            <View style={styles.metaRow}>
              {hero?.dateLabel ? (
                <Text style={[styles.metaText, { color: colors.textSecondary }]}>{hero.dateLabel}</Text>
              ) : null}
              {hero?.durationLabel ? (
                <Text style={[styles.metaText, { color: colors.textSecondary }]}>{hero.durationLabel}</Text>
              ) : null}
              {speakerNames.length > 0 ? (
                <Text style={[styles.metaText, { color: colors.textSecondary }]}>
                  {speakerNames.length} {speakerNames.length === 1 ? 'participant' : 'participants'}
                </Text>
              ) : null}
            </View>
          ) : null}
          {topNames.length > 0 ? (
            <Text style={[styles.namesLine, { color: colors.text }]}>
              {topNames.join(' · ')}
              {moreCount > 0 ? (
                <>
                  {' · '}
                  <Text
                    onPress={() => setShowAllParticipants(true)}
                    style={{ color: colors.tint || '#4f46e5', fontWeight: '700' }}
                  >
                    +{moreCount}
                  </Text>
                </>
              ) : null}
            </Text>
          ) : null}
        </View>
      )}

      <SpeakerTalkBreakdown
        transcriptContent={transcriptContent}
        meetingDurationSeconds={meetingDurationSeconds}
        extraSpeakerNames={speakerNames}
        onPlaySpeaker={onSeekTo}
      />

      {chapters.length > 0 ? (
        <View style={[styles.card, { backgroundColor: colors.surface || colors.card }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Chapters</Text>
          <View style={styles.chipWrap}>
            {chapters.map((chapter) => (
              <TouchableOpacity
                key={`${chapter.title}-${chapter.startSeconds}`}
                onPress={() => chapter.startSeconds != null && onSeekTo?.(chapter.startSeconds)}
                style={[styles.chip, { backgroundColor: colors.inputBackground || colors.border }]}
              >
                <Text style={[styles.chipText, { color: colors.text }]}>
                  {chapter.clock ? `${chapter.clock}  ` : ''}
                  {chapter.title}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}

      {timedActions.length > 0 ? (
        <View style={[styles.card, { backgroundColor: colors.isDark ? '#451a03' : '#fffbeb' }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Action Items</Text>
          <View style={{ gap: 8 }}>
            {timedActions.map((item) => (
              <View key={`${item.text}-${item.startSeconds}`} style={styles.actionRow}>
                <View style={styles.checkbox} />
                <Text style={[styles.body, { color: colors.text, flex: 1 }]}>
                  {item.clock ? (
                    <Text
                      onPress={() => item.startSeconds != null && onSeekTo?.(item.startSeconds)}
                      style={{ color: '#4f46e5', fontWeight: '700' }}
                    >
                      {item.clock}{' '}
                    </Text>
                  ) : null}
                  {item.text}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {parsed.sections
        .filter(
          (section) =>
            section.kind !== 'speakers' &&
            !(timedActions.length > 0 && section.kind === 'action_items')
        )
        .map((section, index) => (
        <SectionCard
          key={`${section.title}-${index}`}
          section={section}
          textColor={colors.text}
          isDark={!!colors.isDark}
        />
      ))}

      <Modal
        visible={showAllParticipants}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAllParticipants(false)}
      >
        <Pressable style={styles.popupOverlay} onPress={() => setShowAllParticipants(false)}>
          <Pressable
            style={[styles.popupCard, { backgroundColor: colors.surface || colors.card }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.popupTitle, { color: colors.text }]}>
              Participants ({speakerNames.length})
            </Text>
            <ScrollView style={styles.popupList} nestedScrollEnabled>
              {speakerNames.map((name) => (
                <Text key={name} style={[styles.popupName, { color: colors.text }]}>
                  {name}
                </Text>
              ))}
            </ScrollView>
            <TouchableOpacity onPress={() => setShowAllParticipants(false)} style={styles.popupClose}>
              <Text style={{ color: colors.tint || '#4f46e5', fontWeight: '600' }}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { paddingVertical: 48, alignItems: 'center', paddingHorizontal: 16 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginBottom: 6, textAlign: 'center' },
  muted: { fontSize: 13, textAlign: 'center', marginTop: 8 },
  card: { borderRadius: 12, padding: 14 },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 8 },
  body: { fontSize: 15, lineHeight: 22 },
  actionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#f59e0b',
    marginTop: 3,
  },
  heroTitle: { fontSize: 18, fontWeight: '700' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  metaText: { fontSize: 13 },
  namesLine: { fontSize: 13, marginTop: 8, lineHeight: 20 },
  popupOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 28,
  },
  popupCard: { borderRadius: 14, padding: 16, maxHeight: '70%' },
  popupTitle: { fontSize: 16, fontWeight: '700', marginBottom: 10 },
  popupList: { maxHeight: 320 },
  popupName: { fontSize: 15, paddingVertical: 7 },
  popupClose: { alignSelf: 'flex-end', marginTop: 12, paddingVertical: 4 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { fontSize: 12 },
});
