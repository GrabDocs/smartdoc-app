import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import MeetingAssetTabs from '../../../components/meeting/MeetingAssetTabs';
import {
  formatMeetingDurationLabel,
  isAudioTrackType,
  parseNumericId,
} from '../../../components/meeting/meetingRecapTypes';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { calendarAssetContent, calendarMeetingAssets } from '../../../services/calendarApi';
import { STORAGE_KEYS } from '../../../constants/Config';
import {
  extractCallRecordingId,
  isRawUnplayableRecordingUrl,
  recordingApiStreamUrl,
} from '../../../utils/meetingRecordingPlayback';
import { secureStorage } from '../../../utils/storage';

import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';

type LazyAssetType = 'transcript' | 'summary' | 'chat' | 'recap';
type AssetItem = {
  key: string;
  type: LazyAssetType | 'recording' | 'note' | 'report';
  title: string;
  url?: string | null;
  transcriptUrl?: string | null;
  summaryUrl?: string | null;
  description?: string;
  lazy: boolean;
};

export default function CalendarEventAssetsScreen() {
  const { eventId: idParam } = useLocalSearchParams<{ eventId?: string }>();
  const eventId = Number(idParam);
  const colors = useThemeColors();

  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<any | null>(null);
  const [open, setOpen] = useState<AssetItem | null>(null);
  const [content, setContent] = useState<string>('');
  const [summaryContent, setSummaryContent] = useState('');
  const [transcriptContent, setTranscriptContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingTrack, setRecordingTrack] = useState<string | null>(null);

  const meeting = payload?.meeting ?? payload;

  const load = useCallback(async () => {
    if (!Number.isFinite(eventId)) return;
    const data = await calendarMeetingAssets(eventId);
    setPayload(data);
  }, [eventId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!Number.isFinite(eventId)) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        await load();
      } catch (e: any) {
        Alert.alert('Error', e?.response?.data?.error || e?.message || 'Failed to load assets');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, load]);

  const openAsset = async (asset: AssetItem) => {
    if (asset.type === 'recap') {
      setOpen(asset);
      setContentLoading(true);
      setSummaryContent('');
      setTranscriptContent('');
      setRecordingUrl(null);
      try {
        const [summary, transcript] = await Promise.all([
          asset.summaryUrl
            ? calendarAssetContent(eventId, 'summary', asset.summaryUrl).catch(() => '')
            : Promise.resolve(''),
          asset.transcriptUrl
            ? calendarAssetContent(eventId, 'transcript', asset.transcriptUrl).catch(() => '')
            : Promise.resolve(''),
        ]);
        const asText = (data: any) =>
          typeof data === 'string'
            ? data
            : data?.content ?? data?.text ?? data?.body ?? (data ? JSON.stringify(data, null, 2) : '');
        setSummaryContent(asText(summary));
        setTranscriptContent(asText(transcript));
        const recordings = meeting?.recordings || [];
        const preferred =
          recordings.find((r: any) => !isAudioTrackType(r.track_type)) || recordings[0];
        const recId = extractCallRecordingId({
          recordingDbId: preferred?.recording_db_id,
          id: preferred?.id,
          url: preferred?.url,
        });
        if (recId != null) {
          let token: string | null = null;
          try {
            token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
          } catch {
            token = null;
          }
          setRecordingUrl(recordingApiStreamUrl(recId, token));
          setRecordingTrack(preferred?.track_type || null);
        } else if (preferred?.url && !isRawUnplayableRecordingUrl(preferred.url)) {
          setRecordingUrl(preferred.url);
          setRecordingTrack(preferred.track_type || null);
        }
      } catch (e: any) {
        Alert.alert('Error', e?.response?.data?.error || e?.message || 'Could not load recap');
      } finally {
        setContentLoading(false);
      }
      return;
    }
    if (!asset.url) {
      Alert.alert('Asset unavailable', 'This asset does not have a downloadable URL yet.');
      return;
    }
    if (!asset.lazy) {
      Linking.openURL(asset.url).catch(() => Alert.alert('Error', 'Could not open asset'));
      return;
    }
    setOpen(asset);
    setContentLoading(true);
    setContent('');
    try {
      const data = await calendarAssetContent(eventId, asset.type as 'transcript' | 'summary' | 'chat', asset.url);
      const text =
        typeof data === 'string'
          ? data
          : data?.content ?? data?.text ?? data?.body ?? JSON.stringify(data, null, 2);
      setContent(text);
    } catch (e: any) {
      setContent(e?.response?.data?.error || e?.message || 'Could not load');
    } finally {
      setContentLoading(false);
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: colors.headerBackground },
        h1: { fontSize: 18, fontWeight: '700', color: colors.text, flex: 1 },
        card: {
          marginHorizontal: 16,
          marginBottom: 10,
          padding: 12,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        },
        row: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
        label: { color: colors.text, fontWeight: '600' },
      }),
    [colors]
  );

  const assets = useMemo<AssetItem[]>(() => {
    if (!meeting) return [];

    const rows: AssetItem[] = [];
    const pushUrl = (
      type: AssetItem['type'],
      title: string,
      url: string | null | undefined,
      lazy: boolean,
      description?: string
    ) => {
      if (!url) return;
      rows.push({
        key: `${type}-${rows.length}-${url}`,
        type,
        title,
        url,
        lazy,
        description,
      });
    };

    if (meeting.transcript_url || meeting.summary_url) {
      rows.push({
        key: 'meeting-recap',
        type: 'recap',
        title: 'Meeting recap',
        transcriptUrl: meeting.transcript_url,
        summaryUrl: meeting.summary_url,
        lazy: true,
        description: 'Recap and transcript',
      });
    }

    (meeting.chats || []).forEach((chat: any, idx: number) => {
      pushUrl('chat', chat.filename || `Chat ${idx + 1}`, chat.url, true, chat.file_size ? `${chat.file_size} bytes` : 'Meeting chat');
    });

    (meeting.recordings || []).forEach((recording: any, idx: number) => {
      pushUrl(
        'recording',
        recording.title || `Recording ${idx + 1}`,
        recording.url,
        false,
        recording.file_size ? `${recording.file_size} bytes` : 'Recording'
      );
    });

    (meeting.notes || []).forEach((note: any, idx: number) => {
      pushUrl('note', note.filename || `Meeting note ${idx + 1}`, note.url, false, note.file_size ? `${note.file_size} bytes` : 'Meeting note');
    });

    (meeting.reports || []).forEach((report: any, idx: number) => {
      rows.push({
        key: `report-${report.id ?? idx}`,
        type: 'report',
        title: report.participant_name || report.participant_email || `Participant report ${idx + 1}`,
        description: report.duration ? `Duration: ${report.duration}` : 'Participant analytics',
        lazy: false,
      });
    });

    return rows;
  }, [meeting]);

  if (!Number.isFinite(eventId)) {
    return (
      <SafeAreaView style={styles.safe}>
        <Text style={{ padding: 16 }}>Invalid</Text>
      </SafeAreaView>
    );
  }

  const videoCallId = parseNumericId(meeting?.video_call_id);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle>Meeting assets</AppHeaderTitle>
        <TouchableOpacity
          onPress={() => void load()}
          disabled={loading}
          accessibilityLabel="Refresh"
          accessibilityRole="button"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="refresh" size={28} color={loading ? '#999' : colors.tint ?? '#007AFF'} />
        </TouchableOpacity>
      </View>

      {loading ? <ActivityIndicator style={{ marginTop: 32 }} /> : null}

      {!loading && !open ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
          {assets.length > 0 ? (
            assets.map((asset) => (
              <FeedbackTouchable
                key={asset.key}
                style={styles.row}
                onPress={() => openAsset(asset)}
                spinnerColor="#007AFF"
                replaceWithSpinner={false}
              >
                <Text style={styles.label}>{asset.title}</Text>
                {asset.description ? <Text style={{ color: colors.textSecondary, marginTop: 4 }}>{asset.description}</Text> : null}
              </FeedbackTouchable>
            ))
          ) : (
            <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 32, paddingHorizontal: 24 }}>
              No downloadable assets for this event.
            </Text>
          )}
        </ScrollView>
      ) : null}

      {open ? (
        <View style={{ flex: 1, padding: 16 }}>
          <TouchableOpacity onPress={() => setOpen(null)} style={{ marginBottom: 12 }}>
            <Text style={{ color: '#007AFF' }}>← Back to list</Text>
          </TouchableOpacity>
          {open.type === 'recap' ? (
            contentLoading ? (
              <ActivityIndicator />
            ) : (
              <MeetingAssetTabs
                initialTab={summaryContent ? 'recap' : 'transcript'}
                summaryContent={summaryContent}
                transcriptContent={transcriptContent}
                hero={{
                  title: meeting?.room_name || 'Meeting recap',
                  durationLabel: formatMeetingDurationLabel(
                    meeting?.started_at,
                    meeting?.ended_at,
                    meeting?.duration_minutes ? meeting.duration_minutes * 60 : null
                  ),
                }}
                recording={recordingUrl ? { streamUrl: recordingUrl, trackType: recordingTrack } : null}
                clientLink={
                  videoCallId != null
                    ? { itemType: 'video_call', itemId: videoCallId }
                    : Number.isFinite(eventId)
                      ? { itemType: 'calendar_event', itemId: eventId }
                      : null
                }
              />
            )
          ) : (
            <>
              <Text style={{ fontSize: 18, fontWeight: '600', color: colors.text, marginBottom: 8 }}>{open.title}</Text>
              {contentLoading ? <ActivityIndicator /> : <Text style={{ color: colors.text, fontSize: 14, lineHeight: 22 }}>{content}</Text>}
            </>
          )}
        </View>
      ) : null}
    </SafeAreaView>
  );
}
