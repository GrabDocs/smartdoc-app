import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCalendarEncryptedBlob, removeCalendarEncryptedBlob, setCalendarEncryptedBlob } from './calendarEncryptedStorage';
import { defaultCalendarListWindow, toLocalDateString } from './calendarTime';

/** Legacy single-slot cache (migrated into v2 store). */
const LEGACY_STORAGE_KEY = '@grabdocs_calendar_list_cache_v1';

const STORE_KEY = '@grabdocs_calendar_offline_v2';
const MAX_LIST_KEYS = 24;
const MAX_EVENT_DETAILS = 250;

export type CalendarListCachedPayload = {
  cacheKey: string;
  events: unknown[];
  stats: Record<string, number>;
  savedAt: number;
};

type ListCacheEntry = { events: unknown[]; stats: Record<string, number>; savedAt: number };
type DetailCacheEntry = { payload: Record<string, unknown>; savedAt: number };

export type CalendarOfflineStore = {
  v: 2;
  listByKey: Record<string, ListCacheEntry>;
  eventsById: Record<string, DetailCacheEntry>;
  identityEmails?: string[];
};

function isValidOfflineStore(p: unknown): p is CalendarOfflineStore {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (o.v !== 2) return false;
  if (!o.listByKey || typeof o.listByKey !== 'object' || Array.isArray(o.listByKey)) return false;
  if (!o.eventsById || typeof o.eventsById !== 'object' || Array.isArray(o.eventsById)) return false;
  return true;
}

function trimListKeys(store: CalendarOfflineStore): void {
  const entries = Object.entries(store.listByKey);
  if (entries.length <= MAX_LIST_KEYS) return;
  entries.sort((a, b) => a[1].savedAt - b[1].savedAt);
  const drop = entries.length - MAX_LIST_KEYS;
  for (let i = 0; i < drop; i++) delete store.listByKey[entries[i][0]];
}

function trimEventDetails(store: CalendarOfflineStore): void {
  const entries = Object.entries(store.eventsById);
  if (entries.length <= MAX_EVENT_DETAILS) return;
  entries.sort((a, b) => a[1].savedAt - b[1].savedAt);
  const drop = entries.length - MAX_EVENT_DETAILS;
  for (let i = 0; i < drop; i++) delete store.eventsById[entries[i][0]];
}

export function parseCalendarListCacheKeyUserId(cacheKey: string): number | null {
  try {
    const o = JSON.parse(cacheKey) as { uid?: unknown };
    return typeof o.uid === 'number' ? o.uid : null;
  } catch {
    return null;
  }
}

async function readStore(): Promise<CalendarOfflineStore> {
  const empty: CalendarOfflineStore = { v: 2, listByKey: {}, eventsById: {} };
  try {
    const raw = await getCalendarEncryptedBlob(STORE_KEY);
    if (raw) {
      let p: unknown;
      try {
        p = JSON.parse(raw);
      } catch {
        await removeCalendarEncryptedBlob(STORE_KEY);
        return empty;
      }
      if (isValidOfflineStore(p)) {
        return p;
      }
      await removeCalendarEncryptedBlob(STORE_KEY);
    }

    const leg = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
    if (leg) {
      const old = JSON.parse(leg) as CalendarListCachedPayload;
      if (old?.cacheKey && Array.isArray(old.events)) {
        const migrated: CalendarOfflineStore = {
          v: 2,
          listByKey: {
            [old.cacheKey]: {
              events: old.events,
              stats: old.stats ?? {},
              savedAt: old.savedAt ?? Date.now(),
            },
          },
          eventsById: {},
        };
        const t = Date.now();
        for (const ev of old.events as Record<string, unknown>[]) {
          const id = ev?.id;
          if (id != null) migrated.eventsById[String(id)] = { payload: { ...ev }, savedAt: t };
        }
        await setCalendarEncryptedBlob(STORE_KEY, JSON.stringify(migrated));
        await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
        return migrated;
      }
    }
  } catch {
    /* ignore */
  }
  return empty;
}

async function writeStore(store: CalendarOfflineStore): Promise<void> {
  try {
    await setCalendarEncryptedBlob(STORE_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

export function isCalendarFetchOfflineError(e: unknown): boolean {
  const err = e as Record<string, unknown> | undefined;
  const status = (err?.response as { status?: number } | undefined)?.status;
  // Gateway/proxy errors mean the network path is broken — treat as offline
  if (status === 502 || status === 503 || status === 504 || status === 0) return true;
  const code = err?.code as string | undefined;
  const response = err?.response as { status?: number } | undefined;
  if (!response && (code === 'ERR_NETWORK' || code === 'ECONNABORTED')) return true;
  // No response received at all
  if (!response && (err as any)?.request) return true;
  if ((err as any)?.isOfflineGatewayError === true) return true;
  const msg = (err?.message ?? (err?.response as any)?.data?.message ?? '').toString().toLowerCase();
  if (
    msg.includes('network') ||
    msg.includes('err_network') ||
    msg.includes('econnrefused') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('internet connection appears') ||
    msg.includes('failed to connect')
  )
    return true;
  return false;
}

/**
 * Stable key for calendar list + stats (matches fetch filters + rolling window by local dates).
 */
export function buildCalendarListStorageKey(args: {
  userId: number | undefined;
  debouncedSearch: string;
  showCancelled: boolean;
  viewUserId: number | null;
  isPersonalAccount: boolean;
  showPersonal: boolean;
  showCompany: boolean;
}): string | null {
  if (!args.isPersonalAccount && !args.showPersonal && !args.showCompany) return null;

  let eventTypeFilter: 'personal' | 'company' | 'all' = 'all';
  if (args.isPersonalAccount) eventTypeFilter = 'personal';
  else if (!args.showPersonal && args.showCompany) eventTypeFilter = 'company';
  else if (args.showPersonal && !args.showCompany) eventTypeFilter = 'personal';

  const { start, end } = defaultCalendarListWindow();
  return JSON.stringify({
    v: 1,
    uid: args.userId ?? 0,
    sd: toLocalDateString(start),
    ed: toLocalDateString(end),
    q: args.debouncedSearch,
    ic: args.showCancelled,
    vu: args.viewUserId ?? 0,
    et: eventTypeFilter,
  });
}

export async function getCalendarListCache(
  cacheKey: string
): Promise<{ events: any[]; stats: Record<string, number> } | null> {
  try {
    const store = await readStore();
    const hit = store.listByKey[cacheKey];
    if (!hit || !Array.isArray(hit.events)) return null;
    return { events: hit.events as any[], stats: hit.stats ?? {} };
  } catch {
    return null;
  }
}

/** Newest saved list for this user when the exact filter key has no entry (cold offline). */
export async function getCalendarListFallback(
  userId: number | undefined
): Promise<{ events: any[]; stats: Record<string, number> } | null> {
  try {
    const uid = userId ?? 0;
    const store = await readStore();
    let best: ListCacheEntry | null = null;
    let bestAt = 0;
    for (const [key, entry] of Object.entries(store.listByKey)) {
      if (parseCalendarListCacheKeyUserId(key) !== uid) continue;
      if (!Array.isArray(entry.events)) continue;
      if (entry.savedAt >= bestAt) {
        bestAt = entry.savedAt;
        best = entry;
      }
    }
    if (!best) return null;
    return { events: best.events as any[], stats: best.stats ?? {} };
  } catch {
    return null;
  }
}

export async function saveCalendarListCache(
  cacheKey: string,
  events: unknown[],
  stats: Record<string, number>
): Promise<void> {
  try {
    const store = await readStore();
    const savedAt = Date.now();
    store.listByKey[cacheKey] = { events, stats, savedAt };
    for (const ev of events as Record<string, unknown>[]) {
      const id = ev?.id;
      if (id == null) continue;
      store.eventsById[String(id)] = { payload: { ...ev }, savedAt };
    }
    trimListKeys(store);
    trimEventDetails(store);
    await writeStore(store);
  } catch {
    /* ignore */
  }
}

export async function getCalendarEventDetailOffline(eventId: number): Promise<Record<string, unknown> | null> {
  try {
    const store = await readStore();
    const hit = store.eventsById[String(eventId)];
    return hit?.payload ? { ...hit.payload } : null;
  } catch {
    return null;
  }
}

export async function saveCalendarEventDetailOffline(event: Record<string, unknown>): Promise<void> {
  try {
    const id = event?.id;
    if (id == null) return;
    const store = await readStore();
    const savedAt = Date.now();
    store.eventsById[String(id)] = { payload: { ...event }, savedAt };
    trimEventDetails(store);
    await writeStore(store);
  } catch {
    /* ignore */
  }
}

export async function removeCalendarEventDetailOffline(eventId: number): Promise<void> {
  try {
    const store = await readStore();
    delete store.eventsById[String(eventId)];
    await writeStore(store);
  } catch {
    /* ignore */
  }
}

export async function saveCalendarIdentityEmails(emails: string[]): Promise<void> {
  try {
    const store = await readStore();
    store.identityEmails = emails
      .map((e) => (e || '').trim().toLowerCase())
      .filter(Boolean);
    await writeStore(store);
  } catch {
    /* ignore */
  }
}

export async function getCalendarIdentityEmails(): Promise<string[]> {
  try {
    const store = await readStore();
    return Array.isArray(store.identityEmails) ? [...store.identityEmails] : [];
  } catch {
    return [];
  }
}

/** Logout / account switch: remove list + detail offline cache for this device. */
export async function clearCalendarOfflineOnLogout(): Promise<void> {
  try {
    await removeCalendarEncryptedBlob(STORE_KEY);
    await AsyncStorage.removeItem(STORE_KEY);
    await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Clears cached lists so the next online fetch repopulates; keeps per-event blobs for offline detail. */
export async function invalidateCalendarListCache(): Promise<void> {
  try {
    const store = await readStore();
    store.listByKey = {};
    await writeStore(store);
  } catch {
    /* ignore */
  }
}
