import type { FileRowModel } from '../types/folder';
import { resolveDocumentListStatus } from './fileDisplayStatus';
import { parseAsUTC } from './timeFormatting';
import { removeFileExtension } from './fileUtils';

export interface MappedDocumentRow {
  id: string;
  name: string;
  type: string;
  size: string;
  uploadDate: Date;
  status: 'processed' | 'processing' | 'pending' | 'error';
  tags: string[];
  category?: string;
  file_kind?: string;
  original_filename?: string;
  filename?: string;
  storage_filename?: string;
  uploaded_original_filename?: string;
  is_editable_text?: boolean;
  file_type?: string;
  user_id?: number;
  in_locked_bookmark?: boolean;
}

function formatFileSize(bytes?: number): string {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileTypeFromExtension(filename?: string): string {
  const name = filename || '';
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : '';
  return ext || 'file';
}

export function mapFileRowToDocument(
  doc: FileRowModel,
  options?: { isUserReprocessing?: boolean }
): MappedDocumentRow {
  const originalName = doc.original_filename || doc.filename || 'Untitled';
  const status = resolveDocumentListStatus(doc, options);

  return {
    id: String(doc.id),
    name: removeFileExtension(originalName),
    type: getFileTypeFromExtension(originalName),
    size: formatFileSize(doc.file_size),
    uploadDate: parseAsUTC(doc.created_at || Date.now()),
    status,
    tags: [],
    file_kind: doc.file_kind,
    original_filename: originalName,
    filename: doc.filename,
    storage_filename: doc.storage_filename || doc.filename,
    uploaded_original_filename: doc.uploaded_original_filename,
    is_editable_text: doc.is_editable_text,
    file_type: doc.file_type,
    in_locked_bookmark: doc.in_locked_bookmark,
  };
}
