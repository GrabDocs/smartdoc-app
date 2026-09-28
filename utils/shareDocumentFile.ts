import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Alert, Platform, Share } from 'react-native';
import { API_BASE_URL, STORAGE_KEYS } from '../constants/Config';
import { apiClient } from '../services/api';
import { secureStorage } from './storage';

const SHARE_CLEANUP_MS = 30 * 60_000;
const SHARE_CACHE_PREFIX = 'grabdocs_share_';

/** In-flight downloads keyed by file id — menu prefetch + Share tap share one promise. */
const inflightByFileId = new Map<string, Promise<PreparedShareFile>>();
let sharingAvailableCache: boolean | null = null;

type PreparedShareFile = {
  localUri: string;
  mimeType: string;
  displayName: string;
};

function mimeTypeFromExtension(extension: string): string {
  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    json: 'application/json',
    md: 'text/markdown',
    csv: 'text/csv',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/_+/g, '_');
}

/** Ensure the cached share file has a real extension so Mail/Files recognize the attachment. */
function resolveShareFilename(rawName: string, fallbackExt = 'pdf'): { filename: string; extension: string } {
  const base = sanitizeFilename(rawName.trim() || 'document');
  const extMatch = base.match(/\.([a-z0-9]{2,8})$/i);
  if (extMatch) {
    return { filename: base, extension: extMatch[1].toLowerCase() };
  }
  const ext = fallbackExt.toLowerCase();
  return { filename: `${base}.${ext}`, extension: ext };
}

function downloadHeadersForUrl(url: string, token: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'X-Platform': Platform.OS };
  const urlIsSigned = url.includes('sig=') && url.includes('exp=');
  if (!urlIsSigned && token && url.startsWith(API_BASE_URL)) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function readLocalFileHeadBytes(uri: string, byteLength: number): Promise<Uint8Array | null> {
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      length: byteLength,
      position: 0,
    });
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function inferMimeFromMagic(bytes: Uint8Array | null): string | null {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf';
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'application/zip';
  }
  return null;
}

function looksLikeErrorPayload(bytes: Uint8Array | null, extension?: string): boolean {
  if (!bytes || bytes.length < 1) return true;
  const first = bytes[0];
  if (first === 0x3c) return true; // HTML error/login page
  if (first !== 0x7b) return false;
  const head = String.fromCharCode(...Array.from(bytes));
  if (/"error"\s*:/i.test(head) || /"success"\s*:\s*false/i.test(head)) return true;
  const ext = (extension || '').toLowerCase();
  // Meeting recaps and other text assets are valid JSON — do not treat `{` as failure.
  if (ext === 'json' || ext === 'txt' || ext === 'md' || ext === 'csv') return false;
  return true;
}

function cacheDirOrThrow(): string {
  const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!cacheDir) {
    throw new Error('Unable to access file system directories');
  }
  return cacheDir;
}

function stableShareUri(fileId: string | number, filename: string): string {
  return `${cacheDirOrThrow()}${SHARE_CACHE_PREFIX}${fileId}_${filename}`;
}

async function presentShareSheet(localUri: string, shareMime: string, displayName: string): Promise<void> {
  if (sharingAvailableCache == null) {
    sharingAvailableCache = await Sharing.isAvailableAsync();
  }
  if (sharingAvailableCache) {
    try {
      await Sharing.shareAsync(localUri, {
        mimeType: shareMime,
        dialogTitle: `Share ${displayName}`,
      });
      return;
    } catch {
      try {
        await Sharing.shareAsync(localUri, {
          dialogTitle: `Share ${displayName}`,
        });
        return;
      } catch {
        // fall through to platform Share API
      }
    }
  }

  if (Platform.OS === 'ios') {
    const fileUrl = localUri.startsWith('file://') ? localUri : `file://${localUri.replace(/^\/+/, '')}`;
    await Share.share({
      title: displayName,
      url: fileUrl,
    });
    return;
  }

  if (Platform.OS === 'android') {
    await Share.share({
      title: displayName,
      message: displayName,
      url: localUri,
    });
    return;
  }

  Alert.alert('Share', localUri);
}

function scheduleShareFileCleanup(uri: string) {
  setTimeout(() => {
    void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }, SHARE_CLEANUP_MS);
}

async function readValidCachedShare(
  localUri: string,
  extension: string,
  displayName: string,
): Promise<PreparedShareFile | null> {
  try {
    const info = await FileSystem.getInfoAsync(localUri);
    if (!info.exists || !('size' in info) || !info.size || info.size < 1) return null;
    const magicBytes = await readLocalFileHeadBytes(localUri, 16);
    if (looksLikeErrorPayload(magicBytes, extension)) {
      await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
      return null;
    }
    return {
      localUri,
      mimeType: inferMimeFromMagic(magicBytes) ?? mimeTypeFromExtension(extension),
      displayName,
    };
  } catch {
    return null;
  }
}

async function downloadAndPrepareShareFile(
  fileId: number | string,
  displayName: string,
  opts?: { fallbackExtension?: string },
): Promise<PreparedShareFile> {
  const [fileInfo, token] = await Promise.all([
    apiClient.downloadFile(Number(fileId)),
    secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN).catch(() => null as string | null),
  ]);
  if (!fileInfo.url) {
    throw new Error('Failed to get file download URL');
  }

  const { filename, extension } = resolveShareFilename(
    fileInfo.filename || displayName,
    opts?.fallbackExtension ?? 'pdf',
  );
  const fileUri = stableShareUri(fileId, filename);

  const cached = await readValidCachedShare(fileUri, extension, displayName);
  if (cached) return cached;

  const downloadResult = await FileSystem.downloadAsync(fileInfo.url, fileUri, {
    headers: downloadHeadersForUrl(fileInfo.url, token),
  });

  if (downloadResult.status < 200 || downloadResult.status >= 300) {
    await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true }).catch(() => {});
    throw new Error(`Download failed (HTTP ${downloadResult.status}). Try again.`);
  }

  const prepared = await readValidCachedShare(downloadResult.uri, extension, displayName);
  if (!prepared) {
    await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true }).catch(() => {});
    throw new Error('Could not download this file for sharing. Try again.');
  }

  scheduleShareFileCleanup(prepared.localUri);
  return prepared;
}

function prepareShareFile(
  fileId: number | string,
  displayName: string,
  opts?: { fallbackExtension?: string },
): Promise<PreparedShareFile> {
  const key = String(fileId);
  const existing = inflightByFileId.get(key);
  if (existing) return existing;

  const promise = downloadAndPrepareShareFile(fileId, displayName, opts).finally(() => {
    if (inflightByFileId.get(key) === promise) {
      inflightByFileId.delete(key);
    }
  });
  inflightByFileId.set(key, promise);
  return promise;
}

/**
 * Start preparing a local copy as soon as the file menu opens so Share can open immediately.
 * Safe to call repeatedly; shares one in-flight download per file id.
 */
export function prefetchShareDocumentFile(
  fileId: number | string,
  displayName: string,
  opts?: { fallbackExtension?: string },
): void {
  void prepareShareFile(fileId, displayName, opts).catch(() => {
    /* prefetch is best-effort */
  });
}

/** Download (or reuse cache) and open the native share sheet with a valid local attachment. */
export async function shareDocumentFile(
  fileId: number | string,
  displayName: string,
  opts?: { fallbackExtension?: string },
): Promise<void> {
  const prepared = await prepareShareFile(fileId, displayName, opts);
  await presentShareSheet(prepared.localUri, prepared.mimeType, prepared.displayName);
}

/** Share already-loaded text (meeting recap JSON, transcript) without a download. */
export async function shareTextContent(
  displayName: string,
  content: string,
  opts?: { extension?: string },
): Promise<void> {
  const text = (content || '').trim();
  if (!text) {
    throw new Error('Nothing to share');
  }
  const inferred = text.startsWith('{') || text.startsWith('[') ? 'json' : 'txt';
  const { filename, extension } = resolveShareFilename(displayName, opts?.extension || inferred);
  const fileUri = `${cacheDirOrThrow()}${SHARE_CACHE_PREFIX}inline_${filename}`;
  await FileSystem.writeAsStringAsync(fileUri, content);
  scheduleShareFileCleanup(fileUri);
  await presentShareSheet(fileUri, mimeTypeFromExtension(extension), displayName);
}
