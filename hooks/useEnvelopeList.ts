import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../app/context/auth';
import {
  ENVELOPE_LIST_PAGE_SIZE,
  invalidateEnvelopeListCache,
  isEnvelopeListStale,
  readEnvelopeListMemory,
  readEnvelopeListStorage,
  writeEnvelopeListMemory,
  type EnvelopeListCacheEntry,
} from '../services/envelopeListCache';
import { listEnvelopes, type EnvelopeTab } from '../services/envelopeApi';
import type { Envelope } from '../types/signature';

export { ENVELOPE_LIST_PAGE_SIZE, invalidateEnvelopeListCache };

export type EnvelopeListFilters = {
  q?: string;
  status?: string;
  source_type?: string;
};

function applyEntry(entry: EnvelopeListCacheEntry) {
  return {
    envelopes: entry.envelopes,
    hasMore: entry.hasMore,
    offset: entry.envelopes.length,
  };
}

export function useEnvelopeList(tab: EnvelopeTab, filters?: EnvelopeListFilters) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loadSeqRef = useRef(0);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const userIdRef = useRef(userId);
  const q = (filters?.q || '').trim();
  const status = filters?.status || '';
  const sourceType = filters?.source_type || '';
  const hasFilters = Boolean(q || status || sourceType);
  const qRef = useRef(q);
  const statusRef = useRef(status);
  const sourceTypeRef = useRef(sourceType);
  const hasFiltersRef = useRef(hasFilters);
  qRef.current = q;
  statusRef.current = status;
  sourceTypeRef.current = sourceType;
  hasFiltersRef.current = hasFilters;

  const commitEntry = useCallback(
    (tabKey: EnvelopeTab, next: Envelope[], nextHasMore: boolean, ownerId: string | number) => {
      const entry: EnvelopeListCacheEntry = {
        envelopes: next,
        hasMore: nextHasMore,
        fetchedAt: Date.now(),
      };
      if (!hasFiltersRef.current) {
        writeEnvelopeListMemory(ownerId, tabKey, entry);
      }
      offsetRef.current = next.length;
      hasMoreRef.current = nextHasMore;
      setEnvelopes(next);
      setHasMore(nextHasMore);
    },
    [],
  );

  const fetchPage = useCallback(
    async (
      tabKey: EnvelopeTab,
      ownerId: string | number,
      offset: number,
      append: boolean,
      seq: number,
    ) => {
      const res = await listEnvelopes({
        tab: tabKey,
        limit: ENVELOPE_LIST_PAGE_SIZE,
        offset,
        fields: 'meta',
        ...(qRef.current ? { q: qRef.current } : {}),
        ...(statusRef.current ? { status: statusRef.current } : {}),
        ...(sourceTypeRef.current ? { source_type: sourceTypeRef.current } : {}),
      });
      if (seq !== loadSeqRef.current || userIdRef.current !== ownerId) return;
      const items = res.envelopes ?? [];
      const nextHasMore = Boolean(res.has_more);
      if (append) {
        setEnvelopes((prev) => {
          const next = [...prev, ...items];
          commitEntry(tabKey, next, nextHasMore, ownerId);
          return next;
        });
      } else {
        commitEntry(tabKey, items, nextHasMore, ownerId);
      }
    },
    [commitEntry],
  );

  const loadFirstPage = useCallback(
    async (
      tabKey: EnvelopeTab,
      ownerId: string | number,
      opts?: { force?: boolean; background?: boolean },
    ) => {
      const seq = ++loadSeqRef.current;
      const hit = !opts?.force ? readEnvelopeListMemory(ownerId, tabKey) : null;

      if (hit && !opts?.background) {
        const applied = applyEntry(hit);
        setEnvelopes(applied.envelopes);
        offsetRef.current = applied.offset;
        hasMoreRef.current = applied.hasMore;
        setHasMore(applied.hasMore);
        setLoading(false);
      } else if (!opts?.background && !hit) {
        setLoading(true);
      }

      try {
        await fetchPage(tabKey, ownerId, 0, false, seq);
      } catch {
        if (seq !== loadSeqRef.current || userIdRef.current !== ownerId) return;
        if (!hit) {
          commitEntry(tabKey, [], false, ownerId);
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

  const revalidateIfStale = useCallback(async () => {
    if (!userId) return;
    const hit = readEnvelopeListMemory(userId, tab);
    if (hit && !isEnvelopeListStale(hit)) return;
    await loadFirstPage(tab, userId, { background: Boolean(hit) });
  }, [loadFirstPage, tab, userId]);

  const loadMore = useCallback(async () => {
    if (!userId || loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const seq = loadSeqRef.current;
    const ownerId = userId;
    try {
      await fetchPage(tab, ownerId, offsetRef.current, true, seq);
    } catch {
      // keep existing rows
    } finally {
      if (seq === loadSeqRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [fetchPage, tab, userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    invalidateEnvelopeListCache();
    await loadFirstPage(tab, userId, { force: true, background: true });
  }, [loadFirstPage, tab, userId]);

  // Reset when account changes — never show another user's cached rows.
  useEffect(() => {
    userIdRef.current = userId;
    loadSeqRef.current += 1;
    setEnvelopes([]);
    setHasMore(true);
    offsetRef.current = 0;
    hasMoreRef.current = true;

    if (!userId) {
      setLoading(false);
      return;
    }

    if (hasFilters) {
      setLoading(true);
      setEnvelopes([]);
      void loadFirstPage(tab, userId, { force: true });
      return;
    }

    let cancelled = false;
    const hit = readEnvelopeListMemory(userId, tab);
    if (hit) {
      const applied = applyEntry(hit);
      setEnvelopes(applied.envelopes);
      offsetRef.current = applied.offset;
      hasMoreRef.current = applied.hasMore;
      setHasMore(applied.hasMore);
      setLoading(false);
      if (!isEnvelopeListStale(hit)) return;
      void loadFirstPage(tab, userId, { background: true });
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    void (async () => {
      const stored = await readEnvelopeListStorage(userId, tab);
      if (cancelled || userIdRef.current !== userId) return;
      if (stored) {
        const applied = applyEntry(stored);
        setEnvelopes(applied.envelopes);
        offsetRef.current = applied.offset;
        hasMoreRef.current = applied.hasMore;
        setHasMore(applied.hasMore);
        setLoading(false);
        writeEnvelopeListMemory(userId, tab, stored);
      }
      await loadFirstPage(tab, userId, { background: Boolean(stored) });
    })();

    return () => {
      cancelled = true;
    };
  }, [tab, userId, loadFirstPage, q, status, sourceType]);

  return {
    envelopes,
    loading,
    loadingMore,
    refreshing,
    hasMore,
    loadMore,
    refresh,
    revalidateIfStale,
    invalidateCache: () => invalidateEnvelopeListCache(),
  };
}
