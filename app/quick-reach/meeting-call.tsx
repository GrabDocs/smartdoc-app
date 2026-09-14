import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { parseMobileMeetingInfoResponse } from '../../utils/meetingJoinPresence';
import { getReachParticipantDisplayName, sanitizeReachDisplayName } from '../../utils/reachDisplayName';
import { formatMeetingTimeToLocal } from '../../utils/timeFormatting';
import { REACH_CURRENT_MEETING_KEY, canonicalizeReachMeetingId } from '../../constants/reachMeeting';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

type MeetingSource = 'own' | 'invited';

interface Meeting {
  id: string;
  title: string;
  meetingId: string;
  host: string;
  participants: number;
  startTime: string;
  endTime?: string;
  status: 'scheduled' | 'created' | 'active' | 'ended';
  passcode?: string;
  /** When true, user must supply passcode (not always present on list row). */
  passcode_required?: boolean;
  roomUrl?: string;
  description?: string;
  duration?: number;
  createdAt?: string;
  /** Video_calls.creator user id — used with current user for owner vs participant actions */
  creatorId?: number | string;
  /** From API current_host_id — may differ from creator after host transfer */
  currentHostId?: number | string;
  /** Normalized user ids from meeting_hosts (co-hosts) */
  hostUserIds?: string[];
  /** Present when row came from own vs invited-meetings merge */
  source?: MeetingSource;
}

function meetingInfoStartLabel(meeting: Meeting, room: Record<string, any> | null | undefined): string {
  const iso =
    room?.started_at ||
    room?.scheduled_at ||
    meeting.startTime ||
    '';
  return iso ? formatMeetingTimeToLocal(iso) : '—';
}

function meetingInfoEndLabel(meeting: Meeting, room: Record<string, any> | null | undefined): string {
  const raw = room?.ended_at || meeting.endTime;
  return raw ? formatMeetingTimeToLocal(String(raw)) : '';
}

function meetingInfoDurationMinutes(
  meeting: Meeting,
  room: Record<string, any> | null | undefined
): number | undefined {
  const v = room?.duration_minutes ?? meeting.duration;
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** GrabDocs join link from API (same encoding as copy-invite). Never client-fake: backend uses salt + SHA256 in `encode_meeting_id`. */
function meetingInfoJoinLinkUrl(_meeting: Meeting, room: Record<string, any> | null | undefined): string | undefined {
  const fromApi = room?.invite_link;
  if (fromApi != null && String(fromApi).trim() !== '') return String(fromApi).trim();
  return undefined;
}

function extractReachHostUserIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      const id = o.user_id ?? o.userId ?? o.id;
      if (id != null && String(id).trim() !== '') out.push(String(id));
    }
  }
  return out;
}

/** Resolve display host/owner label across mobile + invited-meetings API shapes. */
function extractReachHostDisplayName(m: Record<string, unknown>): string {
  const direct =
    m.host ?? m.host_name ?? m.hostName ?? m.creator_name ?? m.creatorName ?? m.owner_name;
  if (typeof direct === 'string') {
    const trimmed = direct.trim();
    if (trimmed && trimmed.toLowerCase() !== 'unknown') return trimmed;
  }

  const creator = m.creator ?? m.owner;
  if (creator && typeof creator === 'object') {
    const c = creator as Record<string, unknown>;
    const first = String(c.first_name ?? c.firstName ?? '').trim();
    const last = String(c.last_name ?? c.lastName ?? '').trim();
    const full = [first, last].filter(Boolean).join(' ').trim();
    if (full) return full;
    const username = String(c.username ?? '').trim();
    if (username) return username;
    const email = String(c.email ?? '').trim();
    if (email) return email;
  }

  const hosts = m.meeting_hosts ?? m.meetingHosts;
  if (Array.isArray(hosts)) {
    for (const entry of hosts) {
      if (!entry || typeof entry !== 'object') continue;
      const h = entry as Record<string, unknown>;
      const role = String(h.role ?? '').toLowerCase();
      if (role && role !== 'owner' && role !== 'host') continue;
      const name =
        String(h.username ?? h.name ?? h.email ?? '').trim() ||
        [String(h.first_name ?? ''), String(h.last_name ?? '')].filter(Boolean).join(' ').trim();
      if (name) return name;
    }
  }

  return 'Unknown';
}

function isReachMeetingOwner(meeting: Meeting, userId: string | undefined): boolean {
  if (!userId) return false;
  if (meeting.creatorId != null && String(meeting.creatorId) === String(userId)) return true;
  return meeting.source === 'own';
}

function isReachMeetingHost(meeting: Meeting, userId: string | undefined): boolean {
  if (!userId) return false;
  const uid = String(userId);
  if (meeting.currentHostId != null && String(meeting.currentHostId) === uid) return true;
  if (meeting.hostUserIds?.some((id) => String(id) === uid)) return true;
  return false;
}

/** Trash / delete — hidden while the meeting is live for owners and hosts */
function canDeleteReachMeetingFromList(meeting: Meeting, userId: string | undefined): boolean {
  if (meeting.status === 'active') return false;
  return isReachMeetingOwner(meeting, userId) || isReachMeetingHost(meeting, userId);
}

/** Keys `id:<meetingId>` / `title:<normalized>` for meetings that have ≥1 asset (from getMeetingAssets). */
function buildMeetingsWithAssetsMap(data: unknown): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  const markId = (id: string | number | null | undefined) => {
    if (id == null) return;
    const s = String(id).trim();
    if (s) map[`id:${s}`] = true;
  };
  const markTitle = (title: string | null | undefined) => {
    const t = (title || '').toLowerCase().trim();
    if (t) map[`title:${t}`] = true;
  };

  if (!data || typeof data !== 'object') return map;
  const d = data as { meetings?: unknown[]; assets?: unknown[] };

  if (Array.isArray(d.meetings)) {
    for (const meet of d.meetings) {
      if (!meet || typeof meet !== 'object') continue;
      const m = meet as Record<string, unknown>;
      const n =
        (Array.isArray(m.assets) ? m.assets.length : 0) +
        (Array.isArray(m.files) ? m.files.length : 0);
      if (n === 0) continue;
      markId(m.id as string | number);
      markId(m.meeting_id as string | number);
      markId(m.meetingId as string | number);
      markId(m.hms_meeting_id as string | number);
      markTitle(m.title as string);
      markTitle(m.meeting_title as string);
    }
  }

  if (Array.isArray(d.assets)) {
    for (const asset of d.assets) {
      if (!asset || typeof asset !== 'object') continue;
      const a = asset as Record<string, unknown>;
      markId((a.meeting_id ?? a.meetingId) as string | number);
      markTitle(a.meeting_title as string);
    }
  }

  return map;
}

function meetingHasKnownAssets(m: Meeting, presence: Record<string, boolean>): boolean {
  const id = String(m.meetingId || m.id || '').trim();
  const title = (m.title || '').toLowerCase().trim();
  if (id && presence[`id:${id}`]) return true;
  if (title && presence[`title:${title}`]) return true;
  return false;
}

function normalizeMeetingIdForMerge(id: unknown): string {
  return canonicalizeReachMeetingId(id).toLowerCase();
}

function toMillis(t: unknown): number {
  if (t == null || t === '') return 0;
  if (typeof t === 'string') {
    const parsed = new Date(t).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof t === 'number') {
    if (!Number.isFinite(t)) return 0;
    return t < 1e12 ? t * 1000 : t;
  }
  return 0;
}

/** Latest-first sort: use the newest of created / scheduled start / end timestamps. */
function meetingNewestFirstSortMs(m: Meeting): number {
  const times = [toMillis(m.createdAt), toMillis(m.startTime), toMillis(m.endTime)].filter((n) => n > 0);
  return times.length > 0 ? Math.max(...times) : 0;
}

function sortMeetingsNewestFirst(meetings: Meeting[]): Meeting[] {
  return [...meetings].sort((a, b) => {
    const diff = meetingNewestFirstSortMs(b) - meetingNewestFirstSortMs(a);
    if (diff !== 0) return diff;
    return String(b.meetingId || b.id).localeCompare(String(a.meetingId || a.id));
  });
}

type MeetingListRow = Meeting & {
  source: MeetingSource;
  sortTime: number;
  createdFallbackMs: number;
};

function mapRawToMeetingListRow(m: any, source: MeetingSource): MeetingListRow | null {
  const raw = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
  const meetingId = canonicalizeReachMeetingId(
    String(raw.meetingId || raw.meeting_id || raw.id || '').trim()
  );
  if (!meetingId) return null;

  const titleRaw =
    raw.title || raw.name || raw.roomName || raw.room_name || raw.meeting_subject;
  const title =
    typeof titleRaw === 'string' && titleRaw.trim()
      ? titleRaw.trim()
      : 'Untitled Meeting';

  const startTime =
    raw.startTime ||
    raw.start_time ||
    raw.start_at ||
    raw.started_at ||
    raw.scheduled_start_time ||
    raw.scheduled_time ||
    raw.scheduled_at ||
    '';
  const scheduledStart = raw.scheduled_start_time || raw.scheduled_at;
  const createdRaw = raw.createdAt || raw.created_at || raw.created;
  const createdAt =
    typeof createdRaw === 'string'
      ? createdRaw
      : createdRaw != null
        ? String(createdRaw)
        : '';

  const statusRaw = raw.status || raw.meeting_status || 'created';

  const sortTime =
    toMillis(startTime) ||
    toMillis(scheduledStart) ||
    toMillis(createdAt) ||
    toMillis(raw.endTime || raw.end_time || raw.end_at) ||
    toMillis(raw.started_at) ||
    0;
  const createdFallbackMs =
    toMillis(createdAt) ||
    toMillis(raw.started_at) ||
    toMillis(startTime) ||
    0;

  return {
    id: String(raw.id || raw.meeting_id || raw.meetingId || meetingId),
    title,
    meetingId,
    host: extractReachHostDisplayName(raw),
    participants: raw.participants || raw.participant_count || 0,
    startTime: typeof startTime === 'string' ? startTime : String(startTime || ''),
    endTime: raw.endTime || raw.end_time || raw.end_at || '',
    status: statusRaw as Meeting['status'],
    passcode: raw.passcode || raw.password || undefined,
    passcode_required:
      raw.passcode_required === true || raw.passcodeRequired === true ? true : undefined,
    roomUrl: raw.roomUrl || raw.room_url || raw.url || undefined,
    description: raw.description || raw.meeting_description || undefined,
    duration:
      raw.duration ??
      raw.meeting_duration_minutes ??
      raw.duration_minutes ??
      undefined,
    createdAt: createdAt || undefined,
    creatorId: raw.creator_id ?? raw.creatorId ?? undefined,
    currentHostId: raw.current_host_id ?? raw.currentHostId ?? undefined,
    hostUserIds: extractReachHostUserIds(raw.meeting_hosts ?? raw.meetingHosts),
    source,
    sortTime,
    createdFallbackMs,
  };
}

function stripMeetingListInternals(row: MeetingListRow): Meeting {
  const { sortTime: _st, createdFallbackMs: _cf, ...rest } = row;
  return rest;
}

function mergeMeetingRowsById(ownRows: MeetingListRow[], invitedRows: MeetingListRow[]): MeetingListRow[] {
  const mergedMap = new Map<string, MeetingListRow>();
  for (const row of ownRows) {
    const key = normalizeMeetingIdForMerge(row.meetingId);
    if (!key) continue;
    const existing = mergedMap.get(key);
    if (!existing || existing.source === 'invited') {
      mergedMap.set(key, row);
    }
  }
  for (const row of invitedRows) {
    const key = normalizeMeetingIdForMerge(row.meetingId);
    if (!key) continue;
    const existing = mergedMap.get(key);
    if (!existing || existing.source === 'invited') {
      mergedMap.set(key, row);
    }
  }
  const merged = Array.from(mergedMap.values());
  merged.sort((a, b) => {
    if (b.sortTime !== a.sortTime) return b.sortTime - a.sortTime;
    if ((b.createdFallbackMs ?? 0) !== (a.createdFallbackMs ?? 0)) {
      return (b.createdFallbackMs ?? 0) - (a.createdFallbackMs ?? 0);
    }
    return String(a.meetingId).localeCompare(String(b.meetingId));
  });
  return merged;
}

function parseMeetingsArrayFromMobileResponse(meetingsResponse: any): any[] {
  if (Array.isArray(meetingsResponse)) return meetingsResponse;
  if (meetingsResponse?.data) {
    if (Array.isArray(meetingsResponse.data)) return meetingsResponse.data;
    return meetingsResponse.data.meetings || [];
  }
  if (meetingsResponse?.meetings && Array.isArray(meetingsResponse.meetings)) {
    return meetingsResponse.meetings;
  }
  return [];
}

export default function MeetingCallScreen() {
  const router = useRouter();
  const { user, loading: authLoading, refreshSession } = useAuth();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const isAuthenticated = !!user;
  const [authRecovering, setAuthRecovering] = useState(false);
  const authRecoverAttemptedRef = useRef(false);

  console.log('🔄 MeetingCallScreen rendered, isAuthenticated:', isAuthenticated);
  
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [upcomingMeetings, setUpcomingMeetings] = useState<Meeting[]>([]);
  const [ongoingMeetings, setOngoingMeetings] = useState<Meeting[]>([]);
  const [assetPresenceMap, setAssetPresenceMap] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [meetingId, setMeetingId] = useState('');
  const [meetingPassword, setMeetingPassword] = useState('');
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [infoMeeting, setInfoMeeting] = useState<Meeting | null>(null);
  const [meetingInfoData, setMeetingInfoData] = useState<any>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [inviteEmails, setInviteEmails] = useState<string[]>([]);
  const [newInviteEmail, setNewInviteEmail] = useState('');
  const [inviteMessage, setInviteMessage] = useState('');
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [featuresExpanded, setFeaturesExpanded] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isJoining, setIsJoining] = useState(false);
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);
  const [inviteSending, setInviteSending] = useState(false);
  /** True when GET /api/v1/video/invited-meetings fails (own list may still show). */
  const [invitedLoadFailed, setInvitedLoadFailed] = useState(false);

  // Use keyboard height for padding so join modal stays above keyboard on both Android and iOS
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (typeof __DEV__ !== 'undefined' && __DEV__ && invitedLoadFailed) {
      console.warn('📱 Invited meetings could not be loaded; list may be incomplete. Pull to refresh.');
    }
  }, [invitedLoadFailed]);

  // Users reach this screen from inside the logged-in app (join/leave). Never show a Sign In wall —
  // recover session quietly, or return home if recovery fails.
  useEffect(() => {
    if (authLoading || user) {
      authRecoverAttemptedRef.current = false;
      setAuthRecovering(false);
      return;
    }
    if (authRecoverAttemptedRef.current) return;
    authRecoverAttemptedRef.current = true;
    let cancelled = false;
    setAuthRecovering(true);
    (async () => {
      try {
        await refreshSession();
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setAuthRecovering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user, refreshSession]);

  useEffect(() => {
    if (authLoading || authRecovering || user) return;
    if (!authRecoverAttemptedRef.current) return;
    router.replace('/(tabs)' as any);
  }, [authLoading, authRecovering, user, router]);

  const loadMeetings = useCallback(async (opts?: { silent?: boolean }) => {
    if (!isAuthenticated) {
      console.log('📱 User not authenticated, skipping meetings load');
      setAssetPresenceMap({});
      setLoading(false);
      setRefreshing(false);
      return;
    }

    try {
      if (!opts?.silent) {
        setLoading(true);
      }

      const startTime = Date.now();
      const [ownRes, invitedAxiosRes] = await Promise.all([
        apiClient.getMeetings(10, 0).catch((e) => {
          console.warn('📱 getMeetings failed:', e);
          return null;
        }),
        apiClient.client.get('/api/v1/video/invited-meetings').catch((e) => {
          console.warn('📱 invited-meetings failed:', e);
          return null;
        }),
      ]);
      const loadTime = Date.now() - startTime;

      let invitedRequestFailed = false;
      let invitedPayload: any = null;
      if (invitedAxiosRes === null) {
        invitedRequestFailed = true;
      } else {
        const d = invitedAxiosRes.data;
        if (d && d.success === false) {
          invitedRequestFailed = true;
        } else {
          invitedPayload = d;
        }
      }
      setInvitedLoadFailed(invitedRequestFailed);

      const allMeetings = parseMeetingsArrayFromMobileResponse(ownRes);
      const ownRows = allMeetings
        .map((m) => mapRawToMeetingListRow(m, 'own'))
        .filter((r): r is MeetingListRow => r != null);

      let invitedRows: MeetingListRow[] = [];
      if (!invitedRequestFailed && invitedPayload) {
        const recent = Array.isArray(invitedPayload.recent_meetings)
          ? invitedPayload.recent_meetings
          : [];
        const scheduled = Array.isArray(invitedPayload.scheduled_meetings)
          ? invitedPayload.scheduled_meetings
          : [];
        invitedRows = [...recent, ...scheduled]
          .map((m) => mapRawToMeetingListRow(m, 'invited'))
          .filter((r): r is MeetingListRow => r != null);
      }

      const mergedRows = mergeMeetingRowsById(ownRows, invitedRows);
      const uniqueMeetings = mergedRows.map(stripMeetingListInternals);

      console.log(`📱 Meetings loaded in ${loadTime}ms`, {
        ownRawCount: allMeetings.length,
        ownRows: ownRows.length,
        invitedRows: invitedRows.length,
        merged: uniqueMeetings.length,
        invitedRequestFailed,
      });

      setMeetings(sortMeetingsNewestFirst(uniqueMeetings));

      const now = new Date();
      const upcoming = uniqueMeetings.filter((m: Meeting) => {
        if (m.status === 'active') {
          return false;
        }

        const hasNoStartTime =
          !m.startTime ||
          (typeof m.startTime === 'string' && m.startTime.trim() === '') ||
          m.startTime === null ||
          m.startTime === undefined;

        if (m.status === 'created') {
          console.log(`✅ Meeting "${m.title}" included in upcoming: newly created meeting (status="created")`);
          return true;
        }

        if (hasNoStartTime && m.status !== 'ended') {
          console.log(`✅ Meeting "${m.title}" included in upcoming: newly created without start_at/end_at (status="${m.status}")`);
          return true;
        }

        if (m.status === 'scheduled' && !hasNoStartTime) {
          try {
            const startTime = new Date(m.startTime);
            if (isNaN(startTime.getTime())) {
              console.log(`✅ Meeting "${m.title}" included in upcoming: scheduled but invalid startTime, treating as newly created`);
              return true;
            }
            const isFuture = startTime > now;
            if (isFuture) {
              console.log(`✅ Meeting "${m.title}" included in upcoming: scheduled with future startTime (${m.startTime})`);
              return true;
            } else {
              console.log(`❌ Meeting "${m.title}" excluded from upcoming: scheduled but startTime in past (${m.startTime})`);
              return false;
            }
          } catch {
            console.warn(`⚠️ Meeting "${m.title}" has invalid startTime format: ${m.startTime}, treating as newly created`);
            return true;
          }
        }

        console.log(`❌ Meeting "${m.title}" excluded from upcoming: status="${m.status}", hasNoStartTime=${hasNoStartTime}, startTime="${m.startTime}"`);
        return false;
      });

      let ongoing = uniqueMeetings.filter((m: Meeting) => m.status === 'active');
      const currentIdRaw = await AsyncStorage.getItem(REACH_CURRENT_MEETING_KEY);
      const currentId = currentIdRaw ? canonicalizeReachMeetingId(currentIdRaw.trim()) : '';
      if (currentId) {
        const curNorm = normalizeMeetingIdForMerge(currentId);
        const inOngoing = ongoing.some(
          (m: Meeting) => normalizeMeetingIdForMerge(m.meetingId || m.id) === curNorm
        );
        if (!inOngoing) {
          const fromList = uniqueMeetings.find(
            (m: Meeting) => normalizeMeetingIdForMerge(m.meetingId || m.id) === curNorm
          );
          if (fromList) {
            ongoing = [{ ...fromList, status: 'active' as const }, ...ongoing];
          } else {
            ongoing = [
              {
                id: currentId,
                meetingId: currentId,
                title: 'Active meeting',
                host: 'You',
                participants: 0,
                startTime: '',
                status: 'active',
              },
              ...ongoing,
            ];
          }
          console.log('📱 Included current meeting in active section:', currentId);
        }
      }

      setUpcomingMeetings(sortMeetingsNewestFirst(upcoming));
      setOngoingMeetings(sortMeetingsNewestFirst(ongoing));

      try {
        const ar = await apiClient.getMeetingAssets();
        if (ar?.success && ar.data) {
          setAssetPresenceMap(buildMeetingsWithAssetsMap(ar.data));
        } else {
          setAssetPresenceMap({});
        }
      } catch (assetErr) {
        console.warn('📱 Could not load asset presence for meeting list:', assetErr);
        setAssetPresenceMap({});
      }

      const recentCount = uniqueMeetings.filter((m) => {
        if (m.status === 'ended') return true;
        if ((m.status === 'created' || m.status === 'scheduled') && !m.startTime) return true;
        return false;
      }).length;

      console.log(`📱 Loaded ${uniqueMeetings.length} meetings in ${loadTime}ms:`, {
        total: uniqueMeetings.length,
        upcoming: upcoming.length,
        ongoing: ongoing.length,
        recent: recentCount,
        invitedLoadFailed: invitedRequestFailed,
      });

      console.log(
        '📱 Meeting statuses from backend:',
        uniqueMeetings.map((m: Meeting) => {
          const hasNoStartTime =
            !m.startTime ||
            (typeof m.startTime === 'string' && m.startTime.trim() === '') ||
            m.startTime === null ||
            m.startTime === undefined;
          const isInUpcoming = upcoming.includes(m);
          return {
            title: m.title,
            status: m.status,
            startTime: m.startTime,
            hasStartTime: !!m.startTime && !hasNoStartTime,
            hasNoStartTime: hasNoStartTime,
            isInUpcoming: isInUpcoming,
            category:
              m.status === 'ended'
                ? 'recent'
                : m.status === 'scheduled' && !hasNoStartTime
                  ? 'upcoming'
                  : m.status === 'active'
                    ? 'ongoing'
                    : hasNoStartTime
                      ? 'upcoming (newly created)'
                      : 'other',
          };
        })
      );
    } catch (error: any) {
      // This catch block should rarely be hit now since we use allSettled
      // But keep it as a safety net
      console.error('Unexpected error in loadMeetings:', error);
      setAssetPresenceMap({});
      setMeetings([]);
      setUpcomingMeetings([]);
      setOngoingMeetings([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated && !hasLoadedOnce) {
      console.log('📱 Initial load triggered by authentication');
      setHasLoadedOnce(true);
      loadMeetings();
    } else if (!isAuthenticated) {
      setLoading(false);
    } else if (hasLoadedOnce) {
      console.log('📱 Skipping duplicate load - already loaded once');
    }
  }, [isAuthenticated, hasLoadedOnce, loadMeetings]);

  // Reload meetings when screen comes into focus (e.g., after creating a meeting)
  // Use a ref to track last load time to prevent excessive reloads
  const lastLoadTimeRef = useRef<number>(0);
  const RELOAD_DEBOUNCE_MS = 2000; // Don't reload if less than 2 seconds since last load
  
  useFocusEffect(
    useCallback(() => {
      // Only reload if user is authenticated and we've already loaded once
      // Add debounce to prevent excessive reloads when quickly switching screens
      const now = Date.now();
      if (isAuthenticated && hasLoadedOnce && (now - lastLoadTimeRef.current > RELOAD_DEBOUNCE_MS)) {
        console.log('📱 Screen focused - reloading meetings to show new meetings');
        lastLoadTimeRef.current = now;
        loadMeetings();
      }
    }, [isAuthenticated, hasLoadedOnce, loadMeetings])
  );

  const handleRefresh = useCallback(() => {
    console.log('📱 Manual refresh triggered');
    setInvitedLoadFailed(false);
    setRefreshing(true);
    loadMeetings();
  }, [loadMeetings]);

  const createMeeting = () => {
    router.push('/quick-reach/create-meeting');
  };

  const scheduleMeeting = () => {
    router.push('/quick-reach/schedule-meeting');
  };

  const navigateToMeetingScreen = (nav: {
    meetingId: string;
    title: string;
    userName?: string;
    passcode?: string;
    forceJoin?: boolean;
  }) => {
    const q = new URLSearchParams({
      meetingId: nav.meetingId,
      title: nav.title,
    });
    const cleaned = sanitizeReachDisplayName(nav.userName || getReachParticipantDisplayName(user));
    if (cleaned) q.set('userName', cleaned);
    if (nav.passcode) q.set('passcode', nav.passcode);
    if (nav.forceJoin) q.set('force_join', '1');
    router.replace(`/quick-reach/hms-meeting-interface?${q.toString()}` as any);
  };

  /** Open HMS prejoin flow without calling mobile/join first — token + room entry happen on the meeting screen. */
  const joinMeeting = async (meeting: Meeting, forceJoin: boolean = false) => {
    if (isJoining) return;
    if (!forceJoin) {
      try {
        const currentRaw = await AsyncStorage.getItem(REACH_CURRENT_MEETING_KEY);
        const currentCanon = currentRaw ? canonicalizeReachMeetingId(currentRaw.trim()) : '';
        const meetingCanon = canonicalizeReachMeetingId(meeting.meetingId);
        if (currentCanon && meetingCanon && currentCanon === meetingCanon) {
          navigateToMeetingScreen({
            meetingId: meeting.meetingId,
            title: meeting.title,
            passcode:
              (meeting.passcode && String(meeting.passcode).trim()) || undefined,
            forceJoin: true,
          });
          return;
        }
        if (currentCanon && meetingCanon && currentCanon !== meetingCanon) {
          Alert.alert(
            'Already in a meeting',
            'You can only be in one meeting at a time. Please leave the current meeting first, then join this one.',
            [{ text: 'OK', style: 'cancel' }]
          );
          return;
        }
      } catch {
        /* ignore storage errors */
      }
    }

    const openPrejoin = (passOverride?: string) => {
      const pass =
        (passOverride && passOverride.trim()) ||
        (meeting.passcode && String(meeting.passcode).trim()) ||
        undefined;
      navigateToMeetingScreen({
        meetingId: meeting.meetingId,
        title: meeting.title,
        passcode: pass,
        forceJoin,
      });
    };

    const needsPasscodeFromUser =
      meeting.passcode_required === true &&
      !(meeting.passcode && String(meeting.passcode).trim());

    if (needsPasscodeFromUser) {
      Alert.prompt(
        'Meeting Passcode',
        'This is a private meeting. Enter the passcode:',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Continue',
            onPress: (typed?: string) => {
              if (typed && typed.trim()) {
                openPrejoin(typed);
              } else {
                Alert.alert('Error', 'Passcode is required for private meetings');
              }
            },
          },
        ],
        'secure-text'
      );
      return;
    }

    openPrejoin();
  };

  const viewMeetingAssets = (meeting: Meeting, options?: { fromAssetsIcon?: boolean }) => {
    router.push({
      pathname: '/quick-reach/meeting-details',
      params: {
        meetingId: meeting.meetingId,
        meetingTitle: meeting.title,
        roomCode: meeting.meetingId,
        ...(options?.fromAssetsIcon ? { entry: 'assets' } : {}),
      },
    });
  };

  const joinMeetingById = async () => {
    if (isJoining) return;
    if (!meetingId.trim()) {
      Alert.alert('Error', 'Please enter a meeting ID');
      return;
    }
    const savedMeetingId = meetingId.trim();
    try {
      const currentRaw = await AsyncStorage.getItem(REACH_CURRENT_MEETING_KEY);
      const currentCanon = currentRaw ? canonicalizeReachMeetingId(currentRaw.trim()) : '';
      const targetCanon = canonicalizeReachMeetingId(savedMeetingId);
      if (currentCanon && targetCanon && currentCanon !== targetCanon) {
        Alert.alert(
          'Already in a meeting',
          'You can only be in one meeting at a time. Please leave the current meeting first, then join this one.',
          [{ text: 'OK', style: 'cancel' }]
        );
        return;
      }
    } catch {
      /* ignore storage errors */
    }
    setIsJoining(true);
    const savedPassword = meetingPassword.trim();
    try {
      setShowJoinModal(false);
      setMeetingId('');
      setMeetingPassword('');
      navigateToMeetingScreen({
        meetingId: savedMeetingId,
        title: 'Meeting',
        ...(savedPassword ? { passcode: savedPassword } : {}),
      });
    } finally {
      setIsJoining(false);
    }
  };

  const endMeeting = async (meeting: Meeting) => {
    const busyKey = `end:${meeting.id}`;
    Alert.alert(
      'End Meeting',
      'Are you sure you want to end this meeting?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End Meeting',
          style: 'destructive',
          onPress: async () => {
            const roomId = meeting.id || meeting.meetingId;
            setActionBusyKey(busyKey);
            Toast.show({ type: 'info', text1: 'Ending meeting...', visibilityTime: 2000 });
            const clearCurrentMeetingKey = () => {
              AsyncStorage.removeItem(REACH_CURRENT_MEETING_KEY).catch(() => {});
            };
            try {
              const response = await apiClient.endMeeting(roomId);
              if (response.success) {
                clearCurrentMeetingKey();
                Alert.alert('Success', 'Meeting ended successfully');
                loadMeetings();
                return;
              }
              if ((response as any).requires_confirmation) {
                const count = (response as any).active_participants_count ?? 0;
                if (count > 1) {
                  Toast.show({
                    type: 'info',
                    text1: 'Others still in meeting',
                    text2: 'Do you want to end the meeting for everyone?',
                    visibilityTime: 4000,
                  });
                  Alert.alert(
                    'End meeting anyway?',
                    'Others are still in the meeting. Do you want to end the meeting for everyone?',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'End meeting',
                        style: 'destructive',
                        onPress: async () => {
                          setActionBusyKey(busyKey);
                          Toast.show({ type: 'info', text1: 'Ending meeting...', visibilityTime: 2000 });
                          try {
                            const forceResponse = await apiClient.endMeeting(roomId, true);
                            if (forceResponse.success) {
                              clearCurrentMeetingKey();
                              Alert.alert('Success', 'Meeting ended successfully.');
                              loadMeetings();
                            } else {
                              Alert.alert('Error', (forceResponse as any).message || 'Failed to end meeting');
                            }
                          } catch (err: any) {
                            console.error('Force end meeting failed:', err);
                            Alert.alert('Error', err?.message || 'Failed to end meeting');
                          } finally {
                            setActionBusyKey(null);
                          }
                        },
                      },
                    ]
                  );
                } else {
                  Toast.show({ type: 'info', text1: 'Ending meeting...', visibilityTime: 2000 });
                  try {
                    const forceResponse = await apiClient.endMeeting(roomId, true);
                    if (forceResponse.success) {
                      clearCurrentMeetingKey();
                      Alert.alert('Success', 'Meeting ended successfully.');
                      loadMeetings();
                    } else {
                      Alert.alert('Error', (forceResponse as any).message || 'Failed to end meeting');
                    }
                  } catch (err: any) {
                    console.error('Force end meeting failed:', err);
                    Alert.alert('Error', err?.message || 'Failed to end meeting');
                  }
                }
                return;
              }
              Alert.alert('Error', (response as any).message || 'Failed to end meeting');
            } catch (error: any) {
              console.error('Failed to end meeting:', error);
              Alert.alert('Error', error?.message || 'Failed to end meeting');
            } finally {
              setActionBusyKey(null);
            }
          },
        },
      ]
    );
  };

  const deleteMeeting = async (meeting: Meeting) => {
    const busyKey = `delete:${meeting.id}`;
    Alert.alert(
      'Delete Meeting',
      'Are you sure you want to delete this meeting?',
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Delete', 
          style: 'destructive',
          onPress: async () => {
            setActionBusyKey(busyKey);
            try {
              const response = await apiClient.deleteMeeting(meeting.id);
              
              if (response.success) {
                Alert.alert('Success', 'Meeting deleted successfully');
                loadMeetings(); // Refresh the list
              } else if (response.requires_confirmation) {
                // Show confirmation dialog for meetings with assets
                Alert.alert(
                  'Confirm Deletion',
                  response.message,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { 
                      text: 'Delete Permanently', 
                      style: 'destructive',
                      onPress: async () => {
                        setActionBusyKey(busyKey);
                        try {
                          const confirmResponse = await apiClient.deleteMeeting(meeting.id, true);
                          if (confirmResponse.success) {
                            Alert.alert('Success', 'Meeting and all assets deleted successfully');
                            loadMeetings(); // Refresh the list
                          } else {
                            Alert.alert('Error', confirmResponse.message || 'Failed to delete meeting');
                          }
                        } catch (error: any) {
                          Alert.alert('Error', error.message || 'Failed to delete meeting');
                        } finally {
                          setActionBusyKey(null);
                        }
                      }
                    }
                  ]
                );
              } else {
                Alert.alert('Error', response.message || 'Failed to delete meeting');
              }
            } catch (error: any) {
              console.error('Failed to delete meeting:', error);
              Alert.alert('Error', error.message || 'Failed to delete meeting');
            } finally {
              setActionBusyKey(null);
            }
          }
        }
      ]
    );
  };

  const removeMeetingFromList = async (meeting: Meeting) => {
    const busyKey = `remove:${meeting.id}`;
    Alert.alert(
      '',
      'This removes the meeting from your list',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          onPress: async () => {
            setActionBusyKey(busyKey);
            try {
              const res = await apiClient.dismissMeetingFromList(meeting.id);
              if (res.success) {
                Toast.show({ type: 'success', text1: 'Meeting removed from your list' });
                await loadMeetings({ silent: true });
              } else {
                Alert.alert('Error', res.message || 'Could not remove meeting');
              }
            } catch (error: any) {
              Alert.alert('Error', error?.message || 'Could not remove meeting');
            } finally {
              setActionBusyKey(null);
            }
          },
        },
      ]
    );
  };

  const addInviteEmail = () => {
    if (newInviteEmail.trim() && !inviteEmails.includes(newInviteEmail.trim().toLowerCase())) {
      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (emailRegex.test(newInviteEmail.trim())) {
        setInviteEmails(prev => [...prev, newInviteEmail.trim().toLowerCase()]);
        setNewInviteEmail('');
      } else {
        Alert.alert('Error', 'Please enter a valid email address');
      }
    }
  };

  const removeInviteEmail = (email: string) => {
    setInviteEmails(prev => prev.filter(e => e !== email));
  };

  const openInviteModal = async (meeting: Meeting) => {
    setSelectedMeeting(meeting);
    setInviteEmails([]);
    setNewInviteEmail('');
    setInviteMessage(buildLocalInviteText(meeting));
    setShowInviteModal(true);

    try {
      const response = await apiClient.copyMeetingInvite(meeting.meetingId);
      if (response.success && response.data?.invite_message) {
        setInviteMessage(stripClipboardEmojis(String(response.data.invite_message)));
      }
    } catch {
      // keep local prefill
    }
  };

  const inviteToMeeting = async () => {
    if (!selectedMeeting || inviteEmails.length === 0) {
      Alert.alert('Error', 'Please add at least one email address');
      return;
    }

    setInviteSending(true);
    try {
      const response = await apiClient.sendMeetingInvite(selectedMeeting.meetingId, {
        emails: inviteEmails,
        message: inviteMessage.trim()
      });

      if (response.success) {
        const count = inviteEmails.length;
        Alert.alert('Success', `Invitation${count > 1 ? 's' : ''} sent successfully to ${count} recipient${count > 1 ? 's' : ''}`);
        setShowInviteModal(false);
        setInviteEmails([]);
        setNewInviteEmail('');
        setInviteMessage('');
        setSelectedMeeting(null);
      } else {
        Alert.alert('Error', response.message || 'Failed to send invitation');
      }
    } catch (error: any) {
      console.error('Failed to send invitation:', error);
      Alert.alert(
        'Error',
        error?.message || error?.response?.data?.message || error?.response?.data?.error || 'Failed to send invitation'
      );
    } finally {
      setInviteSending(false);
    }
  };

  const stripClipboardEmojis = (text: string) => {
    const ranges: [number, number][] = [
      [0x1f600, 0x1f64f],
      [0x1f300, 0x1f5ff],
      [0x1f680, 0x1f6ff],
      [0x1f1e0, 0x1f1ff],
      [0x2700, 0x27bf],
      [0x2600, 0x26ff],
      [0x1f900, 0x1f9ff],
      [0x1fa00, 0x1fa6f],
      [0x1fa70, 0x1faff]
    ];
    let out = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0xfe0f || cp === 0x200d) continue;
      let skip = false;
      for (let i = 0; i < ranges.length; i++) {
        const [lo, hi] = ranges[i];
        if (cp >= lo && cp <= hi) {
          skip = true;
          break;
        }
      }
      if (!skip) out += ch;
    }
    return out.replace(/ {2,}/g, ' ').trim();
  };

  const buildLocalInviteText = (meeting: Meeting, inviteLink?: string) => {
    let details = `GrabDocs Meeting Invitation\n\n`;
    details += `Meeting: ${stripClipboardEmojis(meeting.title)}\n\n`;
    if (meeting.startTime) {
      try {
        const when = new Date(meeting.startTime);
        if (!Number.isNaN(when.getTime())) {
          details += `Date & time: ${when.toLocaleString([], {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}\n\n`;
        }
      } catch {
        // ignore bad dates
      }
    }
    const link = (inviteLink || meeting.roomUrl || '').trim();
    if (link) details += `Join Meeting:\n${link}\n\n`;
    details += `Dial-in:\n+1 415 993-7779\n`;
    details += `Meeting ID: ${meeting.meetingId}\n`;
    if (meeting.passcode) {
      details += `Passcode: ${meeting.passcode}\n`;
    }
    return stripClipboardEmojis(details);
  };

  const copyMeetingDetails = async (meeting: Meeting) => {
    try {
      if (!meeting?.meetingId) {
        Alert.alert('Error', 'Meeting ID not available');
        return;
      }
      // Use the same backend endpoint as web to get the properly formatted invitation text
      const response = await apiClient.copyMeetingInvite(meeting.meetingId);
      
      if (response.success && response.data?.invite_message) {
        await Clipboard.setStringAsync(stripClipboardEmojis(response.data.invite_message));
        Alert.alert('Copied', 'Meeting invitation copied to clipboard');
        return;
      }

      const link =
        response.data && typeof response.data === 'object' && 'invite_link' in response.data
          ? String((response.data as { invite_link?: string }).invite_link ?? '').trim()
          : '';
      await Clipboard.setStringAsync(buildLocalInviteText(meeting, link));
      Alert.alert('Copied', 'Meeting details copied to clipboard');
    } catch (error) {
      console.error('Copy error:', error);
      // Offline / API failure — still copy usable details from the list item (same idea as web)
      try {
        await Clipboard.setStringAsync(buildLocalInviteText(meeting));
        Alert.alert('Copied', 'Meeting details copied to clipboard');
      } catch (clipboardError) {
        console.error('Clipboard fallback failed:', clipboardError);
        Alert.alert('Error', 'Failed to copy meeting invitation');
      }
    }
  };

  const showMeetingInfo = async (meeting: Meeting) => {
    setInfoMeeting(meeting);
    setShowInfoModal(true);
    setLoadingInfo(true);
    setMeetingInfoData(null);
    
    try {
      const response = await apiClient.getMeetingInfo(meeting.meetingId);
      if (response.success) {
        const { room } = parseMobileMeetingInfoResponse(response as Record<string, unknown>);
        if (room) {
          setMeetingInfoData(room);
        }
      }
    } catch {
      // Non-fatal: info modal will show loading/empty state
    } finally {
      setLoadingInfo(false);
    }
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 16,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    backButton: {
      padding: 10,
      marginTop: 4,
      marginRight: 8,
    },
    headerSpacer: {
      width: 40,
    },
    headerTitle: {
      fontSize: 24,
      fontWeight: '700',
      color: colors.text,
    },
    refreshButton: {
      padding: 10,
      marginTop: 4,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 40,
    },
    loadingText: {
      marginTop: 16,
      fontSize: 16,
      color: colors.textSecondary,
    },
    quickActions: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingVertical: 20,
      backgroundColor: colors.card,
      marginBottom: 8,
      gap: 12,
    },
    actionButton: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 8,
      paddingVertical: 12,
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      minHeight: 70,
      minWidth: 90,
      maxWidth: 120,
    },
    actionButtonText: {
      marginTop: 4,
      fontSize: 12,
      fontWeight: '600',
      color: colors.text,
      textAlign: 'center',
    },
    meetingsList: {
      padding: 20,
    },
    section: {
      marginBottom: 24,
    },
    sectionTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 12,
    },
    horizontalList: {
      paddingRight: 20,
    },
    // Same border for live and recent meetings (user can only be in one at a time)
    meetingCard: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      marginRight: 12,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
      minWidth: 280,
    },
    meetingHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
    },
    meetingTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      flex: 1,
      marginRight: 8,
    },
    statusBadge: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
    },
    statusOngoing: {
      backgroundColor: '#34C759',
    },
    statusScheduled: {
      backgroundColor: '#007AFF',
    },
    statusCreated: {
      backgroundColor: '#FF9500',
    },
    statusEnded: {
      backgroundColor: '#8E8E93',
    },
    statusText: {
      fontSize: 10,
      fontWeight: '700',
      color: '#fff',
    },
    meetingDetails: {
      marginBottom: 12,
    },
    meetingHost: {
      fontSize: 14,
      color: colors.textSecondary,
      marginBottom: 4,
    },
    meetingTime: {
      fontSize: 14,
      color: colors.textSecondary,
      marginBottom: 8,
    },
    meetingMeta: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    meetingMetaCompact: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
    },
    meetingTimeCompact: {
      fontSize: 13,
      color: colors.textSecondary,
      fontWeight: '500',
    },
    detailText: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    detailTextCompact: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    meetingActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
    },
    actionIcon: {
      padding: 8,
      borderRadius: 6,
      backgroundColor: colors.surface,
    },
    emptyState: {
      alignItems: 'center',
      padding: 40,
      marginTop: 40,
    },
    emptyStateText: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      marginTop: 16,
      textAlign: 'center',
    },
    emptyStateSubtext: {
      fontSize: 14,
      color: colors.textSecondary,
      marginTop: 8,
      textAlign: 'center',
      lineHeight: 20,
    },
    createFirstButton: {
      marginTop: 20,
      paddingHorizontal: 20,
      paddingVertical: 12,
      backgroundColor: '#007AFF',
      borderRadius: 8,
    },
    createFirstButtonText: {
      color: '#fff',
      fontWeight: '600',
      fontSize: 16,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      paddingTop: 60, // Move modal up from center
    },
    joinModalContainer: {
      backgroundColor: colors.card,
      borderRadius: 12,
      marginHorizontal: 20,
      width: '90%',
      maxWidth: 400,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 4,
      elevation: 5,
    },
    modalContainer: {
      flex: 1,
      backgroundColor: colors.background,
    },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 16,
      backgroundColor: colors.card,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    cancelButton: {
      fontSize: 16,
      color: '#007AFF',
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
    },
    joinButton: {
      fontSize: 16,
      fontWeight: '600',
      color: '#007AFF',
    },
    joinButtonDisabled: {
      color: colors.textLight,
    },
    modalContent: {
      padding: 20,
    },
    inputLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 8,
      marginTop: 16,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      fontSize: 16,
      backgroundColor: colors.surface,
      color: colors.text,
    },
    textArea: {
      height: 80,
      textAlignVertical: 'top',
    },
    inviteTextArea: {
      minHeight: 200,
      maxHeight: 320,
      textAlignVertical: 'top',
    },
    infoSection: {
      marginBottom: 16,
    },
    infoCard: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    infoCardTitle: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.text,
      marginBottom: 8,
    },
    infoRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginBottom: 10,
    },
    infoItem: {
      width: '48%',
      marginRight: '2%',
      marginBottom: 10,
    },
    infoItemFull: {
      width: '100%',
      marginBottom: 8,
    },
    infoLabel: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textSecondary,
      textTransform: 'uppercase',
      marginBottom: 4,
      letterSpacing: 0.5,
    },
    infoValue: {
      fontSize: 14,
      color: colors.text,
      lineHeight: 20,
    },
    participantsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 8,
    },
    participantItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 8,
      paddingHorizontal: 12,
      backgroundColor: colors.surface,
      borderRadius: 8,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    participantName: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 2,
    },
    participantEmail: {
      fontSize: 14,
      color: colors.text,
      flex: 1,
    },
    participantInput: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
    },
    participantTextInput: {
      flex: 1,
      marginRight: 12,
    },
    addButton: {
      padding: 8,
    },
    participantsList: {
      marginTop: 8,
      marginBottom: 8,
    },
    participantHostBadge: {
      marginTop: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      backgroundColor: '#34C759',
      borderRadius: 4,
      alignSelf: 'flex-start',
    },
    participantHostText: {
      fontSize: 9,
      fontWeight: '700',
      color: '#fff',
    },
    featureBadge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    featureBadgeText: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    invitedGuestItem: {
      paddingVertical: 2,
      marginBottom: 0,
    },
    invitedGuestEmail: {
      fontSize: 13,
      color: colors.text,
    },
    invitedGuestYou: {
      fontSize: 13,
      color: colors.textSecondary,
      fontStyle: 'italic',
    },
    invitedGuestsScrollView: {
      maxHeight: 200,
    },
    hostItem: {
      paddingVertical: 2,
      marginBottom: 0,
    },
  }), [colors]);

  const renderMeetingCard = ({ item }: { item: Meeting }) => (
    <TouchableOpacity
      style={dynamicStyles.meetingCard}
      onPress={() => {
        if (isJoining) return;
        joinMeeting(item);
      }}
      onLongPress={() => {
        if (isJoining) return;
        const isLive = item.status === 'active';
        const owner = isReachMeetingOwner(item, user?.id);
        const host = isReachMeetingHost(item, user?.id);
        const canDelete = canDeleteReachMeetingFromList(item, user?.id);
        const buttons = [
          { text: 'Cancel', style: 'cancel' as const },
          { text: 'Join Meeting', onPress: () => { if (!isJoining) joinMeeting(item); } },
          { text: 'View Assets', onPress: () => viewMeetingAssets(item) },
          ...(isLive ? [{ text: 'End Meeting', style: 'destructive' as const, onPress: () => endMeeting(item) }] : []),
          ...(canDelete
            ? [{ text: 'Delete', style: 'destructive' as const, onPress: () => deleteMeeting(item) }]
            : !owner && !host && !isLive
              ? [{ text: 'Remove from my list', onPress: () => removeMeetingFromList(item) }]
              : []),
          { text: 'Invite', onPress: () => {
            void openInviteModal(item);
          }}
        ];

        Alert.alert(
          'Meeting Options',
          `Host: ${item.host}\nParticipants: ${item.participants}\nStart Time: ${formatMeetingTimeToLocal(item.startTime)}`,
          buttons as any
        );
      }}
    >
      <View style={dynamicStyles.meetingHeader}>
        <Text style={dynamicStyles.meetingTitle} numberOfLines={1}>{item.title}</Text>
        <View 
          style={[
            dynamicStyles.statusBadge, 
            item.status === 'active' ? dynamicStyles.statusOngoing : 
            item.status === 'ended' ? dynamicStyles.statusEnded :
            item.status === 'created' ? dynamicStyles.statusCreated :
            dynamicStyles.statusScheduled
          ]}
        >
          <Text style={dynamicStyles.statusText}>
            {item.status.toUpperCase()}
          </Text>
        </View>
      </View>
      
      <View style={dynamicStyles.meetingDetails}>
        <Text style={dynamicStyles.meetingHost} numberOfLines={1}>Host: {item.host}</Text>
        <View style={dynamicStyles.meetingMetaCompact}>
          <Text style={dynamicStyles.meetingTimeCompact}>{formatMeetingTimeToLocal(item.startTime)}</Text>
          <Text style={dynamicStyles.detailTextCompact}>👥 {item.participants}</Text>
          <Text style={dynamicStyles.detailTextCompact} numberOfLines={1}>ID: {item.meetingId}</Text>
        </View>
      </View>

      <View style={dynamicStyles.meetingActions}>
        <FeedbackTouchable
          style={[dynamicStyles.actionIcon, isJoining && { opacity: 0.5 }]}
          disabled={isJoining}
          spinnerColor="#007AFF"
          onPress={(e) => {
            e.stopPropagation();
            if (isJoining) return;
            return joinMeeting(item);
          }}
        >
          <Ionicons name="videocam" size={16} color="#007AFF" />
        </FeedbackTouchable>
        
        <FeedbackTouchable
          style={dynamicStyles.actionIcon}
          spinnerColor="#5856D6"
          onPress={(e) => {
            e.stopPropagation();
            return copyMeetingDetails(item);
          }}
        >
          <Ionicons name="copy" size={16} color="#5856D6" />
        </FeedbackTouchable>

        {meetingHasKnownAssets(item, assetPresenceMap) ? (
          <TouchableOpacity
            style={dynamicStyles.actionIcon}
            accessibilityLabel="Meeting assets"
            onPress={(e) => {
              e.stopPropagation();
              viewMeetingAssets(item, { fromAssetsIcon: true });
            }}
          >
            <Ionicons name="folder-open-outline" size={16} color={colors.tint || '#007AFF'} />
          </TouchableOpacity>
        ) : null}
        
        <TouchableOpacity
          style={dynamicStyles.actionIcon}
          onPress={(e) => {
            e.stopPropagation();
            showMeetingInfo(item);
          }}
        >
          <Ionicons name="information-circle" size={16} color="#FF9500" />
        </TouchableOpacity>
        
        {(item.status === 'active') && (
          <FeedbackTouchable
            style={dynamicStyles.actionIcon}
            disabled={actionBusyKey != null}
            loading={actionBusyKey === `end:${item.id}`}
            spinnerColor="#FF3B30"
            onPress={(e) => {
              e.stopPropagation();
              endMeeting(item);
            }}
          >
            <Ionicons name="stop-circle" size={16} color="#FF3B30" />
          </FeedbackTouchable>
        )}
        
        <TouchableOpacity
          style={dynamicStyles.actionIcon}
          onPress={(e) => {
            e.stopPropagation();
            void openInviteModal(item);
          }}
        >
          <Ionicons name="person-add" size={16} color="#34C759" />
        </TouchableOpacity>
        
        {canDeleteReachMeetingFromList(item, user?.id) ? (
          <FeedbackTouchable
            style={dynamicStyles.actionIcon}
            accessibilityLabel="Delete meeting"
            disabled={actionBusyKey != null}
            loading={actionBusyKey === `delete:${item.id}`}
            spinnerColor="#FF3B30"
            onPress={(e) => {
              e.stopPropagation();
              deleteMeeting(item);
            }}
          >
            <Ionicons name="trash-outline" size={16} color="#FF3B30" />
          </FeedbackTouchable>
        ) : !isReachMeetingOwner(item, user?.id) &&
          !isReachMeetingHost(item, user?.id) &&
          item.status !== 'active' ? (
          <FeedbackTouchable
            style={dynamicStyles.actionIcon}
            accessibilityLabel="Remove from my list"
            disabled={actionBusyKey != null}
            loading={actionBusyKey === `remove:${item.id}`}
            spinnerColor={colors.textSecondary || '#8E8E93'}
            onPress={(e) => {
              e.stopPropagation();
              removeMeetingFromList(item);
            }}
          >
            <Ionicons name="close-circle-outline" size={18} color={colors.textSecondary || '#8E8E93'} />
          </FeedbackTouchable>
        ) : null}
      </View>
    </TouchableOpacity>
  );

  const renderEmptyState = (title: string, subtitle: string) => (
    <View style={dynamicStyles.emptyState}>
      <Ionicons name="videocam-off-outline" size={48} color={colors.textLight} />
      <Text style={dynamicStyles.emptyStateText}>{title}</Text>
      <Text style={dynamicStyles.emptyStateSubtext}>{subtitle}</Text>
      {title.includes('meeting') && (
        <TouchableOpacity style={dynamicStyles.createFirstButton} onPress={scheduleMeeting}>
          <Text style={dynamicStyles.createFirstButtonText}>Schedule Your First Meeting</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  // Never show a Sign In wall here — spinner while auth settles or list loads.
  if (authLoading || authRecovering || !isAuthenticated || loading) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.header}>
          <AppBackButton />
          <AppHeaderTitle>Meeting Call</AppHeaderTitle>
          <View style={dynamicStyles.headerSpacer} />
        </View>
        <View style={dynamicStyles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={dynamicStyles.loadingText}>Loading meetings...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <View style={dynamicStyles.header}>
        <AppBackButton />
        <AppHeaderTitle>Meeting Call</AppHeaderTitle>
        <TouchableOpacity
          style={dynamicStyles.refreshButton}
          onPress={handleRefresh}
          disabled={refreshing}
        >
          <Ionicons name="refresh" size={28} color="#007AFF" />
        </TouchableOpacity>
      </View>

      {/* Quick Actions */}
      <View style={dynamicStyles.quickActions}>
        <TouchableOpacity style={dynamicStyles.actionButton} onPress={createMeeting}>
          <Ionicons name="add-circle" size={24} color="#007AFF" />
          <Text style={dynamicStyles.actionButtonText}>Create</Text>
        </TouchableOpacity>
        
        <TouchableOpacity
          style={[dynamicStyles.actionButton, isJoining && { opacity: 0.5 }]}
          disabled={isJoining}
          onPress={() => { if (!isJoining) setShowJoinModal(true); }}
        >
          <Ionicons name="enter" size={24} color="#34C759" />
          <Text style={dynamicStyles.actionButtonText}>Join</Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={dynamicStyles.actionButton} onPress={scheduleMeeting}>
          <Ionicons name="calendar" size={24} color="#FF9500" />
          <Text style={dynamicStyles.actionButtonText}>Schedule</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={[]}
        renderItem={renderMeetingCard}
        keyExtractor={(item) => item.id}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        contentContainerStyle={dynamicStyles.meetingsList}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={() => (
          <View>
            {/* Ongoing Meetings */}
            {ongoingMeetings.length > 0 && (
              <View style={dynamicStyles.section}>
                <Text style={dynamicStyles.sectionTitle}>Live Meetings ({ongoingMeetings.length})</Text>
                <FlatList
                  data={ongoingMeetings}
                  renderItem={renderMeetingCard}
                  keyExtractor={(item) => item.id}
                  scrollEnabled={false}
                />
              </View>
            )}

            {/* Upcoming Meetings */}
            {upcomingMeetings.length > 0 ? (
              <View style={dynamicStyles.section}>
                <Text style={dynamicStyles.sectionTitle}>Upcoming Meetings ({upcomingMeetings.length})</Text>
                <FlatList
                  data={upcomingMeetings.slice(0, 3)}
                  renderItem={renderMeetingCard}
                  keyExtractor={(item) => item.id}
                  scrollEnabled={false}
                />
              </View>
            ) : !loading && meetings.length === 0 && (
              renderEmptyState("No upcoming meetings", "Create or join a meeting to get started")
            )}

            {/* Recent Meetings */}
            {(() => {
              const recentMeetings = sortMeetingsNewestFirst(
                meetings.filter((m) => {
                // Include ended meetings
                if (m.status === 'ended') return true;
                
                // Include created/scheduled meetings without startTime (immediate meetings created via "Create")
                if ((m.status === 'created' || m.status === 'scheduled') && !m.startTime) {
                  return true;
                }
                
                return false;
              })
              );
              
              return recentMeetings.length > 0 ? (
                <View style={dynamicStyles.section}>
                  <Text style={dynamicStyles.sectionTitle}>Recent Meetings ({recentMeetings.length})</Text>
                  <FlatList
                    data={recentMeetings}
                    renderItem={renderMeetingCard}
                    keyExtractor={(item) => item.id}
                    scrollEnabled={false}
                  />
                </View>
              ) : null;
            })()}
          </View>
        )}
      />

      {/* Join Meeting Modal */}
      <Modal
        visible={showJoinModal}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setShowJoinModal(false)}
        statusBarTranslucent
      >
        <TouchableOpacity
          style={[
            dynamicStyles.modalOverlay,
            keyboardHeight > 0 && { paddingBottom: keyboardHeight },
          ]}
          activeOpacity={1}
          onPress={() => setShowJoinModal(false)}
        >
          <KeyboardAvoidingView
            behavior={undefined}
            style={{ width: '100%' }}
          >
            <TouchableOpacity
              activeOpacity={1}
              onPress={(e) => e.stopPropagation()}
            >
              <View style={dynamicStyles.joinModalContainer}>
                <View style={dynamicStyles.modalHeader}>
                  <TouchableOpacity onPress={() => setShowJoinModal(false)}>
                    <Text style={dynamicStyles.cancelButton}>Cancel</Text>
                  </TouchableOpacity>
                  <Text style={dynamicStyles.modalTitle}>Join Meeting</Text>
                  <FeedbackTouchable
                    onPress={joinMeetingById}
                    disabled={isJoining || !meetingId.trim()}
                    loading={isJoining}
                    spinnerColor="#007AFF"
                    replaceWithSpinner={false}
                  >
                    <Text style={[
                      dynamicStyles.joinButton,
                      (!meetingId.trim() || isJoining) && dynamicStyles.joinButtonDisabled
                    ]}>
                      {isJoining ? 'Joining...' : 'Join'}
                    </Text>
                  </FeedbackTouchable>
                </View>
                
                <View style={dynamicStyles.modalContent}>
                  <Text style={dynamicStyles.inputLabel}>Meeting ID</Text>
                  <TextInput
                    style={dynamicStyles.input}
                    placeholder="Enter meeting ID"
                    placeholderTextColor={colors.textLight}
                    value={meetingId}
                    onChangeText={setMeetingId}
                    autoFocus
                    keyboardType="numeric"
                    autoCapitalize="none"
                  />
                  
                  <Text style={dynamicStyles.inputLabel}>Passcode (Optional)</Text>
                  <TextInput
                    style={dynamicStyles.input}
                    placeholder="Enter meeting passcode"
                    placeholderTextColor={colors.textLight}
                    value={meetingPassword}
                    onChangeText={setMeetingPassword}
                    secureTextEntry
                    autoCapitalize="none"
                  />
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      {/* Invite Modal */}
      <Modal
        visible={showInviteModal}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowInviteModal(false)}
      >
        <SafeAreaView style={dynamicStyles.modalContainer} edges={['top', 'bottom', 'left', 'right']}>
          <View style={[dynamicStyles.modalHeader, { paddingTop: Math.max(insets.top - 20, 8) }]}>
            <TouchableOpacity onPress={() => setShowInviteModal(false)}>
              <Text style={dynamicStyles.cancelButton}>Cancel</Text>
            </TouchableOpacity>
            <Text style={dynamicStyles.modalTitle}>Invite to Meeting</Text>
            <FeedbackTouchable
              onPress={inviteToMeeting}
              disabled={inviteEmails.length === 0 || inviteSending}
              loading={inviteSending}
              spinnerColor="#007AFF"
              replaceWithSpinner={false}
            >
              <Text style={[
                dynamicStyles.joinButton,
                (inviteEmails.length === 0 || inviteSending) && dynamicStyles.joinButtonDisabled
              ]}>
                {inviteSending ? 'Sending...' : 'Send'}
              </Text>
            </FeedbackTouchable>
          </View>
          
          <ScrollView style={dynamicStyles.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={dynamicStyles.inputLabel}>Email Addresses</Text>
            <View style={dynamicStyles.participantInput}>
              <TextInput
                style={[dynamicStyles.input, dynamicStyles.participantTextInput]}
                placeholder="Enter email address"
                placeholderTextColor={colors.textLight}
                value={newInviteEmail}
                onChangeText={setNewInviteEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                onSubmitEditing={addInviteEmail}
                returnKeyType="done"
              />
              <TouchableOpacity style={dynamicStyles.addButton} onPress={addInviteEmail}>
                <Ionicons name="add" size={20} color="#007AFF" />
              </TouchableOpacity>
            </View>

            {inviteEmails.length > 0 && (
              <View style={dynamicStyles.participantsList}>
                {inviteEmails.map((email, index) => (
                  <View key={index} style={dynamicStyles.participantItem}>
                    <Text style={dynamicStyles.participantEmail} numberOfLines={1}>{email}</Text>
                    <TouchableOpacity onPress={() => removeInviteEmail(email)}>
                      <Ionicons name="close-circle" size={20} color="#FF3B30" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
            
            <Text style={dynamicStyles.inputLabel}>Message</Text>
            <TextInput
              style={[dynamicStyles.input, dynamicStyles.inviteTextArea]}
              placeholder="Meeting invitation details…"
              placeholderTextColor={colors.textLight}
              value={inviteMessage}
              onChangeText={setInviteMessage}
              multiline
              numberOfLines={10}
              textAlignVertical="top"
            />
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Info Modal */}
      <Modal
        visible={showInfoModal}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowInfoModal(false)}
      >
        <SafeAreaView style={dynamicStyles.modalContainer} edges={['left', 'right', 'bottom']}>
          <View style={[dynamicStyles.modalHeader, { paddingTop: Math.max(insets.top, 12) }]}>
            <TouchableOpacity onPress={() => setShowInfoModal(false)}>
              <Text style={dynamicStyles.cancelButton}>Close</Text>
            </TouchableOpacity>
            <Text style={dynamicStyles.modalTitle}>Meeting Information</Text>
            <FeedbackTouchable
              spinnerColor="#007AFF"
              replaceWithSpinner={false}
              onPress={async () => {
                if (infoMeeting) {
                  await copyMeetingDetails(infoMeeting);
                }
              }}
            >
              <Text style={dynamicStyles.joinButton}>Copy</Text>
            </FeedbackTouchable>
          </View>
          
          <ScrollView style={dynamicStyles.modalContent}>
            {loadingInfo ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <ActivityIndicator size="small" color="#007AFF" />
                <Text style={{ marginTop: 8, color: colors.textSecondary, fontSize: 12 }}>Loading meeting info...</Text>
              </View>
            ) : infoMeeting ? (
              <>
                {/* Title - Full width row for lengthy names */}
                <View style={dynamicStyles.infoSection}>
                  <Text style={dynamicStyles.infoLabel}>Title</Text>
                  <Text style={dynamicStyles.infoValue}>{infoMeeting.title}</Text>
                </View>

                {/* Status with Participant Count - Compact Row */}
                <View style={dynamicStyles.infoRow}>
                  <View style={dynamicStyles.infoItem}>
                    <Text style={dynamicStyles.infoLabel}>Status</Text>
                    <Text style={dynamicStyles.infoValue}>{infoMeeting.status.toUpperCase()}</Text>
                  </View>
                  <View style={dynamicStyles.infoItem}>
                    <Text style={dynamicStyles.infoLabel}>Participants</Text>
                    <Text style={dynamicStyles.infoValue}>
                      {meetingInfoData?.active_participant_count ?? 
                       meetingInfoData?.active_participants?.length ??
                       infoMeeting.participants}
                      {meetingInfoData?.max_participants ? `/${meetingInfoData.max_participants}` : ''}
                    </Text>
                  </View>
                </View>

                {/* Start time + duration (under participants); end time on next row when set */}
                <View style={dynamicStyles.infoRow}>
                  <View
                    style={
                      meetingInfoDurationMinutes(infoMeeting, meetingInfoData) != null
                        ? dynamicStyles.infoItem
                        : dynamicStyles.infoItemFull
                    }
                  >
                    <Text style={dynamicStyles.infoLabel}>Start Time</Text>
                    <Text style={dynamicStyles.infoValue}>
                      {meetingInfoStartLabel(infoMeeting, meetingInfoData)}
                    </Text>
                  </View>
                  {meetingInfoDurationMinutes(infoMeeting, meetingInfoData) != null ? (
                    <View style={dynamicStyles.infoItem}>
                      <Text style={dynamicStyles.infoLabel}>Duration</Text>
                      <Text style={dynamicStyles.infoValue}>
                        {meetingInfoDurationMinutes(infoMeeting, meetingInfoData)} min
                      </Text>
                    </View>
                  ) : null}
                </View>
                {meetingInfoEndLabel(infoMeeting, meetingInfoData) ? (
                  <View style={dynamicStyles.infoRow}>
                    <View style={dynamicStyles.infoItemFull}>
                      <Text style={dynamicStyles.infoLabel}>End Time</Text>
                      <Text style={dynamicStyles.infoValue}>
                        {meetingInfoEndLabel(infoMeeting, meetingInfoData)}
                      </Text>
                    </View>
                  </View>
                ) : null}

                {/* Meeting Connect Info Section */}
                <View style={dynamicStyles.infoSection}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                    <Ionicons name="call" size={16} color={colors.textSecondary} style={{ marginRight: 6 }} />
                    <Text style={dynamicStyles.infoLabel}>Meeting Connect Info</Text>
                  </View>
                  <View style={dynamicStyles.infoRow}>
                    <View style={dynamicStyles.infoItem}>
                      <Text style={dynamicStyles.infoLabel}>Meeting ID</Text>
                      <Text style={dynamicStyles.infoValue} numberOfLines={1}>{infoMeeting.meetingId}</Text>
                    </View>
                    {infoMeeting.passcode && (
                      <View style={dynamicStyles.infoItem}>
                        <Text style={dynamicStyles.infoLabel}>Passcode</Text>
                        <Text style={dynamicStyles.infoValue}>{infoMeeting.passcode}</Text>
                      </View>
                    )}
                  </View>
                  {meetingInfoData?.phone_number && (
                    <View style={dynamicStyles.infoRow}>
                      <View style={dynamicStyles.infoItemFull}>
                        <Text style={dynamicStyles.infoLabel}>Phone</Text>
                        <Text style={dynamicStyles.infoValue}>{meetingInfoData.phone_number}</Text>
                      </View>
                    </View>
                  )}
                </View>

                {/* Creation Details - Compact Row */}
                <View style={dynamicStyles.infoRow}>
                  {infoMeeting.createdAt && (
                    <View style={dynamicStyles.infoItem}>
                      <Text style={dynamicStyles.infoLabel}>Created</Text>
                      <Text style={dynamicStyles.infoValue}>{formatMeetingTimeToLocal(infoMeeting.createdAt)}</Text>
                    </View>
                  )}
                  <View style={dynamicStyles.infoItem}>
                    <Text style={dynamicStyles.infoLabel}>Creator</Text>
                    <Text style={dynamicStyles.infoValue} numberOfLines={1}>
                      {meetingInfoData?.creator?.username || meetingInfoData?.creator?.email || infoMeeting.host}
                    </Text>
                  </View>
                </View>

                {/* Features Section */}
                {(meetingInfoData?.enable_recording || meetingInfoData?.enable_transcription || meetingInfoData?.enable_meeting_summary) && (
                  <View style={dynamicStyles.infoSection}>
                    <TouchableOpacity 
                      style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: featuresExpanded ? 8 : 0 }}
                      onPress={() => setFeaturesExpanded(!featuresExpanded)}
                      activeOpacity={0.7}
                    >
                      <Text style={dynamicStyles.infoLabel}>Features</Text>
                      <Ionicons 
                        name={featuresExpanded ? "chevron-up" : "chevron-down"} 
                        size={18} 
                        color={colors.textSecondary} 
                      />
                    </TouchableOpacity>
                    {featuresExpanded && (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                        {meetingInfoData.enable_recording && (
                          <View style={dynamicStyles.featureBadge}>
                            <Text style={dynamicStyles.featureBadgeText}>Recording</Text>
                          </View>
                        )}
                        {meetingInfoData.enable_transcription && (
                          <View style={dynamicStyles.featureBadge}>
                            <Text style={dynamicStyles.featureBadgeText}>Transcription</Text>
                          </View>
                        )}
                        {meetingInfoData.enable_meeting_summary && (
                          <View style={dynamicStyles.featureBadge}>
                            <Text style={dynamicStyles.featureBadgeText}>Summary</Text>
                          </View>
                        )}
                      </View>
                    )}
                  </View>
                )}

                {/* Host(s) - Can be single or multiple */}
                <View style={dynamicStyles.infoCard}>
                  <Text style={dynamicStyles.infoCardTitle}>
                    {meetingInfoData?.meeting_hosts && meetingInfoData.meeting_hosts.length > 1 ? 'Hosts' : 'Host'}
                  </Text>
                  {meetingInfoData?.meeting_hosts && meetingInfoData.meeting_hosts.length > 0 ? (
                    <View>
                      {meetingInfoData.meeting_hosts.map((host: any, index: number) => {
                        const hostName = host?.username || host?.email || host?.name || 'Unknown';
                        const hostEmail = host?.email || '';
                        return (
                          <View key={index} style={dynamicStyles.hostItem}>
                            <Text style={dynamicStyles.infoValue} numberOfLines={1}>
                              {hostName}
                              {hostEmail && hostEmail !== hostName && (
                                <Text style={[dynamicStyles.infoValue, { color: colors.textSecondary, fontSize: 12 }]}>
                                  {' '}({hostEmail})
                                </Text>
                              )}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  ) : (
                    <Text style={dynamicStyles.infoValue}>
                      {meetingInfoData?.creator?.username || meetingInfoData?.creator?.email || infoMeeting.host || 'Unknown'}
                    </Text>
                  )}
                </View>

                {meetingInfoJoinLinkUrl(infoMeeting, meetingInfoData) ? (
                  <View style={dynamicStyles.infoSection}>
                    <Text style={dynamicStyles.infoLabel}>Join meeting link</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                      <Text style={[dynamicStyles.infoValue, { flex: 1 }]} selectable numberOfLines={4}>
                        {meetingInfoJoinLinkUrl(infoMeeting, meetingInfoData)}
                      </Text>
                      <TouchableOpacity
                        onPress={async () => {
                          const url = meetingInfoJoinLinkUrl(infoMeeting, meetingInfoData);
                          if (!url) return;
                          try {
                            await Clipboard.setStringAsync(url);
                            Alert.alert('Copied', 'Join link copied to clipboard');
                          } catch {
                            Alert.alert('Error', 'Could not copy URL');
                          }
                        }}
                        accessibilityLabel="Copy join meeting link"
                        accessibilityRole="button"
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="copy-outline" size={22} color={colors.tint || '#007AFF'} />
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : null}

                {infoMeeting.description && (
                  <View style={dynamicStyles.infoSection}>
                    <Text style={dynamicStyles.infoLabel}>Description</Text>
                    <Text style={dynamicStyles.infoValue}>{infoMeeting.description}</Text>
                  </View>
                )}

                {/* Invited Guests Section - Last Item with ScrollView */}
                {meetingInfoData?.invited_participants && meetingInfoData.invited_participants.length > 0 && (
                  <View style={dynamicStyles.infoCard}>
                    <Text style={dynamicStyles.infoCardTitle}>Invited Guests</Text>
                    <ScrollView 
                      style={dynamicStyles.invitedGuestsScrollView}
                      nestedScrollEnabled={true}
                      showsVerticalScrollIndicator={true}
                    >
                      {meetingInfoData.invited_participants.map((email: string, index: number) => {
                        const isCurrentUser = user?.email?.toLowerCase() === email.toLowerCase();
                        return (
                          <View key={index} style={dynamicStyles.invitedGuestItem}>
                            <Text style={dynamicStyles.invitedGuestEmail} numberOfLines={1}>
                              {email}
                              {isCurrentUser && (
                                <Text style={dynamicStyles.invitedGuestYou}> (You)</Text>
                              )}
                            </Text>
                          </View>
                        );
                      })}
                    </ScrollView>
                  </View>
                )}
              </>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

