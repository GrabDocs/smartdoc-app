import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { STORAGE_KEYS } from '../constants/Config';
import { useAuth } from '../app/context/auth';
import { apiClient } from '../services/api';
import { scopedStorageKey } from '../services/userScopedCache';
import {
  extractAppPreferencesPayload,
  hiddenPatchForToggle,
  isMobileHomeAppVisible,
  normalizePreferenceMap,
  showAllHiddenPatch,
  visibleAppsSummary,
  webKeyForMobileApp,
  type AppPreferencesPayload,
} from '../utils/visibleApps';

type VisibleAppsContextValue = {
  hiddenApps: Record<string, boolean>;
  disabledApps: Record<string, boolean>;
  loading: boolean;
  saving: boolean;
  summaryLabel: string;
  isHomeAppVisible: (mobileKey: string) => boolean;
  refresh: () => Promise<void>;
  toggleApp: (mobileKey: string, visible: boolean) => Promise<void>;
  showAllApps: () => Promise<void>;
};

const VisibleAppsContext = createContext<VisibleAppsContextValue | undefined>(undefined);

type CachedPrefs = {
  hiddenApps: Record<string, boolean>;
  disabledApps: Record<string, boolean>;
};

function parseCachedPrefs(raw: string | null): CachedPrefs | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedPrefs>;
    return {
      hiddenApps: normalizePreferenceMap(parsed.hiddenApps),
      disabledApps: normalizePreferenceMap(parsed.disabledApps),
    };
  } catch {
    return null;
  }
}

function extractDisabledApps(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const policy = raw as { disabledApps?: unknown; disabled_apps?: unknown };
  return normalizePreferenceMap(policy.disabledApps ?? policy.disabled_apps);
}

export function VisibleAppsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [hiddenApps, setHiddenApps] = useState<Record<string, boolean>>({});
  const [disabledApps, setDisabledApps] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const persistCache = useCallback(
    async (nextHidden: Record<string, boolean>, nextDisabled: Record<string, boolean>) => {
      const key = scopedStorageKey(user?.id, STORAGE_KEYS.HIDDEN_APPS);
      if (!key) return;
      try {
        await AsyncStorage.setItem(
          key,
          JSON.stringify({ hiddenApps: nextHidden, disabledApps: nextDisabled }),
        );
      } catch {
        /* ignore */
      }
    },
    [user?.id],
  );

  const applyServerPayload = useCallback(
    async (payload: AppPreferencesPayload) => {
      const nextHidden = normalizePreferenceMap(payload.hiddenApps ?? payload.hidden_apps);
      const nextDisabled = extractDisabledApps(payload.companyPolicy);
      setHiddenApps(nextHidden);
      setDisabledApps(nextDisabled);
      await persistCache(nextHidden, nextDisabled);
    },
    [persistCache],
  );

  const loadFromAuthCheck = useCallback(async (): Promise<boolean> => {
    try {
      const raw = await apiClient.checkAuth();
      const payload = extractAppPreferencesPayload(raw);
      if (!payload) return false;
      await applyServerPayload(payload);
      return true;
    } catch {
      return false;
    }
  }, [applyServerPayload]);

  const loadFromUserProfile = useCallback(async (): Promise<boolean> => {
    try {
      const raw = await apiClient.getUserProfile();
      const payload =
        extractAppPreferencesPayload(raw) ||
        extractAppPreferencesPayload((raw as { data?: unknown })?.data);
      if (!payload) return false;
      await applyServerPayload(payload);
      return true;
    } catch {
      return false;
    }
  }, [applyServerPayload]);

  const refresh = useCallback(async () => {
    if (!user?.id) {
      setHiddenApps({});
      setDisabledApps({});
      return;
    }
    try {
      const res = await apiClient.getAppPreferences();
      const payload = extractAppPreferencesPayload(res);
      if (payload) {
        await applyServerPayload(payload);
        return;
      }
    } catch {
      /* fall through */
    }
    if (await loadFromAuthCheck()) return;
    await loadFromUserProfile();
  }, [user?.id, applyServerPayload, loadFromAuthCheck, loadFromUserProfile]);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) {
      setHiddenApps({});
      setDisabledApps({});
      setLoading(false);
      return;
    }

    (async () => {
      setLoading(true);
      const key = scopedStorageKey(user.id, STORAGE_KEYS.HIDDEN_APPS);
      if (key) {
        try {
          const cached = parseCachedPrefs(await AsyncStorage.getItem(key));
          if (!cancelled && cached) {
            setHiddenApps(cached.hiddenApps);
            setDisabledApps(cached.disabledApps);
          }
        } catch {
          /* ignore */
        }
      }
      try {
        const res = await apiClient.getAppPreferences();
        const payload = extractAppPreferencesPayload(res);
        if (!cancelled && payload) {
          await applyServerPayload(payload);
          return;
        }
      } catch {
        /* fall through to auth-check / profile — same DB as web */
      }
      if (cancelled) return;
      if (await loadFromAuthCheck()) return;
      if (!cancelled) await loadFromUserProfile();
    })()
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, applyServerPayload, loadFromAuthCheck, loadFromUserProfile]);

  useEffect(() => {
    if (!user?.id) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => sub.remove();
  }, [user?.id, refresh]);

  const isHomeAppVisible = useCallback(
    (mobileKey: string) => isMobileHomeAppVisible(mobileKey, hiddenApps, disabledApps),
    [hiddenApps, disabledApps],
  );

  const toggleApp = useCallback(
    async (mobileKey: string, visible: boolean) => {
      const webKey = webKeyForMobileApp(mobileKey);
      if (!webKey) return;
      const patch = hiddenPatchForToggle(webKey, visible);
      const prevHidden = hiddenApps;
      const optimistic = { ...hiddenApps };
      if (visible) delete optimistic[webKey];
      else optimistic[webKey] = true;
      setHiddenApps(optimistic);
      setSaving(true);
      try {
        const res = await apiClient.updateAppPreferences(patch);
        const payload = extractAppPreferencesPayload(res);
        if (payload) await applyServerPayload(payload);
        else await applyServerPayload({ hiddenApps: optimistic, companyPolicy: { disabledApps } });
      } catch (err) {
        setHiddenApps(prevHidden);
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [hiddenApps, disabledApps, applyServerPayload],
  );

  const showAllApps = useCallback(async () => {
    const patch = showAllHiddenPatch(hiddenApps, disabledApps);
    if (Object.keys(patch).length === 0) return;
    const prevHidden = hiddenApps;
    const optimistic = { ...hiddenApps };
    for (const key of Object.keys(patch)) delete optimistic[key];
    setHiddenApps(optimistic);
    setSaving(true);
    try {
      const res = await apiClient.updateAppPreferences(patch);
      const payload = extractAppPreferencesPayload(res);
      if (payload) await applyServerPayload(payload);
      else await applyServerPayload({ hiddenApps: optimistic, companyPolicy: { disabledApps } });
    } catch (err) {
      setHiddenApps(prevHidden);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [hiddenApps, disabledApps, applyServerPayload]);

  const summaryLabel = useMemo(
    () => visibleAppsSummary(hiddenApps, disabledApps).label,
    [hiddenApps, disabledApps],
  );

  const value = useMemo(
    () => ({
      hiddenApps,
      disabledApps,
      loading,
      saving,
      summaryLabel,
      isHomeAppVisible,
      refresh,
      toggleApp,
      showAllApps,
    }),
    [
      hiddenApps,
      disabledApps,
      loading,
      saving,
      summaryLabel,
      isHomeAppVisible,
      refresh,
      toggleApp,
      showAllApps,
    ],
  );

  return <VisibleAppsContext.Provider value={value}>{children}</VisibleAppsContext.Provider>;
}

export function useVisibleApps() {
  const context = useContext(VisibleAppsContext);
  if (context === undefined) {
    throw new Error('useVisibleApps must be used within a VisibleAppsProvider');
  }
  return context;
}
