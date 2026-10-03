import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import ClientsButton from '../clients/ClientsButton';
import { useOpenChatGD } from '../../contexts/ChatGDSheetContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { summarizeMeetingChat } from '../../utils/parseMeetingChat';
import { parseMeetingTranscript } from '../../utils/parseMeetingTranscript';
import MeetingChatView from './MeetingChatView';
import ShareAccessSheet from '../share/ShareAccessSheet';
import { createFileShareAdapter } from '../share/fileShareAdapter';
import { shareDocumentFile, shareTextContent } from '../../utils/shareDocumentFile';
import { buildRecapShareMarkdown } from '../../utils/buildRecapShareMarkdown';
import MeetingRecapView from './MeetingRecapView';
import MeetingTranscriptView from './MeetingTranscriptView';
import type {
  MeetingRecapAskContext,
  MeetingRecapClientLink,
  MeetingRecapHero,
  MeetingRecapRecording,
  MeetingRecapEnrichment,
  MeetingRecapShareFiles,
  MeetingRecapTab,
} from './meetingRecapTypes';
import { collapseRecapRecordings, pickPreferredRecording } from './meetingRecapTypes';

export type MeetingAssetTabsProps = {
  initialTab?: MeetingRecapTab;
  summaryContent?: string | null;
  transcriptContent?: string | null;
  loadingSummary?: boolean;
  loadingTranscript?: boolean;
  hero?: MeetingRecapHero;
  recording?: MeetingRecapRecording | null;
  recordings?: MeetingRecapRecording[] | null;
  chatContent?: string | null;
  meetingDurationSeconds?: number | null;
  showHeaderActions?: boolean;
  clientLink?: MeetingRecapClientLink | null;
  shareFiles?: MeetingRecapShareFiles | null;
  askContext?: MeetingRecapAskContext | null;
  onDownloadSummary?: () => void;
  onDownloadTranscript?: () => void;
  enrichment?: MeetingRecapEnrichment | null;
};

export default function MeetingAssetTabs({
  initialTab,
  summaryContent,
  transcriptContent,
  loadingSummary,
  loadingTranscript,
  hero,
  recording,
  recordings,
  chatContent,
  meetingDurationSeconds,
  showHeaderActions = true,
  clientLink,
  shareFiles,
  askContext,
  onDownloadSummary,
  onDownloadTranscript,
  enrichment,
}: MeetingAssetTabsProps) {
  const colors = useThemeColors();
  const openChatGD = useOpenChatGD();
  const hasSummary = !!summaryContent?.trim();
  const chatSummary = useMemo(() => summarizeMeetingChat(chatContent), [chatContent]);
  const hasChat = chatSummary.messageCount > 0;
  const defaultTab: MeetingRecapTab =
    initialTab === 'chat' && !hasChat ? (hasSummary ? 'recap' : 'transcript') : initialTab || (hasSummary ? 'recap' : 'transcript');
  const [tab, setTab] = useState<MeetingRecapTab>(defaultTab);
  const [seekToSeconds, setSeekToSeconds] = useState<number | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const accessFile =
    shareFiles?.packFileId != null
      ? { id: shareFiles.packFileId, name: shareFiles.packFileName || 'Meeting recap' }
      : shareFiles?.summaryFileId != null
        ? { id: shareFiles.summaryFileId, name: shareFiles.summaryFileName || 'Meeting summary' }
        : shareFiles?.transcriptFileId != null
          ? { id: shareFiles.transcriptFileId, name: shareFiles.transcriptFileName || 'Meeting transcript' }
          : null;

  const extraSpeakers = useMemo(
    () => parseMeetingTranscript(transcriptContent).speakers.filter((s) => s !== 'Transcript' && s !== 'Speaker'),
    [transcriptContent]
  );
  const recordingOptions = useMemo(() => {
    const list = collapseRecapRecordings((recordings || []).filter((row) => row?.streamUrl));
    if (list.length) return list;
    return recording?.streamUrl ? collapseRecapRecordings([recording]) : [];
  }, [recordings, recording]);
  const resolvedHero = useMemo<MeetingRecapHero | undefined>(() => {
    if (!hero && !extraSpeakers.length) return hero;
    const attendees = hero?.attendees?.length ? hero.attendees : extraSpeakers;
    return { ...(hero || {}), attendees };
  }, [hero, extraSpeakers]);

  const canAsk = !!askContext && ((askContext.fileIds?.length || 0) + (askContext.transcriptIds?.length || 0) > 0);
  const shareIds = [
    shareFiles?.packFileId,
    shareFiles?.summaryFileId,
    shareFiles?.transcriptFileId,
  ].filter((n): n is number => n != null && Number.isFinite(n));
  const canShare = shareIds.length > 0 || !!summaryContent?.trim() || !!transcriptContent?.trim();

  const handleAsk = () => {
    if (!canAsk || !askContext) return;
    const fileIds = (askContext.fileIds || []).filter((n) => Number.isFinite(n));
    const transcriptIds = (askContext.transcriptIds || []).filter((n) => Number.isFinite(n));
    openChatGD({
      fileId: fileIds[0] != null ? String(fileIds[0]) : undefined,
      fileIds: fileIds.length ? fileIds.join(',') : undefined,
      fileName: fileIds.length > 1 ? 'Meeting recap' : askContext.labels?.[0]?.name || 'Meeting recap',
      transcriptIds: transcriptIds.length ? transcriptIds.join(',') : undefined,
      chatPlaceholder: 'Ask about this meeting',
    });
  };

  /** Send/export a copy of the meeting file or text. Access changes use the share sheet. */
  const shareOrFallback = async (
    fileId: number | null | undefined,
    displayName: string,
    content?: string | null,
    fallbackExtension = 'txt',
  ) => {
    if (fileId != null) {
      try {
        await shareDocumentFile(fileId, displayName, { fallbackExtension });
        return;
      } catch {
        if (!content?.trim()) throw new Error('Could not download this file for sharing. Try again.');
      }
    }
    if (content?.trim()) {
      await shareTextContent(displayName, content, { extension: fallbackExtension });
      return;
    }
    throw new Error('Could not download this file for sharing. Try again.');
  };

  const handleShare = async () => {
    if (!canShare) return;
    try {
      const packId = shareFiles?.packFileId;
      if (packId != null) {
        try {
          await shareDocumentFile(packId, shareFiles?.packFileName || 'Meeting recap', {
            fallbackExtension: 'docx',
          });
          return;
        } catch {
          /* compose from loaded recap + transcript if the pack file cannot download */
        }
      }
      const composed = buildRecapShareMarkdown({
        hero: resolvedHero,
        summaryContent,
        transcriptContent,
        enrichment,
        meetingDurationSeconds,
      });
      if (composed.trim().length > 20) {
        await shareTextContent(shareFiles?.packFileName || 'Meeting recap', composed, {
          extension: 'txt',
        });
        return;
      }
      const summaryId = shareFiles?.summaryFileId;
      const transcriptId = shareFiles?.transcriptFileId;
      if (summaryId != null || summaryContent?.trim()) {
        await shareOrFallback(
          summaryId,
          shareFiles?.summaryFileName || 'Meeting recap',
          summaryContent,
          'json',
        );
      } else {
        await shareOrFallback(
          transcriptId,
          shareFiles?.transcriptFileName || 'Meeting recap',
          transcriptContent,
          'txt',
        );
        return;
      }
      if (transcriptId != null && transcriptId !== summaryId) {
        await shareOrFallback(
          transcriptId,
          shareFiles?.transcriptFileName || 'Meeting transcript',
          transcriptContent,
          'txt',
        );
      } else if (transcriptContent?.trim() && summaryId != null && transcriptId == null) {
        await shareOrFallback(null, shareFiles?.transcriptFileName || 'Meeting transcript', transcriptContent, 'txt');
      }
    } catch (error) {
      Alert.alert('Share', error instanceof Error ? error.message : 'Failed to share recap');
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.headerRow}>
        <View style={[styles.tabs, { backgroundColor: colors.inputBackground || colors.surface, borderColor: colors.border }]}>
          <TouchableOpacity
            onPress={() => setTab('recap')}
            style={[styles.tab, tab === 'recap' ? { backgroundColor: colors.card || colors.background } : null]}
          >
            <Text style={[styles.tabText, { color: tab === 'recap' ? colors.text : colors.textSecondary }]}>Recap</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setTab('transcript')}
            style={[styles.tab, tab === 'transcript' ? { backgroundColor: colors.card || colors.background } : null]}
          >
            <Text style={[styles.tabText, { color: tab === 'transcript' ? colors.text : colors.textSecondary }]}>
              Transcript
            </Text>
          </TouchableOpacity>
          {hasChat ? (
            <TouchableOpacity
              onPress={() => setTab('chat')}
              style={[styles.tab, tab === 'chat' ? { backgroundColor: colors.card || colors.background } : null]}
            >
              <Text style={[styles.tabText, { color: tab === 'chat' ? colors.text : colors.textSecondary }]}>
                Chat
                <Text style={{ fontWeight: '500', color: colors.textSecondary }}> {chatSummary.messageCount}</Text>
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {showHeaderActions && (canShare || canAsk) ? (
          <View style={styles.headerActions}>
            {canShare && accessFile != null ? (
              <TouchableOpacity onPress={() => setAccessOpen(true)} style={styles.actionBtn} accessibilityLabel="Share">
                <Ionicons name="share-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.actionText, { color: colors.textSecondary }]}>Share</Text>
              </TouchableOpacity>
            ) : null}
            {canShare ? (
              <TouchableOpacity onPress={() => void handleShare()} style={styles.actionBtn} accessibilityLabel="Send a copy">
                <Ionicons name="download-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.actionText, { color: colors.textSecondary }]}>Send a copy</Text>
              </TouchableOpacity>
            ) : null}
            {canAsk ? (
              <TouchableOpacity onPress={handleAsk} style={styles.actionBtn} accessibilityLabel="Ask ChatGD">
                <Ionicons name="chatbubbles" size={16} color="#007AFF" />
                <Text style={[styles.actionText, { color: colors.textSecondary }]}>Ask ChatGD</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>

      {showHeaderActions && (clientLink || (tab === 'recap' && onDownloadSummary) || (tab === 'transcript' && onDownloadTranscript)) ? (
        <View style={styles.actions}>
          <View style={styles.actionsLeft}>
            {clientLink ? (
              <ClientsButton itemType={clientLink.itemType} itemId={clientLink.itemId} compact />
            ) : null}
            {tab === 'recap' && onDownloadSummary ? (
              <TouchableOpacity onPress={onDownloadSummary} style={styles.actionBtn}>
                <Ionicons name="download-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.actionText, { color: colors.textSecondary }]}>Summary</Text>
              </TouchableOpacity>
            ) : null}
            {tab === 'transcript' && onDownloadTranscript ? (
              <TouchableOpacity onPress={onDownloadTranscript} style={styles.actionBtn}>
                <Ionicons name="download-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.actionText, { color: colors.textSecondary }]}>Transcript</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : null}

      {tab === 'transcript' ? (
        <View style={{ flex: 1 }}>
          <MeetingTranscriptView
            transcriptContent={transcriptContent}
            loading={loadingTranscript}
            recording={pickPreferredRecording(recordingOptions) || recording}
            recordings={recordingOptions}
            meetingDurationSeconds={meetingDurationSeconds}
            seekToSeconds={seekToSeconds}
          />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
          {tab === 'recap' ? (
            <MeetingRecapView
              summaryContent={summaryContent}
              loading={loadingSummary}
              hero={resolvedHero}
              extraSpeakerNames={extraSpeakers}
              enrichment={enrichment}
              transcriptContent={transcriptContent}
              meetingDurationSeconds={meetingDurationSeconds}
              onSeekTo={(seconds) => {
                setSeekToSeconds(seconds);
                setTab('transcript');
              }}
            />
          ) : (
            <MeetingChatView chatContent={chatContent} />
          )}
        </ScrollView>
      )}
      <ShareAccessSheet
        visible={accessOpen && accessFile != null}
        adapter={accessFile ? createFileShareAdapter(accessFile) : null}
        onClose={() => setAccessOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 },
  tabs: { flexDirection: 'row', borderRadius: 10, borderWidth: 1, padding: 3, flexShrink: 1 },
  tab: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8 },
  tabText: { fontSize: 14, fontWeight: '600' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 },
  actionsLeft: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, flex: 1 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { fontSize: 12 },
});
