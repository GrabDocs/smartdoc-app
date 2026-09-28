import * as FileSystem from 'expo-file-system/legacy';
import { API_BASE_URL, STORAGE_KEYS } from '../constants/Config';
import { secureStorage } from './storage';

const inflightDownloads = new Map<string, Promise<string | null>>();

export async function getAuthToken(): Promise<string | null> {
  try {
    return await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
  } catch {
    return null;
  }
}

export function getAudioCachePath(assetId?: string, url?: string): string {
  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
  const key = assetId || (url ? 'url_' + String(url.split('').reduce((a: number, b: string) => ((a << 5) - a) + b.charCodeAt(0), 0) % 1e9) : 'audio');
  const safe = key.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 80);
  return `${dir}meeting_audio_${safe}.m4a`;
}

export function getVideoCachePath(assetId?: string, url?: string): string {
  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
  const key = assetId || (url ? 'url_' + String(url.split('').reduce((a: number, b: string) => ((a << 5) - a) + b.charCodeAt(0), 0) % 1e9) : 'video');
  const safe = key.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 80);
  return `${dir}meeting_video_${safe}.mp4`;
}

export function fileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

export async function cachedFileUri(path: string): Promise<string | null> {
  try {
    const cached = await FileSystem.getInfoAsync(path);
    if (cached.exists && (cached.size ?? 0) > 0) return fileUri(path);
  } catch {
    /* fall through */
  }
  return null;
}

/** Same URL rules as meeting-details playVideoWithCache / playAudioWithCache. */
export function withPlaybackAuthUrl(url: string, token: string | null, asStreamMp4: boolean): string {
  let finalUrl = url;
  if (token && !finalUrl.includes('token=')) {
    finalUrl += `${finalUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }
  if (asStreamMp4 && finalUrl.includes('/recording/') && finalUrl.includes('/stream') && !finalUrl.includes('format=mp4')) {
    finalUrl += finalUrl.includes('?') ? '&format=mp4' : '?format=mp4';
  }
  return finalUrl;
}

export async function prepareVideoPlayback(videoUrl: string, assetId?: string) {
  const token = await getAuthToken();
  const finalUrl = withPlaybackAuthUrl(videoUrl, token, true);
  const cachePath = getVideoCachePath(assetId, finalUrl);
  const cachedUri = await cachedFileUri(cachePath);
  return {
    token,
    finalUrl,
    cachePath,
    uriToPlay: cachedUri || finalUrl,
    isPlayingFromCache: !!cachedUri,
  };
}

export async function prepareAudioPlayback(audioUrl: string, assetId?: string) {
  const token = await getAuthToken();
  const finalUrl = withPlaybackAuthUrl(audioUrl, token, false);
  const cachePath = getAudioCachePath(assetId, audioUrl);
  const cachedUri = await cachedFileUri(cachePath);
  return { token, finalUrl, cachePath, cachedUri };
}

function downloadKey(kind: 'video' | 'audio', url: string): string {
  const id = url.match(/\/recording\/(\d+)\//)?.[1];
  return `${kind}:${id || url.split('?')[0]}`;
}

export function recordingDownloadUrl(recordingUrl: string, token: string | null, kind: 'video' | 'audio'): string | null {
  const recordingId = recordingUrl.match(/\/recording\/(\d+)\//)?.[1];
  if (!recordingId) return null;
  const base = `${API_BASE_URL}/api/v1/video/recording/${recordingId}/download`;
  if (kind === 'video') {
    return token ? `${base}?token=${encodeURIComponent(token)}&format=mp4` : `${base}?format=mp4`;
  }
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/** One in-flight cache download per recording. Same endpoints as the old tile player. */
export function startRecordingCacheDownload(args: {
  recordingUrl: string;
  token: string | null;
  cachePath: string;
  kind: 'video' | 'audio';
}): Promise<string | null> {
  const key = downloadKey(args.kind, args.recordingUrl);
  const existing = inflightDownloads.get(key);
  if (existing) return existing;
  const downloadUrl = recordingDownloadUrl(args.recordingUrl, args.token, args.kind);
  if (!downloadUrl) return Promise.resolve(null);
  const pending = FileSystem.downloadAsync(downloadUrl, args.cachePath)
    .then(() => cachedFileUri(args.cachePath))
    .catch(() => null)
    .finally(() => {
      if (inflightDownloads.get(key) === pending) inflightDownloads.delete(key);
    });
  inflightDownloads.set(key, pending);
  return pending;
}
