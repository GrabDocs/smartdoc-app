export type MeetingRecapTab = 'recap' | 'transcript' | 'chat';

export type MeetingRecapHero = {
  title?: string;
  dateLabel?: string;
  durationLabel?: string;
  attendees?: string[];
};

export type MeetingRecapRecording = {
  streamUrl: string;
  trackType?: string | null;
  label?: string;
  assetId?: string;
};

export type MeetingRecapClientLink = {
  itemType: 'video_call' | 'calendar_event';
  itemId: number;
};

export type MeetingRecapShareFiles = {
  summaryFileId?: number | null;
  summaryFileName?: string;
  transcriptFileId?: number | null;
  transcriptFileName?: string;
};

export type RecapChapter = {
  title: string;
  startSeconds?: number;
  clock?: string;
};

export type RecapTimedAction = {
  text: string;
  startSeconds?: number;
  clock?: string;
  speaker?: string | null;
};

export type MeetingRecapEnrichment = {
  chapters?: RecapChapter[];
  action_items?: RecapTimedAction[];
  skipped?: string;
};

export type MeetingRecapAskContext = {
  fileIds?: number[];
  transcriptIds?: number[];
  labels?: { id: number; name: string; kind: 'file' | 'transcript' }[];
};

export function isAudioTrackType(trackType?: string | null): boolean {
  return typeof trackType === 'string' && /audio/i.test(trackType);
}

export function formatMeetingDurationLabel(
  startedAt?: string | null,
  endedAt?: string | null,
  durationSeconds?: number | null
): string | undefined {
  if (durationSeconds != null && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    const total = Math.round(durationSeconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${Math.max(1, minutes)} min`;
  }
  if (!startedAt || !endedAt) return undefined;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return formatMeetingDurationLabel(null, null, (end - start) / 1000);
}

export function isTranscriptAssetType(type?: string | null): boolean {
  return type === 'transcript' || type === 'call_transcript';
}

export function isSummaryAssetType(type?: string | null): boolean {
  return type === 'meeting_summary' || type === 'summary';
}

export function isChatAssetType(type?: string | null): boolean {
  return type === 'meeting_chat' || type === 'chat' || type === 'chat_log' || type === 'call_chat';
}

export function recordingLabel(trackType?: string | null): string {
  return isAudioTrackType(trackType) ? 'Audio' : 'Video';
}

export function pickPreferredRecording<T extends { trackType?: string | null; track_type?: string | null }>(
  recordings: T[]
): T | null {
  if (!recordings.length) return null;
  return (
    recordings.find((row) => !isAudioTrackType(row.trackType || row.track_type)) || recordings[0]
  );
}

function recordingIdentity(row: {
  streamUrl?: string | null;
  id?: unknown;
  recording_db_id?: unknown;
  file_id?: unknown;
  url?: string | null;
}): string {
  const recId =
    parseNumericId(row.recording_db_id) ??
    parseNumericId(String(row.id || '').match(/call_recording[_-](\d+)/i)?.[1]) ??
    parseNumericId((row.streamUrl || row.url || '').match(/\/recording\/(\d+)\/(?:stream|download)/i)?.[1]);
  if (recId != null) return `rec:${recId}`;
  const fileId = parseNumericId(row.file_id);
  if (fileId != null) return `file:${fileId}`;
  const url = (row.streamUrl || row.url || '').split('?')[0];
  return url || `id:${String(row.id || '')}`;
}

function isPreferredPlaybackSource(row: {
  streamUrl?: string | null;
  id?: unknown;
  recording_db_id?: unknown;
  url?: string | null;
}): boolean {
  if (parseNumericId(row.recording_db_id) != null) return true;
  if (/call_recording[_-]\d+/i.test(String(row.id || ''))) return true;
  return /\/recording\/\d+\/(?:stream|download)/i.test(row.streamUrl || row.url || '');
}

/** One video + one audio max; drop duplicate listings of the same recording. */
export function collapseRecapRecordings<
  T extends {
    streamUrl?: string | null;
    trackType?: string | null;
    track_type?: string | null;
    id?: unknown;
    recording_db_id?: unknown;
    file_id?: unknown;
    url?: string | null;
  },
>(rows: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    const key = recordingIdentity(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  const audio = unique.filter((row) => isAudioTrackType(row.trackType || row.track_type));
  const video = unique.filter((row) => !isAudioTrackType(row.trackType || row.track_type));
  const rankedVideo = video
    .slice()
    .sort((a, b) => Number(isPreferredPlaybackSource(b)) - Number(isPreferredPlaybackSource(a)));
  if (rankedVideo.length <= 1) return [...rankedVideo, ...audio];
  return [rankedVideo[0], ...audio];
}

export function collapseMeetingRecapAssets<T extends { id?: unknown; type?: string }>(assets: T[]): T[] {
  let transcript: T | null = null;
  let summary: T | null = null;
  let chat: T | null = null;
  const rest: T[] = [];
  for (const asset of assets) {
    if (isTranscriptAssetType(asset.type)) {
      const id = String(asset.id ?? '');
      if (!transcript || id.startsWith('call_transcript_') || id.startsWith('file_transcript_')) {
        transcript = asset;
      }
      continue;
    }
    if (isSummaryAssetType(asset.type)) {
      if (!summary) summary = asset;
      continue;
    }
    if (isChatAssetType(asset.type)) {
      if (!chat) chat = asset;
      continue;
    }
    rest.push(asset);
  }
  if (!transcript && !summary) return assets;
  const recapV2 =
    (transcript as { recap_v2?: unknown } | null)?.recap_v2 ||
    (summary as { recap_v2?: unknown } | null)?.recap_v2;
  const recap = {
    ...(summary || transcript),
    type: 'meeting_recap',
    title: 'Meeting recap',
    _recapTranscript: transcript,
    _recapSummary: summary,
    _recapChat: chat,
    recap_v2: recapV2,
  } as T;
  return [recap, ...rest];
}

export function parseNumericId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/(\d+)/);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
