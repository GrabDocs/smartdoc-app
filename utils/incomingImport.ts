import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { sanitizeDisplayFilename } from './displayFilename';

const STORAGE_KEY = 'grabdocs_incoming_import_v1';

const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const SIGN_FILL_EXTENSIONS = new Set(['pdf', 'doc', 'docx']);
const CALENDAR_EXTENSIONS = new Set(['ics']);

export type IncomingKind = 'document' | 'calendar';

export type IncomingFile = {
  uri: string;
  name: string;
  mimeType: string;
  extension: string;
  kind: IncomingKind;
};

export type IncomingImportPayload = {
  files: IncomingFile[];
  createdAt: number;
};

export function extensionOf(name: string): string {
  const base = sanitizeDisplayFilename(name);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function kindForExtension(extension: string): IncomingKind | null {
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (CALENDAR_EXTENSIONS.has(extension)) return 'calendar';
  return null;
}

export function canSignOrFill(file: IncomingFile): boolean {
  return file.kind === 'document' && SIGN_FILL_EXTENSIONS.has(file.extension);
}

export function mimeForExtension(extension: string, fallback?: string | null): string {
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'ppt':
      return 'application/vnd.ms-powerpoint';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'ics':
      return 'text/calendar';
    default:
      return fallback || 'application/octet-stream';
  }
}

function safeFileName(name: string): string {
  const cleaned = sanitizeDisplayFilename(name).replace(/[^\w.\- ()]+/g, '_');
  return cleaned.slice(0, 180) || 'document';
}

function decodeBase64(input: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  let out = '';
  for (let i = 0; i < clean.length; i += 4) {
    const a = alphabet.indexOf(clean[i] || '');
    const b = alphabet.indexOf(clean[i + 1] || '');
    const c = alphabet.indexOf(clean[i + 2] || '');
    const d = alphabet.indexOf(clean[i + 3] || '');
    if (a < 0 || b < 0) break;
    const n = (a << 18) | (b << 12) | ((c > -1 ? c : 0) << 6) | (d > -1 ? d : 0);
    out += String.fromCharCode((n >> 16) & 255);
    if (c > -1) out += String.fromCharCode((n >> 8) & 255);
    if (d > -1) out += String.fromCharCode(n & 255);
  }
  return out;
}

/** Mail and Android Open With often omit the extension. Identify the type from the file bytes. */
async function sniffIncomingExtension(uri: string): Promise<string | null> {
  try {
    const encoded = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 262144,
    });
    const sample = decodeBase64(encoded);
    if (sample.startsWith('%PDF')) return 'pdf';
    if (sample.includes('BEGIN:VCALENDAR')) return 'ics';
    if (sample.startsWith('PK')) {
      if (sample.includes('word/')) return 'docx';
      if (sample.includes('xl/')) return 'xlsx';
      if (sample.includes('ppt/')) return 'pptx';
      return null;
    }
    if (sample.charCodeAt(0) === 0xd0 && sample.charCodeAt(1) === 0xcf) {
      if (sample.includes('WordDocument')) return 'doc';
      if (sample.includes('PowerPoint')) return 'ppt';
      if (sample.includes('Workbook')) return 'xls';
    }
    return null;
  } catch {
    return null;
  }
}

export function displayNameFromIncomingUrl(url: string): string {
  const path = url.split('?')[0] || url;
  let raw = path.split('/').pop() || 'document';
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Keep the raw segment when it is not encoded.
  }
  const tail = raw.split(':').pop() || raw;
  return tail.split('/').pop() || 'document';
}

export async function copyIncomingFile(sourceUri: string, name: string, mimeType?: string | null): Promise<IncomingFile | null> {
  const dir = `${FileSystem.cacheDirectory}incoming-import/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const temp = `${dir}${Date.now()}-incoming`;
  await FileSystem.copyAsync({ from: sourceUri, to: temp });

  let displayName = safeFileName(name);
  let extension = extensionOf(displayName);
  if (!kindForExtension(extension)) {
    const sniffed = await sniffIncomingExtension(temp);
    if (!sniffed) {
      await FileSystem.deleteAsync(temp, { idempotent: true }).catch(() => {});
      return null;
    }
    extension = sniffed;
    const stem = displayName.replace(/\.[^.]+$/, '') || 'document';
    displayName = `${stem}.${extension}`.slice(0, 180);
  }

  const kind = kindForExtension(extension);
  if (!kind) {
    await FileSystem.deleteAsync(temp, { idempotent: true }).catch(() => {});
    return null;
  }

  const dest = `${dir}${Date.now()}-${displayName}`;
  await FileSystem.copyAsync({ from: temp, to: dest });
  await FileSystem.deleteAsync(temp, { idempotent: true }).catch(() => {});
  return {
    uri: dest,
    name: displayName,
    mimeType: mimeForExtension(extension, mimeType),
    extension,
    kind,
  };
}

export async function saveIncomingImport(files: IncomingFile[]): Promise<IncomingImportPayload> {
  const payload: IncomingImportPayload = { files, createdAt: Date.now() };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  return payload;
}

export async function peekIncomingImport(): Promise<IncomingImportPayload | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IncomingImportPayload;
    if (!parsed?.files?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearIncomingImport(): Promise<void> {
  const pending = await peekIncomingImport();
  await AsyncStorage.removeItem(STORAGE_KEY);
  const dir = `${FileSystem.cacheDirectory}incoming-import/`;
  await Promise.all(
    (pending?.files || []).map((file) => {
      if (!file.uri?.startsWith(dir)) return Promise.resolve();
      return FileSystem.deleteAsync(file.uri, { idempotent: true }).catch(() => {});
    }),
  );
}
