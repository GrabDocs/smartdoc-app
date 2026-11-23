// 100ms Prebuilt Interface Implementation
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CommonActions, StackActions, useIsFocused, useNavigation, usePreventRemove, useRoute } from '@react-navigation/native';
import { Audio } from 'expo-av';
import * as Device from 'expo-device';
import * as ImagePicker from 'expo-image-picker';
import { activateKeepAwake, deactivateKeepAwake } from 'expo-keep-awake';
import * as Notifications from 'expo-notifications';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as Updates from 'expo-updates';
import React, {
  Component,
  ErrorInfo,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  AppState,
  AppStateStatus,
  BackHandler,
  DeviceEventEmitter,
  Linking,
  Modal,
  NativeModules,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AppBackButton from '../../components/AppBackButton';
import JoinRequestsManageModal from '../../components/quick-reach/JoinRequestsManageModal';
import { MeetingHmsReconnectBridge } from '../../components/quick-reach/MeetingHmsReconnectBridge';
import { MeetingPresenceConfirmBridge } from '../../components/quick-reach/MeetingPresenceConfirmBridge';
import { HMS_IOS_SCREENSHARE } from '../../constants/Config';
import {
  HMS_ROOM_JOINED_EVENT,
  LEAVE_REACH_MEETING_EVENT,
  REACH_CURRENT_MEETING_KEY,
  REACH_MEETING_NOTIFICATION_ID,
  canonicalizeReachMeetingId,
  clearLiveReachMeeting,
  isLiveReachMeetingMounted,
  reachGuestIdStorageKey,
  resumeLiveReachMeetingRoute,
  setLiveReachMeeting,
  setLiveReachMeetingMounted,
  shouldSkipHmsLeave,
} from '../../constants/reachMeeting';
import { useLimitError } from '../../contexts/LimitErrorContext';
import { apiClient } from '../../services/api';
import { errorLogger } from '../../services/errorLogger';
import {
  releaseHmsCallAudioMode,
  restoreHmsCallAudioMode,
  waitForHmsAudioReleased,
} from '../../utils/hmsAudioSession';
import { getFriendlyHmsErrorMessage } from '../../utils/hmsFriendlyError';
import { limitErrorFromCaught } from '../../utils/limitErrorUtils';
import {
  isActiveMeetingConflict,
  needsJoinConfirm,
  parseJoinByIdResponse,
} from '../../utils/meetingJoinPresence';
import { getHmsPrefillUserName, usableReachDisplayName } from '../../utils/reachDisplayName';
import { MeetingJoinSound } from '../components/MeetingJoinSound';
import { useAuth } from '../context/auth';

const MEETING_NOTIFICATION_ID = REACH_MEETING_NOTIFICATION_ID;
/** Room Kit Header: paddingTop 8 + content 42 + paddingBottom 16 (Header.tsx HEADER_HEIGHT). */
const ROOM_KIT_HEADER_HEIGHT = 66;
/**
 * Tip “used” flag — scoped per OTA updateId so a new update shows the tip again until
 * the user minimizes via the logo once on that build.
 */
function reachMinimizeLogoUsedKey(): string {
  const updateId =
    (Updates.isEnabled && Updates.updateId) ||
    Updates.runtimeVersion ||
    'dev';
  return `reach_minimize_logo_used:${updateId}`;
}

type InCallJoinRequest = {
  id: number;
  participant_name?: string | null;
  participant_email?: string | null;
  user?: {
    username?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
  } | null;
};

function joinRequestDisplayName(req: InCallJoinRequest): string {
  const u = req.user;
  if (u) {
    const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    if (full) return full;
    if (u.username) return u.username;
    if (u.email) return u.email;
  }
  if (req.participant_name?.trim()) return req.participant_name.trim();
  if (req.participant_email?.trim()) return req.participant_email.trim();
  return 'Guest';
}

// HMS package - enabled for local testing
// All HMS functionality is handled via backend API calls
// Note: HMS is native-only, skip imports on web platform and Expo Go

// Import HMS components (native platforms only)
let HMSPrebuilt: any = null;

// Only try to import HMS on native platforms (not web) and in development builds (not Expo Go).
// HMS requires native modules that don't work in Expo Go. `require()` is required for conditional native loading.
/* eslint-disable @typescript-eslint/no-require-imports */
if (Platform.OS !== 'web') {
  try {
    const Constants = require('expo-constants').default;
    const isExpoGo = Constants.appOwnership === 'expo';

    if (!isExpoGo) {
      const roomKitPackage = require('@100mslive/react-native-room-kit');
      if (roomKitPackage?.HMSPrebuilt) {
        HMSPrebuilt = roomKitPackage.HMSPrebuilt;
      }
    }
  } catch {
    // Import errors expected in Expo Go; component handles missing module
  }
}
/* eslint-enable @typescript-eslint/no-require-imports */

// Error Boundary Component for HMS Prebuilt
class HMSErrorBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode; onError: (error: Error) => void }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('📱 HMS Error Boundary caught error:', error, errorInfo);
    // Log error to backend
    errorLogger.logError(error, {
      severity: 'error',
      screenName: 'HMSMeetingInterface',
      userAction: 'HMS Error Boundary',
      errorType: 'HMSErrorBoundary',
    });
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) {
      return null; // Let parent handle error display
    }
    return this.props.children;
  }
}

function applyGrabdocsHmsRoomKitJoinDefaults() {
  if (typeof global === 'undefined') return;
  (global as any).joinConfig = {
    mutedAudio: true,
    mutedVideo: true,
    skipPreview: false,
    audioMixer: false,
    musicMode: false,
    softwareDecoder: true,
    autoResize: false,
  };
}

/** Minimum bottom clearance on Android — edge-to-edge often reports 0 for the 3-button nav bar. */
const ANDROID_NAV_INSET = 48;

const DEFAULT_MEETING_EXIT_PATH = '/quick-reach/meeting-call';

/** Where to go after leave / prejoin cancel / back. Calendar joins pass returnTo=calendar. */
function resolveMeetingExitPath(returnToParam: unknown): string {
  const raw = returnToParam == null ? '' : Array.isArray(returnToParam) ? String(returnToParam[0]) : String(returnToParam);
  const v = raw.trim().toLowerCase();
  if (v === 'calendar' || v === '/calendar') return '/calendar';
  if (v.startsWith('/') && !v.includes('://')) return v;
  return DEFAULT_MEETING_EXIT_PATH;
}

function PrejoinBackButton({ onPress, topInset }: { onPress: () => void; topInset: number }) {
  return (
    <View style={[styles.prejoinBackContainer, { top: topInset + 8 }]} pointerEvents="box-none">
      <AppBackButton
        onPress={onPress}
        color="#fff"
        accessibilityLabel="Back to meetings"
        style={styles.prejoinBackButton}
      />
    </View>
  );
}

export default function HMSMeetingInterfaceScreen() {
  const router = useRouter();
  const { showLimitError } = useLimitError();
  const navigation = useNavigation();
  const route = useRoute();
  const params = useLocalSearchParams();
  const {
    meetingId,
    title,
    userName,
    passcode,
    passcode_token: passcodeToken,
    force_join: forceJoinParam,
    returnTo: returnToParam,
    join_request_id: joinRequestIdParam,
  } = params;
  const joinRequestIdFromRoute = (() => {
    const raw = Array.isArray(joinRequestIdParam) ? joinRequestIdParam[0] : joinRequestIdParam;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const forceJoinFromRoute =
    (() => {
      const f = forceJoinParam;
      const v = f == null ? '' : Array.isArray(f) ? String(f[0]) : String(f);
      return v === '1' || v.toLowerCase() === 'true';
    })();
  const meetingExitPath = resolveMeetingExitPath(returnToParam);
  const meetingIdForDisplay =
    meetingId == null ? undefined : Array.isArray(meetingId) ? meetingId[0] : meetingId;
  const { user, loading: authLoading } = useAuth();
  const joinInitStartedRef = useRef(false);
  const insets = useSafeAreaInsets();
  const bottomInset =
    Platform.OS === 'android' ? Math.max(insets.bottom, ANDROID_NAV_INSET) : insets.bottom;

  const roomIdRef = useRef<number | null>(null);
  const guestIdRef = useRef<string | null>(null);
  const joinPhaseRef = useRef<string | undefined>(undefined);
  const presenceConfirmedRef = useRef(false);
  const hmsJoinRetryRef = useRef(0);
  const hmsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  /** Set right before an intentional exit so the swipe/back guard lets this route be removed. */
  const isNavigatingAwayRef = useRef(false);
  /**
   * True while the user has minimized the live call to the list (HMS stays mounted underneath).
   * Stays true until this screen is focused again — never reset on a timer.
   * State twin hides in-call Modals so they do not float over the list (RN Modal is root-level).
   */
  const isMinimizingAwayRef = useRef(false);
  /** True once this instance registered itself as the live call (setLiveReachMeeting). */
  const ownsLiveMeetingRef = useRef(false);
  const [callMinimized, setCallMinimized] = useState(false);
  const [showMinimizeTip, setShowMinimizeTip] = useState(false);
  const [exitAllowed, setExitAllowed] = useState(false);
  const [exitNonce, setExitNonce] = useState(0);
  const pendingExitRef = useRef<(() => void) | null>(null);

  /** Lift the swipe/back guard, then run the navigation once React has re-rendered. */
  const exitMeetingScreen = useCallback((navigate: () => void) => {
    isNavigatingAwayRef.current = true;
    pendingExitRef.current = navigate;
    setExitAllowed(true);
    // Bump even when exitAllowed is already true, or a second leave never navigates.
    setExitNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!exitAllowed || !pendingExitRef.current) return;
    const navigate = pendingExitRef.current;
    pendingExitRef.current = null;
    navigate();
  }, [exitAllowed, exitNonce]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /** Leave API only after confirm — no ActiveParticipant row exists before that. */
  const leaveConfirmedReachSession = useCallback(async () => {
    // Snapshot before any await. Callers clear presenceConfirmedRef immediately
    // so the screen can close; reading the ref later skipped the leave API.
    // Do not leave on in-room alone. Confirm never finishing means this user
    // has no attendance row, and a leave with zero participants ends the meeting.
    const shouldNotify = presenceConfirmedRef.current && !!meetingId;
    const roomId = roomIdRef.current ?? undefined;
    const guestId = guestIdRef.current ?? undefined;
    const id = meetingId ? String(meetingId).trim() : '';
    // Always drop local "I'm in this call" markers so list status=active cannot block
    // joining another meeting after this leave.
    try {
      await AsyncStorage.removeItem(REACH_CURRENT_MEETING_KEY);
    } catch {
      /* ignore */
    }
    clearLiveReachMeeting(meetingId);
    if (!shouldNotify || !id) return;
    try {
      await apiClient.leaveReachMeeting(id, {
        roomId,
        guestId,
      });
    } catch {
      /* ignore */
    }
    // Leave burns server-side JoinRequest; drop any local wait/approval state too.
    AsyncStorage.removeItem('join_approval_waiting').catch(() => {});
  }, [meetingId]);

  const goToAppHome = useCallback(async () => {
    // Stop sticky meeting notification immediately; leave API still needs presenceConfirmedRef.
    isNavigatingAwayRef.current = true;
    notificationDisplayedRef.current = false;
    Notifications.dismissNotificationAsync(MEETING_NOTIFICATION_ID).catch(() => {});
    try {
      await AsyncStorage.removeItem(REACH_CURRENT_MEETING_KEY);
    } catch {
      /* ignore */
    }
    clearLiveReachMeeting(meetingId);
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    await leaveConfirmedReachSession();
    presenceConfirmedRef.current = false;
    inHmsRoomRef.current = false;
    exitMeetingScreen(() => router.replace('/(tabs)' as any));
  }, [router, leaveConfirmedReachSession, meetingId, exitMeetingScreen]);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [hmsError, setHmsError] = useState<string | null>(null);
  const [permissionsGranted, setPermissionsGranted] = useState<boolean | null>(null);
  const [joinConfig, setJoinConfig] = useState<any>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [hmsMountKey, setHmsMountKey] = useState(0);
  const [joinStuckExhausted, setJoinStuckExhausted] = useState(false);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const recordingPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previousRecordingStateRef = useRef<boolean | null>(null);
  const recordingActiveRef = useRef(false);
  const notificationShownForCurrentStartRef = useRef(false);
  const locallyInitiatedThisStartRef = useRef(false);
  const pendingLocalStartAtRef = useRef<number | null>(null);
  const recordingOffSinceRef = useRef<number | null>(null);
  const LOCAL_START_WINDOW_MS = 90000;
  const RECORDING_STOP_DEBOUNCE_MS = 8000;

  const notificationDisplayedRef = useRef(false);
  const pipFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [orientationReadyForHms, setOrientationReadyForHms] = useState(() => Platform.OS === 'web');
  const [joinSoundReady, setJoinSoundReady] = useState(false);
  /** Canonical GrabDocs meeting id from join response (preferred for list/storage merge). */
  const [resolvedStorageMeetingId, setResolvedStorageMeetingId] = useState<string | null>(null);
  /** True only after HMS room join + `/join-by-id/confirm` — gates presence side effects (storage, etc.). */
  const [presenceConfirmed, setPresenceConfirmed] = useState(false);
  /** True once HMS reports room entry (before/without confirm). Allows heartbeat safety-net upsert. */
  const [inHmsRoom, setInHmsRoom] = useState(false);
  const inHmsRoomRef = useRef(false);
  const [showJoinRequestsModal, setShowJoinRequestsModal] = useState(false);
  const [pendingJoinRequestCount, setPendingJoinRequestCount] = useState(0);
  const [pendingJoinRequests, setPendingJoinRequests] = useState<InCallJoinRequest[]>([]);
  const [dismissedJoinRequestIds, setDismissedJoinRequestIds] = useState<number[]>([]);
  const [approvingJoinRequestId, setApprovingJoinRequestId] = useState<number | null>(null);
  const [canApproveJoinRequests, setCanApproveJoinRequests] = useState(false);
  const [canManageJoinRequests, setCanManageJoinRequests] = useState(false);

  useEffect(() => {
    presenceConfirmedRef.current = presenceConfirmed;
  }, [presenceConfirmed]);

  useEffect(() => {
    inHmsRoomRef.current = inHmsRoom;
  }, [inHmsRoom]);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  type JoinConfirmContext = {
    meetingIdStr: string;
    token: string;
    displayName: string;
    viewerType: string;
    passcodePayload: Record<string, string>;
    startedWithForceJoin: boolean;
  };
  const joinConfirmContextRef = useRef<JoinConfirmContext>({
    meetingIdStr: '',
    token: '',
    displayName: '',
    viewerType: 'guest',
    passcodePayload: {},
    startedWithForceJoin: false,
  });
  const presenceConfirmSentRef = useRef(false);

  // HMS media reconnect overlay — only when the call itself is reconnecting (matches web).
  // Backend /health failures are silent; heartbeats stay on their own interval.
  const [isNetworkDown, setIsNetworkDown] = useState(false);
  const [showReconnected, setShowReconnected] = useState(false);
  const reconnectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleHmsReconnecting = useCallback(() => {
    setShowReconnected(false);
    if (reconnectedTimerRef.current) {
      clearTimeout(reconnectedTimerRef.current);
      reconnectedTimerRef.current = null;
    }
    setIsNetworkDown(true);
  }, []);

  const handleHmsReconnected = useCallback(() => {
    setIsNetworkDown(false);
    setShowReconnected(true);
    if (reconnectedTimerRef.current) clearTimeout(reconnectedTimerRef.current);
    reconnectedTimerRef.current = setTimeout(() => setShowReconnected(false), 3000);
    // Quiet presence refresh after media recovers (no user-facing banner for API health).
    if (roomIdRef.current && presenceConfirmedRef.current) {
      apiClient
        .sendMeetingHeartbeat(roomIdRef.current, {
          guestId: guestIdRef.current ?? undefined,
          participantName: joinConfirmContextRef.current.displayName || undefined,
        })
        .catch(() => {});
    }
  }, []);

  // In-meeting dismissable banners (recording started, peer joined)
  const [bannerQueue, setBannerQueue] = useState<
    { message: string; subtitle?: string; type: 'recording' | 'joined' }[]
  >([]);
  const dismissBanner = useCallback(() => setBannerQueue(prev => prev.slice(1)), []);

  // Collect peer names over a 2s window, then collapse into one banner
  const pendingJoinNamesRef = useRef<string[]>([]);
  const joinGroupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePeerJoined = useCallback((peerName: string) => {
    pendingJoinNamesRef.current.push(peerName);
    if (joinGroupTimerRef.current) clearTimeout(joinGroupTimerRef.current);
    joinGroupTimerRef.current = setTimeout(() => {
      const names = pendingJoinNamesRef.current;
      pendingJoinNamesRef.current = [];
      joinGroupTimerRef.current = null;
      // Banner covers the HMS UI — skip it while still on prejoin.
      if (!inHmsRoomRef.current && !presenceConfirmedRef.current) return;
      let message: string;
      if (names.length === 1) {
        message = `${names[0]} joined the meeting`;
      } else if (names.length === 2) {
        message = `${names[0]} and ${names[1]} joined the meeting`;
      } else {
        message = `${names[0]} and ${names.length - 1} others joined the meeting`;
      }
      setBannerQueue(prev => [...prev, { message, type: 'joined' }]);
    }, 2000);
  }, []);

  // Listen for joins as soon as HMS is mounted — not after presence confirm. Solo hosts often
  // only get confirmed by the first remote PEER_JOINED, which a later-mounted listener misses.
  // Same ON_PEER_UPDATE channel as MeetingPresenceConfirmBridge, so mounting early is safe.
  useEffect(() => {
    if (!joinConfig || Platform.OS === 'web') {
      setJoinSoundReady(false);
      return;
    }
    setJoinSoundReady(true);
  }, [joinConfig]);

  useEffect(() => {
    return () => {
      if (reconnectedTimerRef.current) clearTimeout(reconnectedTimerRef.current);
    };
  }, []);

  // Room-kit HMSSDK.build reads `global.joinConfig` before mount; portrait lock aligns camera preview.
  // Cap wait so a slow orientation API cannot delay HMS/camera past ~400ms.
  useLayoutEffect(() => {
    if (Platform.OS === 'web') return;
    applyGrabdocsHmsRoomKitJoinDefaults();

    let cancelled = false;
    setOrientationReadyForHms(false);

    const failSafe = setTimeout(() => {
      if (!cancelled) setOrientationReadyForHms(true);
    }, 400);

    const run = async () => {
      try {
        if (Device.deviceType !== Device.DeviceType.TABLET) {
          const supported = await ScreenOrientation.supportsOrientationLockAsync(
            ScreenOrientation.OrientationLock.PORTRAIT_UP,
          );
          if (!cancelled && supported) {
            await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
          }
        }
      } catch {
        /* non-fatal */
      } finally {
        if (!cancelled) {
          setOrientationReadyForHms(true);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      clearTimeout(failSafe);
      ScreenOrientation.unlockAsync().catch(() => {});
    };
  }, [meetingId]);

  // Permissions + join token in parallel — do not wait for camera dialogs before fetching the HMS token.
  useEffect(() => {
    let cancelled = false;

    const requestPerms = async () => {
      if (Platform.OS === 'web') {
        if (!cancelled) setPermissionsGranted(true);
        return;
      }
      try {
        const [cameraStatus, audioStatus] = await Promise.all([
          ImagePicker.requestCameraPermissionsAsync(),
          Audio.requestPermissionsAsync().catch(() => ({ status: 'granted' as const })),
        ]);
        const ok = cameraStatus.status === 'granted' && audioStatus.status === 'granted';
        if (cancelled) return;
        setPermissionsGranted(ok);
        if (!ok) {
          setError(
            'Camera and microphone permissions are required. Please enable them in Settings.',
          );
          setIsLoading(false);
        } else {
          setError((prev) =>
            prev && /permissions are required/i.test(prev) ? null : prev,
          );
        }
      } catch (permError) {
        console.error('📱 [HMS] Error checking permissions:', permError);
        if (cancelled) return;
        setPermissionsGranted(false);
        setError(
          'Camera and microphone permissions are required. Please enable them in Settings.',
        );
        setIsLoading(false);
      }
    };

    void requestPerms();

    return () => {
      cancelled = true;
    };
  }, []);

  // Wait until auth has hydrated so logged-in users are not prepared as nameless guests.
  useEffect(() => {
    if (authLoading) return;
    if (joinInitStartedRef.current) return;

    // Another HMS instance already owns this live call (minimized under the stack).
    // A fresh mount has no authToken — never fall through to an empty catch-all UI.
    // Pop back to the live screen. Never remount HMSPrebuilt here: Android HMSSDK is a
    // singleton and a second preview() throws "[PREVIEW]: preview has already been started".
    if (isLiveReachMeetingMounted(meetingId) && !ownsLiveMeetingRef.current) {
      const liveRoute = resumeLiveReachMeetingRoute(meetingId);
      if (liveRoute) {
        joinInitStartedRef.current = true;
        // This is a duplicate HMS screen. Pop back to the earlier one that owns the call;
        // navigating by name would resolve to this (current) screen and stay here.
        const popToLiveOwner = () => {
          const stackState = navigation.getState();
          const selfIndex = stackState?.routes.findIndex((r) => r.key === route.key) ?? -1;
          let liveIndex = -1;
          if (stackState && selfIndex > 0) {
            for (let i = selfIndex - 1; i >= 0; i--) {
              if (stackState.routes[i].name === route.name) {
                liveIndex = i;
                break;
              }
            }
          }
          if (liveIndex >= 0) {
            const popCount = selfIndex - liveIndex;
            exitMeetingScreen(() => navigation.dispatch(StackActions.pop(popCount)));
          } else {
            exitMeetingScreen(() => router.dismissTo(liveRoute as any));
          }
        };
        popToLiveOwner();
        const failSafe = setTimeout(() => {
          if (!isMountedRef.current) return;
          // Still a duplicate under a live owner — retry dismiss only. Do not start preview again.
          if (isLiveReachMeetingMounted(meetingId) && !ownsLiveMeetingRef.current) {
            popToLiveOwner();
            return;
          }
          // Live owner gone (process killed / stack cleared) — safe to prepare a new session.
          void initializePrebuiltInterface();
        }, 500);
        return () => {
          clearTimeout(failSafe);
          // Strict Mode re-runs effects; allow the second pass to recover if needed.
          joinInitStartedRef.current = false;
        };
      }
    }

    joinInitStartedRef.current = true;
    void initializePrebuiltInterface();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot after auth is ready
  }, [authLoading]);

  // Check camera and microphone permissions
  const checkPermissions = async () => {
    try {
      if (Platform.OS !== 'web') {
        const [cameraStatus, audioPermission] = await Promise.all([
          ImagePicker.requestCameraPermissionsAsync(),
          Audio.requestPermissionsAsync().catch(() => ({ status: 'granted' as const })),
        ]);
        const audioStatus = audioPermission;

        const granted = cameraStatus.status === 'granted' && audioStatus.status === 'granted';
        setPermissionsGranted(granted);
        
        if (!granted) {
          console.warn('⚠️ [HMS] Camera or microphone permission not granted');
          errorLogger.logError(
            new Error(`Permissions not granted: camera=${cameraStatus.status}, audio=${audioStatus.status}`),
            {
              severity: 'warning',
              screenName: 'HMSMeetingInterface',
              userAction: 'Check Permissions',
              errorType: 'HMSPermissionsDenied',
              userId: user?.id,
            }
          );
        }
      } else {
        setPermissionsGranted(true); // Web doesn't need explicit permissions
      }
    } catch (error: any) {
      console.error('📱 [HMS] Error checking permissions:', error);
      setPermissionsGranted(false);
      errorLogger.logError(error, {
        severity: 'warning',
        screenName: 'HMSMeetingInterface',
        userAction: 'Check Permissions',
        errorType: 'HMSPermissionCheckFailed',
        userId: user?.id,
      });
    }
  };

  // Heartbeat after HMS room entry (not only after confirm) so a missed confirm can
  // still recreate ActiveParticipant via the backend heartbeat upsert safety net.
  useEffect(() => {
    if (!roomId || !inHmsRoom) return;

    // Clear any existing interval
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }

    // Send initial heartbeat immediately
    const sendHeartbeat = async () => {
      try {
        await apiClient.sendMeetingHeartbeat(roomId, {
          guestId: guestIdRef.current ?? undefined,
          participantName: joinConfirmContextRef.current.displayName || undefined,
        });
      } catch {
        // Silently fail - heartbeat errors shouldn't break the app
      }
    };

    // Send first heartbeat immediately
    sendHeartbeat();

    // Set up interval to send heartbeat every 25 seconds (recommended: 20-30 seconds)
    heartbeatIntervalRef.current = setInterval(() => {
      sendHeartbeat();
    }, 25000);

    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };
  }, [roomId, inHmsRoom]);

  const markPendingLocalStart = useCallback(() => {
    pendingLocalStartAtRef.current = Date.now();
    locallyInitiatedThisStartRef.current = true;
  }, []);

  const claimLocalStart = useCallback(() => {
    if (!locallyInitiatedThisStartRef.current && pendingLocalStartAtRef.current == null) {
      return false;
    }
    const at = pendingLocalStartAtRef.current;
    if (at != null && Date.now() - at >= LOCAL_START_WINDOW_MS) {
      locallyInitiatedThisStartRef.current = false;
      pendingLocalStartAtRef.current = null;
      return false;
    }
    locallyInitiatedThisStartRef.current = true;
    return true;
  }, []);

  const handleRecordingStarted = useCallback((opts?: { locallyInitiated?: boolean }) => {
    if (opts?.locallyInitiated) {
      locallyInitiatedThisStartRef.current = true;
    }
    recordingActiveRef.current = true;
    if (!presenceConfirmed) {
      return;
    }
    if (notificationShownForCurrentStartRef.current) {
      return;
    }
    notificationShownForCurrentStartRef.current = true;
    if (locallyInitiatedThisStartRef.current) {
      return;
    }
    setBannerQueue((prev) => [
      ...prev,
      {
        message: 'Meeting is being recorded.',
        type: 'recording',
      },
    ]);
  }, [presenceConfirmed]);

  const applyRecordingSample = useCallback((isRecording: boolean, opts?: { locallyInitiated?: boolean }) => {
    if (opts?.locallyInitiated && isRecording && !locallyInitiatedThisStartRef.current) {
      markPendingLocalStart();
    }
    recordingActiveRef.current = isRecording;
    if (!presenceConfirmed) {
      return;
    }
    if (isRecording) {
      recordingOffSinceRef.current = null;
    }
    if (previousRecordingStateRef.current === null) {
      previousRecordingStateRef.current = isRecording;
      if (isRecording) {
        handleRecordingStarted({ locallyInitiated: claimLocalStart() });
      }
      return;
    }
    const prev = previousRecordingStateRef.current;
    if (!prev && isRecording) {
      previousRecordingStateRef.current = true;
      handleRecordingStarted({ locallyInitiated: claimLocalStart() });
      return;
    }
    if (prev && !isRecording) {
      // A lagging status poll can report "off" after this device already
      // started recording. Wait for the off state to stick before treating
      // it as a stop, or the next "on" sample notifies the person who started it.
      const now = Date.now();
      if (recordingOffSinceRef.current == null) {
        recordingOffSinceRef.current = now;
        return;
      }
      if (now - recordingOffSinceRef.current < RECORDING_STOP_DEBOUNCE_MS) {
        return;
      }
      previousRecordingStateRef.current = false;
      notificationShownForCurrentStartRef.current = false;
      locallyInitiatedThisStartRef.current = false;
      pendingLocalStartAtRef.current = null;
      recordingOffSinceRef.current = null;
    }
  }, [presenceConfirmed, handleRecordingStarted, claimLocalStart, markPendingLocalStart]);

  useEffect(() => {
    if (!presenceConfirmed) {
      previousRecordingStateRef.current = null;
      recordingActiveRef.current = false;
      notificationShownForCurrentStartRef.current = false;
      locallyInitiatedThisStartRef.current = false;
      pendingLocalStartAtRef.current = null;
      recordingOffSinceRef.current = null;
    } else if (recordingActiveRef.current && previousRecordingStateRef.current === null) {
      applyRecordingSample(true);
    }
  }, [presenceConfirmed, applyRecordingSample]);

  // Room Kit starts recording through HMSManager (Record → startRTMPOrRecording,
  // HLS+record → startHLSStreaming). Wrap those calls, not room-update listeners.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const mgr = NativeModules.HMSManager as
      | Record<string, ((...args: any[]) => Promise<any>) | undefined>
      | undefined;
    if (!mgr) return;
    const originals: Array<[string, (...args: any[]) => Promise<any>]> = [];
    const wrap = (method: string, isLocalStart: (config: any) => boolean) => {
      const current = mgr[method];
      if (typeof current !== 'function') return;
      const original = current.bind(mgr);
      originals.push([method, original]);
      mgr[method] = (...args: any[]) => {
        if (isLocalStart(args[0])) {
          markPendingLocalStart();
        }
        return original(...args);
      };
    };
    wrap('startRTMPOrRecording', (config) => !config || config.record !== false);
    wrap('startHLSStreaming', (config) => {
      const rec = config?.hlsRecordingConfig ?? config?.recording;
      return rec === true || rec?.singleFilePerLayer === true || rec?.videoOnDemand === true;
    });
    return () => {
      for (const [method, original] of originals) {
        mgr[method] = original;
      }
    };
  }, [markPendingLocalStart]);

  // Poll recording status after GrabDocs presence is confirmed (late join + mid-call start).
  useEffect(() => {
    if (!roomId || Platform.OS === 'web' || !joinConfig || !presenceConfirmed) return;

    const RECORDING_POLL_INTERVAL = 2000;

    const checkRecording = async () => {
      try {
        const guestId = guestIdRef.current;
        const response = await apiClient.client.get(
          `/api/v1/video/room/${roomId}/recording-status`,
          {
            withCredentials: true,
            params: guestId ? { guest_id: guestId } : undefined,
          }
        );
        if (typeof response.data?.is_recording === 'boolean') {
          applyRecordingSample(!!response.data.is_recording);
        }
      } catch {
        // Status is non-critical
      }
    };

    checkRecording();
    recordingPollIntervalRef.current = setInterval(checkRecording, RECORDING_POLL_INTERVAL);

    return () => {
      if (recordingPollIntervalRef.current) {
        clearInterval(recordingPollIntervalRef.current);
        recordingPollIntervalRef.current = null;
      }
    };
  }, [roomId, joinConfig, presenceConfirmed, applyRecordingSample]);

  // In-call join approval: poll pending requests for anyone connected in the meeting.
  useEffect(() => {
    if (!roomId || !presenceConfirmed || !user?.id || !meetingId) {
      setCanApproveJoinRequests(false);
      setCanManageJoinRequests(false);
      setPendingJoinRequestCount(0);
      setPendingJoinRequests([]);
      return;
    }
    let cancelled = false;
    let approvalEnabled: boolean | null = null;

    const poll = async () => {
      try {
        if (approvalEnabled == null) {
          try {
            const info = await apiClient.getMeetingInfo(String(meetingId).trim());
            const room =
              (info as any)?.data?.room ||
              (info as any)?.room ||
              (info as any)?.data ||
              info;
            approvalEnabled = !!(
              room?.require_join_approval || room?.requireJoinApproval
            );
          } catch {
            approvalEnabled = false;
          }
        }
        if (!approvalEnabled) {
          if (!cancelled) {
            setCanApproveJoinRequests(false);
            setCanManageJoinRequests(false);
            setPendingJoinRequestCount(0);
            setPendingJoinRequests([]);
          }
          return;
        }
        const res = await apiClient.getJoinRequests(roomId);
        if (cancelled) return;
        const list = Array.isArray(res?.join_requests)
          ? (res.join_requests as InCallJoinRequest[])
          : [];
        setCanApproveJoinRequests(res?.can_approve !== false);
        setCanManageJoinRequests(!!res?.can_manage);
        setPendingJoinRequests(list);
        setPendingJoinRequestCount(list.length);
        // Drop dismissals for requests that are no longer pending.
        setDismissedJoinRequestIds((prev) =>
          prev.filter((id) => list.some((r) => r.id === id)),
        );
      } catch {
        if (cancelled) return;
        // 403 / errors: not yet an active participant (or unauthorized)
        setCanApproveJoinRequests(false);
        setCanManageJoinRequests(false);
        setPendingJoinRequestCount(0);
        setPendingJoinRequests([]);
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [roomId, presenceConfirmed, user?.id, meetingId]);

  // Cleanup on unmount (e.g., user swipes back). Do NOT call leave endpoint here.
  // Meeting must stay connected so user can return via active meeting card. Leave is only
  // called when user explicitly taps "Leave Meeting" and confirms (handleLeaveMeeting).
  useEffect(() => {
    return () => {
      // Stop heartbeat
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }

      // Clear pending join group timer
      if (joinGroupTimerRef.current) {
        clearTimeout(joinGroupTimerRef.current);
        joinGroupTimerRef.current = null;
      }

      // Always clear the sticky "In GrabDocs meeting" notification when this screen dies.
      Notifications.dismissNotificationAsync(MEETING_NOTIFICATION_ID).catch(() => {});
      notificationDisplayedRef.current = false;

      // Deactivate keep-awake
      deactivateKeepAwake();

      if (hmsRetryTimerRef.current) {
        clearTimeout(hmsRetryTimerRef.current);
        hmsRetryTimerRef.current = null;
      }
    };
  }, []);

  const dismissMeetingNotification = useCallback(() => {
    notificationDisplayedRef.current = false;
    Notifications.dismissNotificationAsync(MEETING_NOTIFICATION_ID).catch(() => {});
  }, []);

  // Show "In meeting" notification only (no in-app bubble). Used when PiP fallback is needed.
  const showMeetingNotification = useCallback(async () => {
    // Never re-post after leave / while exiting — stale AppState timers used to keep this alive.
    if (isNavigatingAwayRef.current) return;
    if (!presenceConfirmedRef.current && !inHmsRoomRef.current) return;
    try {
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('meeting', {
          name: 'Meeting',
          importance: Notifications.AndroidImportance.HIGH,
        });
      }
      await Notifications.scheduleNotificationAsync({
        identifier: MEETING_NOTIFICATION_ID,
        content: {
          title: 'In GrabDocs meeting',
          body: 'Tap to return',
          data: {
            type: 'meeting_minimized',
            meetingId: String(meetingId),
            title: title ? String(title) : undefined,
            userName: userName ? String(userName) : undefined,
          },
        },
        trigger: null,
        ...(Platform.OS === 'android' && { channelId: 'meeting' }),
      });
      notificationDisplayedRef.current = true;
    } catch {
      /* notification scheduling is best-effort */
    }
  }, [meetingId, title, userName]);

  // Back / minimize:
  // - Prejoin: leave the route (no live session yet).
  // - In-call: push the list ON TOP of HMS so WebRTC stays mounted; return via Active card.
  // Native iOS edge-swipe cannot do this safely (peek → bounce → leave loop). Gesture is
  // disabled while in-call; Android back + in-call chevron call this instead.
  const isScreenFocused = useIsFocused();
  const goBackToApp = useCallback((opts?: { fromLogo?: boolean }) => {
    // Minimize as soon as we're in the HMS room (inHmsRoom), not only after GrabDocs confirm.
    if (presenceConfirmed || inHmsRoom) {
      // List/Home on top — ignore hardware back while this screen is covered.
      // Logo taps may still arrive when useIsFocused lags after list→Home→return; trust those.
      // Do not also require callMinimized; that state can stay true after return and
      // swallow the next logo tap.
      if ((!opts?.fromLogo && !isScreenFocused) || isMinimizingAwayRef.current) return;
      isMinimizingAwayRef.current = true;
      setCallMinimized(true);
      // Keep liveReachMeetingMounted true — this screen stays under the stack.
      void showMeetingNotification();
      // Seed the list with Live Meetings immediately (avoids a Recent/ended-only flash).
      const q = new URLSearchParams({ resumeLive: '1' });
      const mid = meetingId == null ? '' : Array.isArray(meetingId) ? String(meetingId[0]) : String(meetingId);
      const ttl = title == null ? '' : Array.isArray(title) ? String(title[0]) : String(title);
      if (mid) q.set('liveId', mid);
      if (ttl) q.set('liveTitle', ttl);
      const exit = String(meetingExitPath || DEFAULT_MEETING_EXIT_PATH);
      const sep = exit.includes('?') ? '&' : '?';
      router.push(`${exit}${sep}${q.toString()}` as any);
      return;
    }
    // HMS prejoin / not yet in room — leave this screen.
    exitMeetingScreen(() => router.replace(meetingExitPath as any));
  }, [router, presenceConfirmed, inHmsRoom, meetingExitPath, showMeetingNotification, meetingId, title, exitMeetingScreen, isScreenFocused]);

  // Returning to the call ends the minimized state. useIsFocused tracks nested focus
  // (root stack → quick-reach → this screen); the screen's own 'focus' event can be missed
  // when the user went list → Home and came back, leaving the logo overlay hidden.
  useEffect(() => {
    if (!isScreenFocused) return;
    isMinimizingAwayRef.current = false;
    setCallMinimized(false);
    // User is back in the call UI — clear the "tap to return" notification.
    dismissMeetingNotification();
  }, [isScreenFocused, dismissMeetingNotification]);

  // HMS on screen (prejoin or in-call). Logo tip / minimize chrome only after Join.
  const hmsScreenActive = Boolean(joinConfig && authToken && !hmsError);
  /** Past HMS Join only — never show logo tip / in-call overlays on prejoin. */
  const inCallChrome = Boolean(hmsScreenActive && inHmsRoom);

  // Keep swipe-back off for the whole meeting route (prejoin + in-call). The parent
  // `quick-reach` route is locked from app/_layout.tsx (route-based, first frame) because a
  // disabled nested swipe on iOS falls through to the parent and pops the whole group.
  useLayoutEffect(() => {
    navigation.setOptions({
      gestureEnabled: false,
      fullScreenGestureEnabled: false,
    } as any);
  }, [navigation]);

  // Tip after join until logo minimize once — resets for each OTA (new Updates.updateId).
  // Auto-dismiss so a leftover banner cannot sit over the call UI.
  useEffect(() => {
    if (!inCallChrome || callMinimized) {
      setShowMinimizeTip(false);
      return;
    }
    let cancelled = false;
    let autoHide: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        const used = await AsyncStorage.getItem(reachMinimizeLogoUsedKey());
        if (cancelled || used) return;
        setShowMinimizeTip(true);
        autoHide = setTimeout(() => {
          if (!cancelled) setShowMinimizeTip(false);
        }, 6000);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      if (autoHide) clearTimeout(autoHide);
    };
  }, [inCallChrome, callMinimized]);

  const dismissMinimizeTip = useCallback(() => {
    setShowMinimizeTip(false);
  }, []);

  const minimizeToMeetingList = useCallback(() => {
    setShowMinimizeTip(false);
    // Only count real in-call logo minimizes (not prejoin cancel).
    if (inHmsRoomRef.current || presenceConfirmedRef.current) {
      AsyncStorage.setItem(reachMinimizeLogoUsedKey(), '1').catch(() => {});
    }
    // fromLogo: overlay received the press — do not drop it if useIsFocused is stale.
    goBackToApp({ fromLogo: true });
  }, [goBackToApp]);

  const visibleJoinRequests = pendingJoinRequests.filter(
    (r) => !dismissedJoinRequestIds.includes(r.id),
  );
  const bannerJoinRequest = visibleJoinRequests[0] ?? null;
  const bannerJoinMoreCount = Math.max(0, visibleJoinRequests.length - 1);

  const dismissJoinApprovalBanner = useCallback(() => {
    if (!bannerJoinRequest) return;
    setDismissedJoinRequestIds((prev) =>
      prev.includes(bannerJoinRequest.id) ? prev : [...prev, bannerJoinRequest.id],
    );
  }, [bannerJoinRequest]);

  const approveBannerJoinRequest = useCallback(async () => {
    if (!roomId || !bannerJoinRequest || approvingJoinRequestId != null) return;
    const requestId = bannerJoinRequest.id;
    setApprovingJoinRequestId(requestId);
    try {
      await apiClient.approveJoinRequest(roomId, requestId);
      // Success or already_processed — advance silently (no toast).
      setPendingJoinRequests((prev) => {
        const next = prev.filter((r) => r.id !== requestId);
        setPendingJoinRequestCount(next.length);
        return next;
      });
      setDismissedJoinRequestIds((prev) => prev.filter((id) => id !== requestId));
    } catch {
      // Quiet — leave queue; next poll corrects state.
    } finally {
      setApprovingJoinRequestId(null);
    }
  }, [roomId, bannerJoinRequest, approvingJoinRequestId]);

  useEffect(() => {
    if (Platform.OS !== 'android' || !meetingId) return;
    const handler = () => {
      minimizeToMeetingList();
      return true;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => subscription.remove();
  }, [meetingId, minimizeToMeetingList]);

  // Block stack pops for the whole meeting screen (prejoin + in-call) until we exit intentionally.
  // Swipe/back must not tear down HMS; goBackToApp minimizes in-call or leaves prejoin cleanly.
  usePreventRemove(!!meetingId && !exitAllowed, () => {
    if (isNavigatingAwayRef.current) return;
    goBackToApp();
  });

  // PiP strategy (both platforms):
  //
  // Android:
  //   Primary:  HMS autoEnterPipMode via onUserLeaveHint() in MainActivity — fires for
  //             Home button and Recents button ONLY.
  //   Problem:  onUserLeaveHint does NOT fire for screen-off, notification shade, incoming
  //             calls, or gesture-based app switches — so PiP silently fails in those cases.
  //   Fix:      After 500 ms (letting HMS try first), call GrabDocsPipModule.enterPipForMeeting()
  //             ourselves. GrabDocsPipModule now guards against re-entry — if HMS already
  //             entered PiP it returns immediately without touching the video surface.
  //             Trigger on both 'inactive' AND 'background': Android only ever fires
  //             'background', but catching both is harmless (the timer is restarted each time
  //             and only fires once).
  //
  // iOS:
  //   Primary:  HMS autoEnterPipMode — handles PiP entry when app backgrounds.
  //   Fallback: We have no native PiP module for iOS, so after 2.5 s we show a notification
  //             if PiP did not activate (cannot check isInPipMode on iOS without native code).
  //   'inactive' on iOS fires during app-switcher animation before 'background' — we handle
  //             it with a delay so the timer is simply restarted when 'background' follows.
  const pipEnabled = Platform.OS !== 'web';
  const pipModule = Platform.OS === 'android' ? NativeModules.GrabDocsPipModule : null;
  // How long to wait before our fallback kicks in, giving HMS first chance.
  const HMS_PIP_SETTLE_MS = 500;   // let HMS enter PiP, then we check/enter
  const NOTIFICATION_FALLBACK_MS = 2500; // if still no PiP, show notification
  useEffect(() => {
    const stillInLiveCall = () =>
      Boolean(
        authToken &&
          meetingId &&
          presenceConfirmedRef.current &&
          !isNavigatingAwayRef.current &&
          isLiveReachMeetingMounted(meetingId),
      );

    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        // Use refs so a leave that already cleared presence cannot re-post the sticky notif.
        if (!stillInLiveCall()) return;

        // Always restart the timer so rapid state changes (inactive→background) don't
        // double-fire — the last event wins.
        if (pipFallbackTimerRef.current) clearTimeout(pipFallbackTimerRef.current);

        if (pipEnabled && pipModule) {
          // Android path — two-stage fallback.
          pipFallbackTimerRef.current = setTimeout(() => {
            pipFallbackTimerRef.current = null;
            if (!stillInLiveCall()) return;
            // Stage 1 (500 ms): enter PiP if HMS did not already do so.
            // GrabDocsPipModule guards against re-entry: if already in PiP it returns
            // true immediately without resetting the video surface.
            pipModule.enterPipForMeeting?.().then((entered: boolean) => {
              if (!entered) {
                // Stage 2: PiP truly unavailable — show notification.
                setTimeout(() => {
                  if (!stillInLiveCall()) return;
                  pipModule.isInPipMode?.().then((inPip: boolean) => {
                    if (!inPip && stillInLiveCall()) {
                      showMeetingNotification();
                    }
                  }).catch(() => {});
                }, NOTIFICATION_FALLBACK_MS - HMS_PIP_SETTLE_MS);
              }
            }).catch(() => {});
          }, HMS_PIP_SETTLE_MS);
        } else if (pipEnabled && !pipModule) {
          // iOS path — HMS handles PiP, we only show notification as last resort.
          pipFallbackTimerRef.current = setTimeout(() => {
            pipFallbackTimerRef.current = null;
            if (!stillInLiveCall()) return;
            showMeetingNotification();
          }, NOTIFICATION_FALLBACK_MS);
        } else if (stillInLiveCall()) {
          // Web / unsupported — just notify.
          showMeetingNotification();
        }
      } else if (nextState === 'active') {
        if (pipFallbackTimerRef.current) {
          clearTimeout(pipFallbackTimerRef.current);
          pipFallbackTimerRef.current = null;
        }
        dismissMeetingNotification();
        // Prejoin or in-call: restore play-and-record after OS / other-app interruptions.
        // Do not remount HMS — that drops active calls.
        if (authToken && meetingId && presenceConfirmedRef.current) {
          void restoreHmsCallAudioMode();
        }
      }
    };
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      sub.remove();
      if (pipFallbackTimerRef.current) {
        clearTimeout(pipFallbackTimerRef.current);
        pipFallbackTimerRef.current = null;
      }
    };
  }, [authToken, meetingId, showMeetingNotification, dismissMeetingNotification, pipEnabled, pipModule]);

  // Screen wake lock: activate when in meeting
  useEffect(() => {
    if (authToken && meetingId && presenceConfirmed) {
      activateKeepAwake();
    } else {
      deactivateKeepAwake();
    }
    return () => {
      deactivateKeepAwake();
    };
  }, [authToken, meetingId, presenceConfirmed]);

  // Track current meeting for "one meeting at a time" and return-via-active-card
  useEffect(() => {
    if (authToken && meetingId && presenceConfirmed) {
      const id =
        resolvedStorageMeetingId ??
        canonicalizeReachMeetingId(String(meetingId));
      AsyncStorage.setItem(REACH_CURRENT_MEETING_KEY, id).catch(() => {});
      const q = new URLSearchParams();
      const raw = params as Record<string, string | string[] | undefined>;
      for (const key of Object.keys(raw)) {
        const v = raw[key];
        const val = Array.isArray(v) ? v[0] : v;
        if (val != null && String(val) !== '') q.set(key, String(val));
      }
      if (!q.has('meetingId') && meetingId) q.set('meetingId', String(meetingId));
      setLiveReachMeeting(id, `/quick-reach/hms-meeting-interface?${q.toString()}`);
      ownsLiveMeetingRef.current = true;
    }
  }, [authToken, meetingId, presenceConfirmed, resolvedStorageMeetingId, params]);

  useEffect(() => {
    return () => {
      // A duplicate screen that popped itself must not mark the real call as unmounted.
      if (ownsLiveMeetingRef.current) setLiveReachMeetingMounted(false);
    };
  }, []);

  const initializePrebuiltInterface = async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Duplicate route under a minimized live call — never start a second Android preview.
      if (
        meetingId &&
        isLiveReachMeetingMounted(meetingId) &&
        !ownsLiveMeetingRef.current
      ) {
        setIsLoading(false);
        const liveRoute = resumeLiveReachMeetingRoute(meetingId);
        if (liveRoute) {
          exitMeetingScreen(() => router.dismissTo(liveRoute as any));
        }
        return;
      }

      // Check permissions BEFORE initializing HMS
      if (Platform.OS !== 'web' && permissionsGranted === false) {
        console.warn('⚠️ [HMS] Cannot initialize - permissions denied');
        setError('Camera and microphone permissions are required to join the meeting. Please enable them in Settings.');
        setIsLoading(false);
        return;
      }

      if (!meetingId) {
        setError('No meeting ID provided. Please try joining the meeting again from the meeting list.');
        setIsLoading(false);
        return;
      }

      // Previous leave may still hold an exclusive expo-av session. Drop it
      // before preview, or iOS reports 3015 even with no phone call.
      await waitForHmsAudioReleased();

      // Same as web: get token via join-by-id (one join path for both web and mobile).
      // Signed-out users with no typed name send '' (not 'Guest') so preview stays editable
      // and confirm/heartbeat can be updated once they type a name.
      const displayUserName = getHmsPrefillUserName(userName, user);
      const passcodePayload = passcodeToken
        ? { passcode_token: passcodeToken }
        : (passcode as string)?.trim()
          ? { passcode: (passcode as string).trim() }
          : {};

      // Sent even when signed in: an expired session joins as a guest, and the server ignores it otherwise.
      const rejoinGuestId = await AsyncStorage.getItem(reachGuestIdStorageKey(meetingId as string)).catch(
        () => null,
      );

      const joinById = async (forceJoin: boolean) => {
        return apiClient.prepareVideoJoinById({
          meeting_id: (meetingId as string).trim(),
          participant_name: displayUserName,
          enable_audio: false,
          enable_video: false,
          viewer_type: user ? 'host' : 'guest',
          join_intent: 'prepare',
          ...(rejoinGuestId ? { rejoin_guest_id: rejoinGuestId } : {}),
          ...(forceJoin ? { force_join: true } : {}),
          ...(joinRequestIdFromRoute != null ? { join_request_id: joinRequestIdFromRoute } : {}),
          ...passcodePayload,
        });
      };

      try {
        presenceConfirmSentRef.current = false;
        setPresenceConfirmed(false);
        setInHmsRoom(false);
        setJoinStuckExhausted(false);
        hmsJoinRetryRef.current = 0;
        guestIdRef.current = null;
        joinPhaseRef.current = undefined;
        let joinRes;
        try {
          joinRes = await joinById(forceJoinFromRoute);
        } catch (firstErr: unknown) {
          if (forceJoinFromRoute) {
            throw firstErr;
          }
          if (isActiveMeetingConflict(firstErr)) {
            joinRes = await joinById(true);
          } else {
            throw firstErr;
          }
        }

        const parsed = parseJoinByIdResponse(joinRes?.data);
        const token = parsed.token;
        if (!token) {
          throw new Error('Join did not return a token');
        }
        if (parsed.roomId != null) {
          setRoomId(parsed.roomId);
          roomIdRef.current = parsed.roomId;
        }
        joinPhaseRef.current = parsed.joinPhase;
        const forStorage = canonicalizeReachMeetingId(
          parsed.meetingId != null && parsed.meetingId.trim() !== ''
            ? parsed.meetingId
            : String(meetingId)
        );
        if (parsed.guestId) {
          guestIdRef.current = parsed.guestId;
          AsyncStorage.setItem(reachGuestIdStorageKey(meetingId as string), parsed.guestId).catch(() => {});
        }
        joinConfirmContextRef.current = {
          meetingIdStr: (meetingId as string).trim(),
          token,
          displayName: displayUserName,
          viewerType: user ? 'host' : 'guest',
          passcodePayload: passcodePayload as Record<string, string>,
          startedWithForceJoin: forceJoinFromRoute,
        };
        setResolvedStorageMeetingId(forStorage);
        setAuthToken(token);
        const tokenParts = token.split('.');
        // permissionsGranted in diagnostics is updated when the permission effect settles;
        // at token time it is often still null (shown as Denied before — misleading).
        const joinConfigData = {
          token,
          tokenLength: token.length,
          tokenPreview: token.substring(0, 50) + '...',
          tokenParts: tokenParts.length,
          roomId: meetingId,
          roomIdLength: (meetingId as string)?.length || 0,
          userName: displayUserName,
          userNameLength: displayUserName.length,
          userId: user?.id?.toString(),
          guestId: parsed.guestId,
          joinPhase: parsed.joinPhase,
          role: parsed.userRole ?? 'auto-determined-by-backend',
          platform: Platform.OS,
          permissionsGranted: permissionsGranted === true,
          timestamp: new Date().toISOString(),
        };
        setJoinConfig(joinConfigData);
        setHmsMountKey((k) => k + 1);
      } catch (joinError: any) {
        const limitData = limitErrorFromCaught(joinError);
        if (limitData) {
          showLimitError(limitData);
          setError(limitData.message || 'Meeting limit reached');
          setIsLoading(false);
          return;
        }
        const status = joinError?.response?.status;
        const errData = joinError?.response?.data || {};
        const errMsg = errData.message || errData.error || joinError?.message || 'Unknown error';
        if (status === 409 || isActiveMeetingConflict(joinError)) {
          setError('You are already in this meeting. Leave the other session and try again.');
        } else if (
          status === 403 &&
          (errData.error_code === 'JOIN_APPROVAL_REQUIRED' ||
            errData.errorCode === 'JOIN_APPROVAL_REQUIRED' ||
            errData.join_request_id != null ||
            errData.joinRequestId != null)
        ) {
          // Invitee/guest path: wait for host approval on join-meeting (web parity).
          const q = new URLSearchParams({
            meeting_id: String(meetingId || '').trim(),
          });
          if (passcodeToken) q.set('passcode_token', String(passcodeToken));
          else if ((passcode as string)?.trim()) q.set('passcode', String(passcode).trim());
          const nameForWait = displayUserName?.trim();
          if (nameForWait) q.set('userName', nameForWait);
          const jrid = errData.join_request_id ?? errData.joinRequestId;
          if (jrid != null) q.set('join_request_id', String(jrid));
          exitMeetingScreen(() => router.replace(`/join-meeting?${q.toString()}` as any));
          return;
        } else if (status === 403) {
          setError(errMsg || 'This meeting requires host approval to join.');
        } else {
          const isRoomNotReady =
            /room not found/i.test(errMsg) ||
            /does not have an HMS room/i.test(errMsg) ||
            /NO_HMS_ROOM/i.test(String(errData?.error_code || ''));
          setError(isRoomNotReady ? 'Meeting not started yet. Contact host' : errMsg);
        }
        errorLogger.logError(joinError, {
          severity: 'error',
          screenName: 'HMSMeetingInterface',
          userAction: 'Join by ID',
          errorType: 'HMSJoinByIdFailed',
          userId: user?.id,
        });
        setIsLoading(false);
        return;
      }
      
      if (!HMSPrebuilt) {
        setIsLoading(false);
        return;
      }

      setIsLoading(false);
    } catch (error: any) {
      setError('Failed to initialize meeting interface. Please try again.');
      setIsLoading(false);
      errorLogger.logError(error, {
        severity: 'error',
        screenName: 'HMSMeetingInterface',
        userAction: 'Initialize HMS Interface',
        errorType: 'HMSInitializationFailed',
        userId: user?.id,
      });
    }
  };

  const handleHmsEnteredForPresenceConfirm = useCallback(async () => {
    if (presenceConfirmSentRef.current) return;
    presenceConfirmSentRef.current = true;
    const ctx = joinConfirmContextRef.current;
    if (!ctx.token || !ctx.meetingIdStr) {
      presenceConfirmSentRef.current = false;
      return;
    }

    // User is in the HMS room — enable heartbeat even if confirm fails/retries.
    setInHmsRoom(true);

    // Web Prebuilt parity: skip confirm when backend already marked join_phase=joined.
    if (!needsJoinConfirm(joinPhaseRef.current)) {
      if (guestIdRef.current) {
        AsyncStorage.setItem(reachGuestIdStorageKey(ctx.meetingIdStr), guestIdRef.current).catch(() => {});
      }
      setPresenceConfirmed(true);
      return;
    }

    const doConfirm = (forceJoin: boolean) =>
      apiClient.confirmVideoJoinById({
        meeting_id: ctx.meetingIdStr.trim(),
        participant_name: ctx.displayName,
        token: ctx.token,
        viewer_type: ctx.viewerType,
        ...(forceJoin ? { force_join: true } : {}),
        ...ctx.passcodePayload,
      });

    try {
      let confirmRes;
      try {
        confirmRes = await doConfirm(ctx.startedWithForceJoin);
      } catch (firstErr: unknown) {
        if (!ctx.startedWithForceJoin && isActiveMeetingConflict(firstErr)) {
          confirmRes = await doConfirm(true);
        } else {
          throw firstErr;
        }
      }
      const confirmedGuestId = parseJoinByIdResponse(confirmRes?.data).guestId;
      if (confirmedGuestId) {
        guestIdRef.current = confirmedGuestId;
        AsyncStorage.setItem(reachGuestIdStorageKey(ctx.meetingIdStr), confirmedGuestId).catch(() => {});
      }
      setPresenceConfirmed(true);
    } catch (e) {
      console.error('[HMS] POST /join-by-id/confirm failed', e);
      presenceConfirmSentRef.current = false;
    }
  }, []);

  // Name typed in the HMS preview (signed-out guests) — used by confirm and pushed via heartbeat.
  const handleLocalPeerName = useCallback((name: string) => {
    const clean = usableReachDisplayName(name);
    if (!clean || clean === joinConfirmContextRef.current.displayName) return;
    joinConfirmContextRef.current.displayName = clean;
    // Peer events mean they are in the HMS room; don't wait for confirm to push the typed name.
    if (roomIdRef.current) {
      apiClient
        .sendMeetingHeartbeat(roomIdRef.current, {
          guestId: guestIdRef.current ?? undefined,
          participantName: clean,
        })
        .catch(() => {});
    }
  }, []);

  // Fallback confirm only after a real room-entry signal set inHmsRoom. Never timer-confirm
  // from prejoin — that showed the logo tip early and Modals blocked Join Now.
  useEffect(() => {
    if (!joinConfig || !authToken || presenceConfirmed || !inHmsRoom || Platform.OS === 'web') {
      return;
    }

    const attemptFallbackConfirm = () => {
      if (presenceConfirmedRef.current || !inHmsRoomRef.current) return;
      presenceConfirmSentRef.current = false;
      void handleHmsEnteredForPresenceConfirm();
    };

    const t1 = setTimeout(attemptFallbackConfirm, 2000);
    const t2 = setTimeout(attemptFallbackConfirm, 8000);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [joinConfig, authToken, presenceConfirmed, inHmsRoom, handleHmsEnteredForPresenceConfirm]);

  // Room Kit ON_JOIN (patched emit) — the definitive "tapped Join Now and in the room" signal.
  // Unlocks logo minimize + tip immediately; peer-update bridge remains a fallback.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = DeviceEventEmitter.addListener(HMS_ROOM_JOINED_EVENT, () => {
      inHmsRoomRef.current = true;
      setInHmsRoom(true);
      if (!presenceConfirmedRef.current && !presenceConfirmSentRef.current) {
        void handleHmsEnteredForPresenceConfirm();
      }
    });
    return () => sub.remove();
  }, [handleHmsEnteredForPresenceConfirm]);

  // Preview/prejoin also emits local peer name — update display name only; do not treat as joined.
  const handleLocalPeerNameWithRoom = useCallback(
    (name: string) => {
      handleLocalPeerName(name);
    },
    [handleLocalPeerName]
  );

  // Do not set expo-av play-and-record here. HMS owns the session for preview
  // and the call. Forcing DoNotMix before preview blocks the next join (3015).

  const retryHmsConnect = useCallback(() => {
    if (hmsRetryTimerRef.current) {
      clearTimeout(hmsRetryTimerRef.current);
      hmsRetryTimerRef.current = null;
    }
    presenceConfirmSentRef.current = false;
    setJoinStuckExhausted(false);
    setError(null);
    setHmsError(null);
    setHmsMountKey((k) => k + 1);
  }, []);

  // Called when the bridge stuck timer fires. Never remount HMS — that disconnects active calls.
  const handleConnectionStuck = useCallback(async () => {
    if (presenceConfirmedRef.current) return;

    const meetingIdStr = String(meetingId ?? '').trim();

    // Solo joiners often never emit peer updates; try confirm before any destructive action.
    if (!presenceConfirmedRef.current) {
      presenceConfirmSentRef.current = false;
      await handleHmsEnteredForPresenceConfirm();
      if (presenceConfirmedRef.current) return;
    }

    setJoinStuckExhausted(true);
    errorLogger.logError(new Error('HMS join stuck: confirm fallback failed'), {
      severity: 'warning',
      screenName: 'HMSMeetingInterface',
      userAction: 'Join stuck',
      errorType: 'HMSJoinStuck',
      userId: user?.id,
      metadata: { meetingId: meetingIdStr, roomId: roomIdRef.current },
    });
  }, [meetingId, user?.id, handleHmsEnteredForPresenceConfirm]);

  /** Tear down presence + HMS route. stayOnList=true when leaving from the Reach list icon. */
  const performLeaveMeeting = useCallback(
    async (opts?: { stayOnList?: boolean }) => {
      // Block AppState/PiP from re-posting "Tap to return".
      isNavigatingAwayRef.current = true;
      if (pipFallbackTimerRef.current) {
        clearTimeout(pipFallbackTimerRef.current);
        pipFallbackTimerRef.current = null;
      }
      dismissMeetingNotification();

      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }

      // Snapshot presence before clearing it. leaveConfirmedReachSession reads the
      // ref synchronously; clearing first skips /leave and the user stays in the room.
      const leaving = leaveConfirmedReachSession();
      isMinimizingAwayRef.current = false;

      // Unmount HMSPrebuilt immediately so Room Kit's HMSContainer cleanup can
      // clearStore() (singleton redux). A hanging leave() used to block that reset
      // and the next join remounted a destroyed SDK until the app was force-quit.
      presenceConfirmedRef.current = false;
      inHmsRoomRef.current = false;
      setPresenceConfirmed(false);
      setInHmsRoom(false);
      setHmsError(null);
      setAuthToken(null);
      setJoinConfig(null);
      setHmsMountKey((k) => k + 1);
      joinInitStartedRef.current = false;
      clearLiveReachMeeting(meetingId);
      ownsLiveMeetingRef.current = false;
      AsyncStorage.removeItem(REACH_CURRENT_MEETING_KEY).catch(() => {});
      void releaseHmsCallAudioMode();

      // Navigate first; finish GrabDocs /leave in the background.
      if (opts?.stayOnList) {
        const routeKey = route.key;
        exitMeetingScreen(() =>
          navigation.dispatch((state: any) => {
            const routes = (state.routes as any[]).filter((r) => r.key !== routeKey);
            // Do not spread full state — stale native-stack history causes null-route crashes.
            return CommonActions.reset({
              index: Math.max(0, routes.length - 1),
              routes: routes.map((r) => ({
                name: r.name,
                key: r.key,
                params: r.params,
                ...(r.state != null ? { state: r.state } : {}),
              })),
            });
          }),
        );
      } else {
        exitMeetingScreen(() => {
          const exit = String(meetingExitPath || DEFAULT_MEETING_EXIT_PATH);
          const wantsList =
            exit === DEFAULT_MEETING_EXIT_PATH ||
            exit.startsWith('/quick-reach/meeting-call');
          const state = navigation.getState();
          const index = state?.index ?? -1;
          const current = index >= 0 ? state?.routes[index] : undefined;
          const below = index > 0 ? state?.routes[index - 1] : undefined;
          // replace() after logo → list → Home → return can swap this screen for an
          // empty history entry (black). The list is already underneath — pop to it.
          if (
            wantsList &&
            current?.key === route.key &&
            below?.name === 'meeting-call'
          ) {
            navigation.dispatch(StackActions.pop());
            return;
          }
          router.replace(exit as any);
        });
      }

      try {
        await leaving;
      } catch (error: any) {
        console.error('⚠️ [LEAVE] Error calling leave endpoint:', error);
      }
    },
    [
      meetingId,
      leaveConfirmedReachSession,
      dismissMeetingNotification,
      exitMeetingScreen,
      route.key,
      navigation,
      router,
      meetingExitPath,
    ],
  );

  const handleLeaveMeeting = async () => {
    Alert.alert(
      'Leave Meeting',
      'Are you sure you want to leave the meeting?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () => {
            void performLeaveMeeting();
          },
        },
      ]
    );
  };

  // Leave from Reach list (videocam → leave icon) without returning to the call UI first.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      LEAVE_REACH_MEETING_EVENT,
      (payload: { meetingId?: string } | undefined) => {
        const target = canonicalizeReachMeetingId(payload?.meetingId);
        const mine =
          canonicalizeReachMeetingId(resolvedStorageMeetingId || meetingId) ||
          canonicalizeReachMeetingId(meetingId);
        if (!target || !mine || target !== mine) return;
        // Also tear down a stuck prejoin (presence never confirmed) so End returns to the list.
        void performLeaveMeeting({ stayOnList: true });
      },
    );
    return () => sub.remove();
  }, [meetingId, resolvedStorageMeetingId, performLeaveMeeting]);

  // Check if meetingId is missing
  if (!meetingId) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Missing Meeting ID</Text>
          <Text style={styles.errorMessage}>
            No meeting ID was provided. Please try joining the meeting again from the meeting list.
          </Text>
          <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
            <Text style={styles.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Loading only while fetching token / preparing join (before HMS prejoin UI is shown)
  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <PrejoinBackButton onPress={goBackToApp} topInset={insets.top} />
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Initializing GrabDocs Meeting...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error && !authToken) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>GrabDocs Meeting</Text>
          <Text style={styles.errorMessage}>{error}</Text>
          <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
            <Text style={styles.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (HMSPrebuilt && authToken && meetingId && orientationReadyForHms) {
    const roomCode = meetingId as string;
    const token = authToken;
    const prefillUserName = getHmsPrefillUserName(userName, user);
    
    if (!roomCode || !token) {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>Configuration Error</Text>
            <Text style={styles.errorMessage}>
              Missing required information: {!roomCode ? 'roomCode' : ''} {!token ? 'token' : ''}
            </Text>
            <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
              <Text style={styles.backButtonText}>Go Back</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }

    // Token may arrive before the user answers the permission prompts — wait (do not mount HMS yet).
    if (Platform.OS !== 'web' && permissionsGranted !== true) {
      if (permissionsGranted === false) {
        return (
          <SafeAreaView style={styles.container}>
            <View style={styles.errorContainer}>
              <Text style={styles.errorTitle}>Permissions Required</Text>
              <Text style={styles.errorMessage}>
                Camera and microphone permissions are required to join the meeting.
              </Text>
              <Text style={[styles.errorMessage, { marginTop: 16, fontSize: 14, color: '#999' }]}>
                Please enable camera and microphone permissions in your device settings and try again.
              </Text>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={async () => {
                  await checkPermissions();
                }}
              >
                <Text style={styles.retryButtonText}>Request Permissions</Text>
              </TouchableOpacity>
              {Platform.OS === 'ios' && (
                <TouchableOpacity
                  style={[styles.retryButton, { marginTop: 12, backgroundColor: '#007AFF' }]}
                  onPress={async () => {
                    await Linking.openSettings();
                  }}
                >
                  <Text style={styles.retryButtonText}>Open Settings</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
                <Text style={styles.backButtonText}>Go Back</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        );
      }
      return (
        <SafeAreaView style={styles.container}>
          <PrejoinBackButton onPress={goBackToApp} topInset={insets.top} />
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>Waiting for camera permission...</Text>
          </View>
        </SafeAreaView>
      );
    }
    
    // Validate all required props
    const validRoomCode = roomCode && typeof roomCode === 'string' && roomCode.trim().length > 0;
    const validToken = token && typeof token === 'string' && token.trim().length > 0;
    // Empty for signed-out users: HMS preview then shows an editable name field they must fill in.
    const validUserName = prefillUserName.trim().length > 0;
    
    // Verify all required props
    if (!validRoomCode) {
      setError('Invalid room code. Please try joining the meeting again.');
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>Configuration Error</Text>
            <Text style={styles.errorMessage}>Invalid room code. Please try joining the meeting again.</Text>
            <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
              <Text style={styles.backButtonText}>Go Back</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }
    
    if (!validToken) {
      setError('Authentication token is missing or invalid.');
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>Token Error</Text>
            <Text style={styles.errorMessage}>Authentication token is missing or invalid.</Text>
            <Text style={[styles.errorMessage, { marginTop: 16, fontSize: 14, color: '#999' }]}>
              This usually means:{'\n'}
              • Token endpoint returned empty response{'\n'}
              • Network error prevented token fetch{'\n'}
              • Backend token generation failed{'\n'}
              • Token format is invalid
            </Text>
            {joinConfig && (
              <View style={[styles.errorMessage, { marginTop: 16, padding: 12, backgroundColor: '#f5f5f5', borderRadius: 8 }]}>
                <Text style={[styles.errorMessage, { fontWeight: 'bold', marginBottom: 8 }]}>Debug Info:</Text>
                <Text style={[styles.errorMessage, { fontSize: 12, fontFamily: 'monospace' }]}>
                  Token Length: {joinConfig.tokenLength || 0}{'\n'}
                  Room ID: {joinConfig.roomId || 'N/A'}{'\n'}
                  User Name: {joinConfig.userName || 'N/A'}
                </Text>
              </View>
            )}
            <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
              <Text style={styles.backButtonText}>Go Back</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }

    if (Platform.OS !== 'web') applyGrabdocsHmsRoomKitJoinDefaults();

    try {
      // React Native HMSPrebuilt props format:
      // - token - required for token-based join (mutually exclusive with roomCode)
      // - roomCode - only used for room-link-based join (not used here; backend issues a token)
      // - options: { userName, userId, ios?: { appGroup, preferredExtension } } - optional
      // - onLeave - callback when leaving
      // iOS screenshare: pass appGroup + preferredExtension so prebuilt can start screen share (see docs/MOBILE_SCREENSHARE_WHITEBOARD.md)
      const hmsProps = {
        token: token.trim(),
        // roomCode is intentionally omitted: token and roomCode are mutually exclusive join
        // methods. Passing both causes HMS to attempt a room-code lookup with the GrabDocs
        // numeric meeting ID (not a valid 100ms room code), which silently fails and leaves
        // the "Join" button spinning. The backend already supplies an auth token via
        // /api/v1/video/room/join-by-id, so token-only join is the correct path.
        options: {
          ...(validUserName && { userName: prefillUserName.trim() }),
          // Authenticated users only — guest identity is embedded in the HMS token; do not override.
          ...(user?.id && !guestIdRef.current && { userId: user.id.toString() }),
          ...(Platform.OS === 'ios' && HMS_IOS_SCREENSHARE && {
            ios: {
              appGroup: HMS_IOS_SCREENSHARE.appGroup,
              preferredExtension: HMS_IOS_SCREENSHARE.preferredExtension,
            },
          }),
        },
        onLeave: handleLeaveMeeting,
        style: styles.prebuiltContainer
      };

      return (
        <>
          <MeetingPresenceConfirmBridge
            enabled={!!joinConfig && !!authToken && !hmsError}
            joinCompleted={presenceConfirmed}
            onEnteredRoom={handleHmsEnteredForPresenceConfirm}
            onLocalPeerName={handleLocalPeerNameWithRoom}
            onConnectionStuck={handleConnectionStuck}
          />
          <MeetingHmsReconnectBridge
            enabled={!!joinConfig && !!presenceConfirmed && !hmsError}
            onReconnecting={handleHmsReconnecting}
            onReconnected={handleHmsReconnected}
          />
          {HMSPrebuilt && joinSoundReady && (
            <MeetingJoinSound enabled={!!authToken && !!meetingId && !hmsError} onPeerJoined={handlePeerJoined} />
          )}

          {/* Join stuck overlay — Modal keeps HMS mounted (unmounting causes peer.leave client request). */}
          {joinStuckExhausted && !!joinConfig && !hmsError && !presenceConfirmed ? (
          <Modal
            visible
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={() => setJoinStuckExhausted(false)}
          >
            <View style={styles.networkOverlay} pointerEvents="box-none">
              <View style={styles.networkBanner}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.networkBannerTitle}>Having trouble connecting</Text>
                  <Text style={styles.networkBannerSubtitle}>
                    You may still be in the call. Try confirming attendance or rejoin.
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.networkLeaveButton}
                  onPress={async () => {
                    setJoinStuckExhausted(false);
                    presenceConfirmSentRef.current = false;
                    await handleHmsEnteredForPresenceConfirm();
                  }}
                >
                  <Text style={styles.networkLeaveButtonText}>Retry</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.networkLeaveButton, { backgroundColor: '#666' }]}
                  onPress={() => {
                    setJoinStuckExhausted(false);
                    retryHmsConnect();
                  }}
                >
                  <Text style={styles.networkLeaveButtonText}>Rejoin</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
          ) : null}

          {/* In-meeting event banners (recording started, peer joined) — must be dismissed by tapping OK */}
          {bannerQueue.length > 0 && !!joinConfig && !hmsError && !callMinimized ? (
          <Modal
            visible
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={dismissBanner}
          >
            <View style={styles.networkOverlay} pointerEvents="box-none">
              {bannerQueue.length > 0 && (
                <View style={styles.networkBanner}>
                  {bannerQueue[0].type !== 'recording' ? (
                    <View style={[styles.networkDot, { backgroundColor: '#007AFF' }]} />
                  ) : null}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.networkBannerTitle} numberOfLines={3}>
                      {bannerQueue[0].message}
                    </Text>
                    {bannerQueue[0].subtitle ? (
                      <Text style={styles.networkBannerSubtitle} numberOfLines={2}>
                        {bannerQueue[0].subtitle}
                      </Text>
                    ) : null}
                  </View>
                  <TouchableOpacity
                    style={[
                      styles.networkLeaveButton,
                      bannerQueue[0].type === 'recording' && styles.networkGotItButton,
                    ]}
                    onPress={dismissBanner}
                  >
                    <Text style={styles.networkLeaveButtonText}>
                      {bannerQueue[0].type === 'recording' ? 'Got it' : 'OK'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </Modal>
          ) : null}

          {/* Prejoin: HMS Room Kit owns the back chevron — no GrabDocs overlay (it blocked Join Now). */}
          {/* In-call logo/tip chrome is an absolute sibling over HMSPrebuilt — NOT a Modal.
              A transparent Modal window was eating all touches after join. */}

          {showJoinRequestsModal ? (
          <JoinRequestsManageModal
            visible={showJoinRequestsModal}
            videoCallId={roomId}
            onClose={() => setShowJoinRequestsModal(false)}
            pollWhileVisible
            onCountChange={(count) => {
              setPendingJoinRequestCount(count);
              if (count === 0) setPendingJoinRequests([]);
            }}
          />
          ) : null}

          {/* HMS reconnect overlay — only when media session is reconnecting (not backend /health). */}
          {(isNetworkDown || showReconnected) && !!joinConfig && !!presenceConfirmed && !hmsError && !callMinimized ? (
          <Modal
            visible
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={() => {}}
          >
            <View style={styles.networkOverlay} pointerEvents="box-none">
              <View style={[styles.networkBanner, showReconnected && !isNetworkDown && styles.networkBannerOnline]}>
                {isNetworkDown ? (
                  <>
                    <View style={styles.networkDot} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.networkBannerTitle}>Connection lost</Text>
                      <Text style={styles.networkBannerSubtitle}>Trying to reconnect…</Text>
                    </View>
                  </>
                ) : (
                  <>
                    <View style={[styles.networkDot, { backgroundColor: '#34C759' }]} />
                    <Text style={styles.networkBannerTitle}>Reconnected</Text>
                  </>
                )}
              </View>
            </View>
          </Modal>
          ) : null}

          <SafeAreaView style={styles.container} edges={['top']}>
            <View style={styles.meetingContentWrapper}>
          {hmsError ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorTitle}>HMS Error</Text>
              <Text style={styles.errorMessage}>
                {hmsError || 'HMS component failed to initialize. This may be a native module issue.'}
              </Text>

              {/* Diagnostic Information */}
              {joinConfig && (
                <View style={[styles.errorMessage, { marginTop: 16, padding: 12, backgroundColor: '#f5f5f5', borderRadius: 8 }]}>
                  <Text style={[styles.errorMessage, { fontWeight: 'bold', marginBottom: 8 }]}>Diagnostic Information:</Text>
                  <Text style={[styles.errorMessage, { fontSize: 12, fontFamily: 'monospace' }]}>
                    Token Length: {joinConfig.tokenLength}{'\n'}
                    Token Parts: {joinConfig.tokenParts}{'\n'}
                    Room ID: {joinConfig.roomId}{'\n'}
                    Room ID Length: {joinConfig.roomIdLength}{'\n'}
                    User Name: {joinConfig.userName}{'\n'}
                    Platform: {joinConfig.platform}{'\n'}
                    Permissions: {permissionsGranted === true ? 'Granted' : permissionsGranted === false ? 'Denied' : 'Pending'}{'\n'}
                    HMSPrebuilt: {HMSPrebuilt ? 'Available' : 'Not Available'}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => {
                  setHmsError(null);
                  joinInitStartedRef.current = false;
                  setHmsMountKey((k) => k + 1);
                  void initializePrebuiltInterface();
                }}
              >
                <Text style={styles.retryButtonText}>Try Again</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
                <Text style={styles.backButtonText}>Go Back</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <HMSErrorBoundary
                onError={(error) => {
                  console.error('📱 [HMS] Prebuilt Error Boundary:', error);
                  const rawMessage = error?.message || '';
                  // Intercept 100ms "room not found" / 400 INIT - show friendly message
                  const isRoomNotFound =
                    /room not found/i.test(rawMessage) ||
                    /400\s*\[?INIT\]?/i.test(rawMessage) ||
                    /room.*not.*exist/i.test(rawMessage);
                  const audioFriendly = getFriendlyHmsErrorMessage(rawMessage);
                  const friendlyMessage = isRoomNotFound
                    ? 'Meeting not started yet. Contact host'
                    : audioFriendly !== rawMessage
                      ? audioFriendly
                      : rawMessage || 'Failed to join meeting. Please try again.';
                  setHmsError(friendlyMessage);
                  // Do not keep a crashed screen as the "live" meeting — Reach would keep
                  // returning here instead of allowing a fresh join.
                  clearLiveReachMeeting(meetingId);
                  ownsLiveMeetingRef.current = false;
                  errorLogger.logError(error, {
                    severity: 'error',
                    screenName: 'HMSMeetingInterface',
                    userAction: 'HMS Error Boundary',
                    errorType: 'HMSPrebuiltErrorBoundary',
                    userId: user?.id,
                  });
                }}
              >
                {!permissionsGranted && permissionsGranted !== null ? (
                  <View style={styles.errorContainer}>
                    <Text style={styles.errorTitle}>Permissions Required</Text>
                    <Text style={styles.errorMessage}>
                      Camera and microphone permissions are required to join the meeting.
                    </Text>
                    <Text style={[styles.errorMessage, { marginTop: 16, fontSize: 14, color: '#999' }]}>
                      Please enable camera and microphone permissions in your device settings and try again.
                    </Text>
                    <TouchableOpacity 
                      style={styles.retryButton} 
                      onPress={async () => {
                        // Request permissions again
                        await checkPermissions();
                        // Small delay to ensure state updates
                        setTimeout(() => {
                          if (permissionsGranted) {
                            initializePrebuiltInterface();
                          }
                        }, 100);
                      }}
                    >
                      <Text style={styles.retryButtonText}>Request Permissions</Text>
                    </TouchableOpacity>
                    {Platform.OS === 'ios' && (
                      <TouchableOpacity 
                        style={[styles.retryButton, { marginTop: 12, backgroundColor: '#007AFF' }]} 
                        onPress={async () => {
                          await Linking.openSettings();
                        }}
                      >
                        <Text style={styles.retryButtonText}>Open Settings</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
                      <Text style={styles.backButtonText}>Go Back</Text>
                    </TouchableOpacity>
                  </View>
                ) : permissionsGranted === null ? (
                  <View style={styles.loadingContainer}>
                    <PrejoinBackButton onPress={goBackToApp} topInset={insets.top} />
                    <Text style={styles.loadingText}>Checking permissions...</Text>
                  </View>
                ) : (
                  <View style={[styles.prebuiltWrapper, { paddingBottom: bottomInset }]}>
                    {/* PiP: Square, smaller window on both platforms. Video preview enabled by 100ms (useActiveSpeaker: true). iOS: UIBackgroundModes ["voip"] + plugins/ios-pip. Android: plugins/android-pip + GrabDocsPipModule (1:1). See docs/PIP_MOBILE_SETUP.md if PiP shows black. */}
                    <HMSPrebuilt 
                      key={`hms-${hmsMountKey}`}
                      token={hmsProps.token}
                      options={hmsProps.options}
                      autoEnterPipMode={Platform.OS !== 'web'}
                      pipConfig={Platform.OS !== 'web' ? { aspectRatio: [1, 1] } : undefined}
                      onLeave={(reason?: string) => {
                        setIsLoading(false);

                        // List Leave already ran performLeaveMeeting — do not double-leave.
                        if (isNavigatingAwayRef.current) {
                          return;
                        }

                        // Room Kit sets meeting state to EXITED before this callback. EXITED
                        // renders an empty black view. Returning here — the 8s skip armed by
                        // resume-after-Home, or isMinimizingAwayRef stuck because focus never
                        // updates after list → Home → return — leaves that black view up.
                        // A real exit must always unmount and navigate.
                        const explicitExit =
                          reason === 'leave' ||
                          reason === 'pip' ||
                          reason === 'room_ended' ||
                          reason === 'peer_kicked' ||
                          reason === 'network_issues';
                        if (
                          !explicitExit &&
                          (shouldSkipHmsLeave() || isMinimizingAwayRef.current)
                        ) {
                          return;
                        }

                        // Prejoin cancel (HMS back) — never joined; no leave API.
                        if (!presenceConfirmedRef.current) {
                          exitMeetingScreen(() => router.replace(meetingExitPath as any));
                          return;
                        }

                        // Same path as list Leave: /leave then unmount. Native HMS leave
                        // was already kicked off in the background by Room Kit.
                        void performLeaveMeeting();
                      }}
                      style={hmsProps.style}
                      // Note: React Native HMSPrebuilt does NOT support onJoin callback
                      // The component will automatically join when mounted with valid token/roomCode
                      // We use a timeout to detect if join fails silently
                    />
                    {/* Absolute overlay (not Modal): logo minimize + tip. box-none so HMS stays tappable.
                        Keep mounted for the whole in-call session — gating on isScreenFocused hid it
                        after list→Home→return when focus lagged. Native stack covers this view when
                        another route is on top; logo onPress uses fromLogo so a stale focus flag
                        cannot swallow the tap. */}
                    {inCallChrome ? (
                      <View style={styles.inCallFabOverlay} pointerEvents="box-none">
                        <TouchableOpacity
                          style={styles.logoMinimizeHit}
                          onPress={minimizeToMeetingList}
                          activeOpacity={1}
                          accessibilityLabel="Minimize meeting"
                          accessibilityHint="Returns to the meeting list without leaving the call"
                        />
                        {showMinimizeTip ? (
                          <View
                            style={[
                              styles.minimizeTipBanner,
                              { top: ROOM_KIT_HEADER_HEIGHT + 4 },
                            ]}
                            pointerEvents="auto"
                          >
                            <Text style={styles.minimizeTipText}>
                              Tap the GrabDocs logo to return to meeting list. The call stays connected.
                            </Text>
                            <TouchableOpacity
                              onPress={dismissMinimizeTip}
                              hitSlop={10}
                              accessibilityLabel="Dismiss tip"
                            >
                              <Ionicons name="close" size={18} color="#fff" />
                            </TouchableOpacity>
                          </View>
                        ) : null}
                        {canApproveJoinRequests && bannerJoinRequest ? (
                          <View
                            style={[
                              styles.minimizeTipBanner,
                              styles.joinApprovalBanner,
                              {
                                top:
                                  ROOM_KIT_HEADER_HEIGHT +
                                  4 +
                                  (showMinimizeTip ? 64 : 0),
                              },
                            ]}
                            pointerEvents="auto"
                          >
                            <Text style={styles.minimizeTipText} numberOfLines={2}>
                              {joinRequestDisplayName(bannerJoinRequest)} wants to join
                              {bannerJoinMoreCount > 0
                                ? `  ·  +${bannerJoinMoreCount} more`
                                : ''}
                            </Text>
                            <TouchableOpacity
                              style={styles.joinApproveButton}
                              onPress={approveBannerJoinRequest}
                              disabled={approvingJoinRequestId != null}
                              activeOpacity={0.85}
                              accessibilityLabel="Approve join request"
                            >
                              <Text style={styles.joinApproveButtonText}>
                                {approvingJoinRequestId === bannerJoinRequest.id
                                  ? '…'
                                  : 'Approve'}
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              onPress={dismissJoinApprovalBanner}
                              hitSlop={10}
                              accessibilityLabel="Dismiss join request banner"
                            >
                              <Ionicons name="close" size={18} color="#fff" />
                            </TouchableOpacity>
                          </View>
                        ) : null}
                        {canManageJoinRequests &&
                        pendingJoinRequestCount > 0 &&
                        !showJoinRequestsModal ? (
                          <View
                            style={[
                              styles.inCallFabRow,
                              { paddingTop: ROOM_KIT_HEADER_HEIGHT + 4 },
                            ]}
                            pointerEvents="box-none"
                          >
                            <TouchableOpacity
                              style={styles.joinApprovalFab}
                              onPress={() => setShowJoinRequestsModal(true)}
                              activeOpacity={0.85}
                              accessibilityLabel="Join request approvals"
                            >
                              <Ionicons name="people" size={22} color="#fff" />
                              <View style={styles.joinApprovalBadge}>
                                <Text style={styles.joinApprovalBadgeText}>
                                  {pendingJoinRequestCount > 9
                                    ? '9+'
                                    : String(pendingJoinRequestCount)}
                                </Text>
                              </View>
                            </TouchableOpacity>
                          </View>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                )}
              </HMSErrorBoundary>
            </>
          )}
            </View>
        </SafeAreaView>
        </>
      );
    } catch (renderError: any) {
      console.error('📱 Error rendering HMSPrebuilt:', renderError);
      setHmsError(renderError?.message || 'Failed to initialize meeting interface.');
      errorLogger.logError(renderError, {
        severity: 'error',
        screenName: 'HMSMeetingInterface',
        userAction: 'Render HMSPrebuilt',
        errorType: 'HMSPrebuiltRenderError',
        userId: user?.id,
      });
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>Initialization Error</Text>
            <Text style={styles.errorMessage}>{renderError?.message || 'Failed to initialize meeting interface.'}</Text>
            <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
              <Text style={styles.backButtonText}>Go Back</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }
  }

  if (HMSPrebuilt && authToken && meetingId && !orientationReadyForHms && Platform.OS !== 'web') {
    return (
      <SafeAreaView style={styles.container}>
        <PrejoinBackButton onPress={goBackToApp} topInset={insets.top} />
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Initializing GrabDocs Meeting...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // HMS native module unavailable (Expo Go / failed import) — not a production join failure.
  if (!HMSPrebuilt) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.developmentContainer}>
          <Text style={styles.developmentTitle}>GrabDocs Meeting</Text>
          <Text style={styles.developmentSubtitle}>Meeting Unavailable</Text>

          <View style={styles.meetingInfo}>
            <Text style={styles.meetingInfoLabel}>Meeting ID:</Text>
            <Text style={styles.meetingInfoValue}>{meetingId}</Text>

            <Text style={styles.meetingInfoLabel}>Title:</Text>
            <Text style={styles.meetingInfoValue}>{title || 'Meeting'}</Text>
          </View>

          <View style={styles.developmentMessage}>
            <Text style={styles.developmentText}>
              The meeting interface could not load on this build. Please update the app or reinstall,
              then try joining again.
            </Text>
            <Text style={[styles.developmentText, { marginTop: 12 }]}>
              Meeting ID: {meetingId}
            </Text>
          </View>

          <TouchableOpacity style={styles.leaveButton} onPress={handleLeaveMeeting}>
            <Text style={styles.leaveButtonText}>Leave Meeting</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Token missing after load finished — recover by re-joining instead of a dead-end screen.
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle}>GrabDocs Meeting</Text>
        <Text style={styles.errorMessage}>
          Could not connect to this meeting. Please try joining again.
        </Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => {
            joinInitStartedRef.current = false;
            setIsLoading(true);
            setError(null);
            void initializePrebuiltInterface();
          }}
        >
          <Text style={styles.retryButtonText}>Try Again</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  containerMinimized: {
    backgroundColor: '#0d0d0d',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  loadingText: {
    color: '#fff',
    fontSize: 18,
    marginTop: 16,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    backgroundColor: '#000',
  },
  errorTitle: {
    fontSize: 24,
    fontWeight: '600',
    color: '#fff',
    marginTop: 16,
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 16,
    color: '#ccc',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 24,
  },
  retryButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  backButton: {
    backgroundColor: 'transparent',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#666',
  },
  backButtonText: {
    color: '#fff',
    fontSize: 16,
  },
  meetingContentWrapper: {
    flex: 1,
  },
  prebuiltWrapper: {
    flex: 1,
    position: 'relative',
  },
  prejoinBackContainer: {
    position: 'absolute',
    left: 12,
    zIndex: 2000,
    elevation: 2000,
  },
  prejoinBackButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  prebuiltContainer: {
    flex: 1,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  loadingBox: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    padding: 24,
    borderRadius: 12,
    alignItems: 'center',
  },
  loadingSubtext: {
    color: '#999',
    fontSize: 14,
    marginTop: 8,
  },
  developmentContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    backgroundColor: '#000',
  },
  developmentTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 8,
  },
  developmentSubtitle: {
    fontSize: 18,
    color: '#007AFF',
    marginBottom: 40,
  },
  meetingInfo: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    padding: 20,
    borderRadius: 12,
    marginBottom: 40,
    width: '100%',
  },
  meetingInfoLabel: {
    fontSize: 14,
    color: '#ccc',
    marginTop: 12,
    marginBottom: 4,
  },
  meetingInfoValue: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '600',
  },
  developmentMessage: {
    marginBottom: 40,
  },
  developmentText: {
    fontSize: 16,
    color: '#ccc',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 12,
  },
  leaveButton: {
    backgroundColor: '#FF3B30',
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 8,
  },
  leaveButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  // Absolute over HMS — never a full-screen Modal (Modal ate all call controls).
  inCallFabOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    elevation: 20,
  },
  // Covers Room Kit's header logo box. The overlay already sits below the notch (our
  // SafeAreaView), so offsets are relative to the header — never add insets.top here.
  logoMinimizeHit: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 160,
    height: ROOM_KIT_HEADER_HEIGHT,
    zIndex: 22,
    elevation: 22,
  },
  minimizeTipBanner: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(20, 20, 20, 0.92)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    zIndex: 23,
    elevation: 23,
  },
  minimizeTipText: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '500',
  },
  joinApprovalBanner: {
    zIndex: 4,
  },
  joinApproveButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#22C55E',
  },
  joinApproveButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  inCallFabRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingRight: 16,
    gap: 10,
  },
  joinApprovalFab: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#7C3AED',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  joinApprovalBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FF3B30',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  joinApprovalBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  networkOverlay: {
    flex: 1,
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
  },
  networkBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.95)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginHorizontal: 16,
    gap: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 12,
    minWidth: 240,
  },
  networkBannerOnline: {
    backgroundColor: 'rgba(20, 50, 20, 0.95)',
  },
  networkDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#FF3B30',
  },
  networkBannerTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  networkBannerSubtitle: {
    color: '#aaa',
    fontSize: 12,
    marginTop: 2,
  },
  networkLeaveButton: {
    backgroundColor: '#FF3B30',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  networkGotItButton: {
    backgroundColor: '#3A3A3C',
  },
  networkLeaveButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});