import { useLocalSearchParams } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';
import MeetingAssetTabs from '../../../components/meeting/MeetingAssetTabs';
import MeetingCachedRecordingPlayer from '../../../components/meeting/MeetingCachedRecordingPlayer';
import {
  formatMeetingDurationLabel,
  type MeetingRecapEnrichment,
  type MeetingRecapHero,
  type MeetingRecapRecording,
} from '../../../components/meeting/meetingRecapTypes';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { apiClient } from '../../../services/api';
import { getAssistCall } from '../../../services/assistApi';

function absoluteAssistUrl(path?: string | null): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  const base = String(apiClient.client.defaults.baseURL || '').replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function formatCallDate(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function AssistCallDetailScreen() {
  const { id, owner_user_id } = useLocalSearchParams<{ id: string; owner_user_id?: string }>();
  const ownerId = owner_user_id ? Number(owner_user_id) : undefined;
  const colors = useThemeColors();
  const [loading, setLoading] = useState(true);
  const [call, setCall] = useState<any>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAssistCall(Number(id), ownerId);
        if (!cancelled) setCall(res);
      } catch {
        if (!cancelled) setCall(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, ownerId]);

  const audioUrl = absoluteAssistUrl(call?.audio_url);
  const recording: MeetingRecapRecording | null = useMemo(() => {
    if (!audioUrl) return null;
    return {
      streamUrl: audioUrl,
      trackType: 'audio',
      label: 'Recording',
      assetId: call?.id != null ? `assist_call_${call.id}` : undefined,
    };
  }, [audioUrl, call?.id]);

  const hero: MeetingRecapHero | undefined = useMemo(() => {
    if (!call) return undefined;
    return {
      title: call.headline || call.from_number || 'Call',
      dateLabel: formatCallDate(call.started_at),
      durationLabel: formatMeetingDurationLabel(call.started_at, call.ended_at, call.duration_seconds),
      attendees: call.from_number ? [call.from_number] : undefined,
    };
  }, [call]);

  const enrichment: MeetingRecapEnrichment | null = call?.recap_v2 || null;
  const summaryContent =
    call?.summary_content ||
    (call?.summary || (call?.action_items || []).length || (call?.key_points || []).length
      ? JSON.stringify({
          summary: call?.summary,
          key_points: call?.key_points || [],
          action_items: call?.action_items || [],
        })
      : null);
  const transcriptContent = call?.transcript_srt || call?.transcript_text || null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle title="Call detail" />
        <View style={{ width: 40 }} />
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 30 }} color="#0284C7" />
      ) : !call ? (
        <Text style={{ padding: 16, color: colors.textSecondary }}>Call not found.</Text>
      ) : call.transcript_status === 'unavailable' && !transcriptContent && !summaryContent ? (
        <View style={{ padding: 16 }}>
          <Text style={[styles.h1, { color: colors.text }]}>
            {call.headline || call.from_number || 'Call'}
          </Text>
          <Text style={{ color: colors.textSecondary, marginTop: 8 }}>
            {hero?.dateLabel ? `${hero.dateLabel} · ` : ''}
            {call.from_number || ''}
          </Text>
          <Text style={{ color: colors.textSecondary, marginTop: 12 }}>
            Transcript unavailable
            {recording ? '. Recording is still available below.' : '.'}
          </Text>
          {recording ? (
            <View style={{ marginTop: 16 }}>
              <MeetingCachedRecordingPlayer
                streamUrl={recording.streamUrl}
                trackType="audio"
                assetId={recording.assetId}
              />
            </View>
          ) : null}
        </View>
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 12, paddingBottom: 8 }}>
          {call.transcript_status === 'pending' || call.transcript_status === 'paused_credits' ? (
            <Text style={{ color: colors.textSecondary, marginBottom: 8, paddingHorizontal: 4 }}>
              {call.transcript_status === 'paused_credits'
                ? 'Transcript paused — not enough AI credits.'
                : 'Transcript pending…'}
            </Text>
          ) : null}
          <MeetingAssetTabs
            showHeaderActions={false}
            hero={hero}
            enrichment={enrichment}
            summaryContent={summaryContent}
            transcriptContent={transcriptContent}
            recording={recording}
            recordings={recording ? [recording] : []}
            meetingDurationSeconds={call.duration_seconds}
            initialTab={summaryContent ? 'recap' : 'transcript'}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  h1: { fontSize: 20, fontWeight: '700', marginBottom: 4 },
});
