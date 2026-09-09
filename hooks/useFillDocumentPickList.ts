import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../app/context/auth';
import { apiService } from '../services/api';
import {
  FILL_PICK_PAGE_SIZE,
  invalidateFillPickListCache,
  isFillPickListStale,
  readFillPickMemory,
  readFillPickStorage,
  writeFillPickMemory,
  type FillPickFile,
  type FillPickListCacheEntry,
} from '../services/fillDocumentListCache';
import { sanitizeDisplayFilename } from '../utils/displayFilename';
import { parseUtcMs } from '../utils/timeFormatting';

export { FILL_PICK_PAGE_SIZE, invalidateFillPickListCache };

function parseFilesResponse(res: {
  files?: unknown[];
  data?: unknown;
}): Record<string, unknown>[] {
  if (Array.isArray(res.files)) return res.files as Record<string, unknown>[];
  if (Array.isArray(res.data)) return res.data as Record<string, unknown>[];
  const nested = (res.data as { files?: unknown[] } | undefined)?.files;
  return Array.isArray(nested) ? (nested as Record<string, unknown>[]) : [];
}

function toAccountFile(raw: Record<string, unknown>): FillPickFile | null {
  const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
  if (!id || Number.isNaN(id)) return null;
  const rawName = String(raw.original_filename ?? raw.filename ?? raw.name ?? 'Document');
  const name = sanitizeDisplayFilename(rawName);
  const updatedAt =
    typeof raw.updated_at === 'string'
      ? raw.updated_at
      : typeof raw.modified_at === 'string'
        ? raw.modified_at
        : undefined;
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : undefined;
  const fileSize = typeof raw.file_size === 'number' ? raw.file_size : undefined;
  const fileKind = typeof raw.file_kind === 'string' ? raw.file_kind : undefined;
  return { id, name, updatedAt, createdAt, fileSize, fileKind };
}

function sortNewestFirst(files: FillPickFile[]): FillPickFile[] {
  return [...files].sort((a, b) => {
    const aTs = parseUtcMs(a.updatedAt ?? a.createdAt ?? 0);
    const bTs = parseUtcMs(b.updatedAt ?? b.createdAt ?? 0);
    return bTs - aTs;
  });
}

function applyEntry(entry: FillPickListCacheEntry) {
  return {
    files: entry.files,
    hasMore: entry.hasMore,
    page: Math.max(1, Math.ceil(entry.files.length / FILL_PICK_PAGE_SIZE)),
  };
}

export function useFillDocumentPickList(debouncedQuery: string) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const search = debouncedQuery.trim();
  const [files, setFiles] = useState<FillPickFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loadSeqRef = useRef(0);
  const pageRef = useRef(1);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const userIdRef = useRef(userId);

  const commitEntry = useCallback(
    (ownerId: string | number, searchKey: string, next: FillPickFile[], nextHasMore: boolean) => {
      const entry: FillPickListCacheEntry = {
        files: next,
        hasMore: nextHasMore,
        fetchedAt: Date.now(),
      };
      writeFillPickMemory(ownerId, searchKey, entry);
      hasMoreRef.current = nextHasMore;
      setHasMore(nextHasMore);
      setFiles(next);
    },
    [],
  );

  const fetchPage = useCallback(
    async (
      ownerId: string | number,
      searchKey: string,
      pageNum: number,
      mode: 'replace' | 'append',
      seq: number,
    ) => {
      const res = await apiService.getDocuments(
        pageNum,
        FILL_PICK_PAGE_SIZE,
        searchKey || undefined,
        undefined,
        undefined,
        false,
        true,
        undefined,
        undefined,
        {
          folderId: null,
          folderAware: true,
          scope: searchKey ? 'global' : 'current_folder',
        },
      );
      if (seq !== loadSeqRef.current || userIdRef.current !== ownerId) return;
      const mapped = parseFilesResponse(res)
        .map(toAccountFile)
        .filter(Boolean) as FillPickFile[];
      const sorted = sortNewestFirst(mapped);
      const pagination = (res as { pagination?: { has_more?: boolean } }).pagination;
      const nextHasMore = Boolean(pagination?.has_more) || sorted.length >= FILL_PICK_PAGE_SIZE;

      if (mode === 'replace') {
        commitEntry(ownerId, searchKey, sorted, nextHasMore);
        pageRef.current = pageNum;
        return;
      }

      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.id));
        const merged = [...prev];
        for (const f of sorted) {
          if (!seen.has(f.id)) merged.push(f);
        }
        const next = sortNewestFirst(merged);
        commitEntry(ownerId, searchKey, next, nextHasMore);
        pageRef.current = pageNum;
        return next;
      });
    },
    [commitEntry],
  );

  const loadFirstPage = useCallback(
    async (
      ownerId: string | number,
      searchKey: string,
      opts?: { force?: boolean; background?: boolean },
    ) => {
      const seq = ++loadSeqRef.current;
      const hit = !opts?.force ? readFillPickMemory(ownerId, searchKey) : null;

      if (hit && !opts?.background) {
        const applied = applyEntry(hit);
        setFiles(applied.files);
        pageRef.current = applied.page;
        hasMoreRef.current = applied.hasMore;
        setHasMore(applied.hasMore);
        setLoading(false);
      } else if (!opts?.background && !hit) {
        setLoading(true);
      }

      try {
        await fetchPage(ownerId, searchKey, 1, 'replace', seq);
      } catch {
        if (seq !== loadSeqRef.current || userIdRef.current !== ownerId) return;
        if (!hit) {
          commitEntry(ownerId, searchKey, [], false);
          pageRef.current = 1;
        }
      } finally {
        if (seq === loadSeqRef.current && userIdRef.current === ownerId) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [commitEntry, fetchPage],
  );

  const loadMore = useCallback(async () => {
    if (!userId || loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const seq = loadSeqRef.current;
    const nextPage = pageRef.current + 1;
    try {
      await fetchPage(userId, search, nextPage, 'append', seq);
    } catch {
      // keep existing rows
    } finally {
      if (seq === loadSeqRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [fetchPage, search, userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    invalidateFillPickListCache();
    await loadFirstPage(userId, search, { force: true, background: true });
  }, [loadFirstPage, search, userId]);

  useEffect(() => {
    userIdRef.current = userId;
    loadSeqRef.current += 1;
    setFiles([]);
    setHasMore(true);
    pageRef.current = 1;
    hasMoreRef.current = true;

    if (!userId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const hit = readFillPickMemory(userId, search);
    if (hit) {
      const applied = applyEntry(hit);
      setFiles(applied.files);
      pageRef.current = applied.page;
      hasMoreRef.current = applied.hasMore;
      setHasMore(applied.hasMore);
      setLoading(false);
      if (!isFillPickListStale(hit)) return;
      void loadFirstPage(userId, search, { background: true });
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    void (async () => {
      const stored = await readFillPickStorage(userId, search);
      if (cancelled || userIdRef.current !== userId) return;
      if (stored) {
        const applied = applyEntry(stored);
        setFiles(applied.files);
        pageRef.current = applied.page;
        hasMoreRef.current = applied.hasMore;
        setHasMore(applied.hasMore);
        setLoading(false);
        writeFillPickMemory(userId, search, stored);
      }
      await loadFirstPage(userId, search, { background: Boolean(stored) });
    })();

    return () => {
      cancelled = true;
    };
  }, [loadFirstPage, search, userId]);

  return {
    files,
    loading,
    loadingMore,
    refreshing,
    hasMore,
    loadMore,
    refresh,
  };
}
