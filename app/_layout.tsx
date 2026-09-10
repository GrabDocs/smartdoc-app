// Import polyfills for mobile compatibility
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, findNodeHandle, Linking, LogBox, Pressable, StyleSheet } from 'react-native';
import 'react-native-url-polyfill/auto';
import { errorLogger } from '../services/errorLogger';

// ErrorUtils might be a global in some React Native versions, or imported
// Try to get it from global if not available as import
const ErrorUtils = (global as any).ErrorUtils || require('react-native').ErrorUtils;

// Only suppress specific development warnings that are known and non-critical
LogBox.ignoreLogs([
  'expo-notifications: Android Push notifications',
  'expo-notifications functionality is not fully supported',
  'Linking requires a build-time setting',
  'react-native-hms module was not found', // HMS is native-only, expected in Expo Go
  '@100mslive/react-native-hms', // HMS module errors
]);

import { SplashScreen, Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import GlobalProgressBar from '../components/GlobalProgressBar';
import NetworkIndicator from '../components/NetworkIndicator';
import { AppLockProvider, useAppLock } from '../contexts/AppLockContext';
import { DisplayScaleProvider } from '../contexts/DisplayScaleContext';
import { Enhanced2FAAuthProvider } from '../contexts/Enhanced2FAAuthContext';
import { UserPreferencesProvider } from '../contexts/UserPreferencesContext';
import ChatGDBottomSheetHost from '../components/chatgd/ChatGDBottomSheet';
import ActionMenuModal, { type ActionMenuItem } from '../components/ActionMenuModal';
import { ChatGDSheetProvider } from '../contexts/ChatGDSheetContext';
import { HeaderVisibilityProvider } from '../contexts/HeaderVisibilityContext';
import { ThemeProvider, useTheme } from '../contexts/ThemeContext';
import { apiClient } from '../services/api';
import { useProgressStore } from '../services/progressService';
import { checkMinVersion, checkOtaAndFetch, checkSoftStoreUpdate, fetchAppConfig, reportUpdateTelemetry } from '../services/updateService';
import { refreshDefaultHomePathFromWebUser } from '../utils/defaultHomePath';
import { runSignatureGCOnLaunch } from '../services/signatureFileGC';
import { evictStaleSessions } from '../services/signatureSessionCache';
import AppLockScreen from './components/AppLockScreen';
import OtaUpdateBanner from './components/OtaUpdateBanner';
import SoftStoreUpdateBanner from './components/SoftStoreUpdateBanner';
import PersistentBottomNavigation from './components/PersistentBottomNavigation';
import UpdateRequiredScreen from './components/UpdateRequiredScreen';
import { AuthProvider, useAuth } from './context/auth';
import { LimitErrorProvider } from '../contexts/LimitErrorContext';
import { getNotificationScreen, parseNotificationPath, initializePushNotifications, pushNotificationService, isJoinRequestNotificationAction, executeJoinRequestNotificationAction, isEmailReplyNotificationAction, getEmailReplyComposeScreen, isReachMeetingStartedNotificationType, getReachMeetingJoinPath } from './services/pushNotifications';
import ReachMeetingStartedBanner from './components/ReachMeetingStartedBanner';
import { canonicalizeReachMeetingId, REACH_CURRENT_MEETING_KEY } from '../constants/reachMeeting';

// Prevent the splash screen from auto-hiding (ignore if native splash not ready yet)
SplashScreen.preventAutoHideAsync().catch((err) => {
  if (!err?.message?.includes('No native splash screen registered')) {
    console.warn('SplashScreen.preventAutoHideAsync failed:', err);
  }
});

function RootLayoutNav() {
  const { visible, minimized, progressData, minimizeProgress, expandProgress, closeProgress } = useProgressStore();
  const { isDark } = useTheme();
  const { user, loading: authLoading } = useAuth();
  const { isLocked, appLockEnabled } = useAppLock();
  const router = useRouter();
  const segments = useSegments();
  const pushListenerRef = useRef<{ remove: () => void } | null>(null);
  const receivedNotifListenerRef = useRef<{ remove: () => void } | null>(null);
  const lastNotificationResponse = Notifications.useLastNotificationResponse();
  // User id present when auth bootstrap finished — only auto-open notification targets on cold
  // start with an existing session, never right after sign-in/sign-up in the same app session.
  const coldStartAuthenticatedUserIdRef = useRef<string | null | undefined>(undefined);
  const [appLockReminderVisible, setAppLockReminderVisible] = useState(false);
  const [meetingStartedBanner, setMeetingStartedBanner] = useState<{
    meetingId: string;
    message: string;
    notificationId?: number;
  } | null>(null);
  const dismissedMeetingIdsRef = useRef<Set<string>>(new Set());
  // Latest authenticated user, readable from notification listener callbacks without re-registering.
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Hide top bar (NetworkIndicator) on meeting screen to avoid black banner and full-screen meeting UX
  const isMeetingScreen = segments.some((s) => String(s).includes('hms-meeting-interface'));
  const isJoinMeetingScreen = segments.some((s) => String(s) === 'join-meeting');

  const clearMeetingStartedBannerIfJoined = useCallback(async (candidateMeetingId?: string) => {
    try {
      const current = await AsyncStorage.getItem(REACH_CURRENT_MEETING_KEY);
      const currentCanon = current ? canonicalizeReachMeetingId(current) : '';
      if (!currentCanon) return;
      setMeetingStartedBanner((prev) => {
        if (!prev) return prev;
        const prevCanon = canonicalizeReachMeetingId(prev.meetingId);
        if (candidateMeetingId && canonicalizeReachMeetingId(candidateMeetingId) !== prevCanon) {
          return prev;
        }
        if (prevCanon === currentCanon) return null;
        return prev;
      });
    } catch {
      // ignore
    }
  }, []);

  const maybeShowMeetingStartedBanner = useCallback(
    async (payload: {
      meetingId: string;
      message: string;
      notificationId?: number;
    }) => {
      const meetingId = String(payload.meetingId || '').trim();
      if (!meetingId) return;
      const canon = canonicalizeReachMeetingId(meetingId);
      if (!canon || dismissedMeetingIdsRef.current.has(canon)) return;

      try {
        const current = await AsyncStorage.getItem(REACH_CURRENT_MEETING_KEY);
        if (current && canonicalizeReachMeetingId(current) === canon) return;
      } catch {
        // ignore storage errors
      }

      setMeetingStartedBanner({
        meetingId: canon,
        message: payload.message || 'A Reach meeting started. Join to participate.',
        notificationId: payload.notificationId,
      });
    },
    []
  );

  // Foreground push: show OTA-style banner when a workspace/chat meeting starts.
  useEffect(() => {
    if (!user) {
      setMeetingStartedBanner(null);
      return;
    }
    let mounted = true;
    pushNotificationService
      .addNotificationReceivedListener((notification) => {
        if (!mounted || !userRef.current) return;
        const content = notification.request.content;
        const data = (content.data || {}) as Record<string, unknown>;
        const type = data.type ?? data.action_type;
        if (!isReachMeetingStartedNotificationType(type)) return;
        const joinPath = getReachMeetingJoinPath(data as Record<string, any>);
        const rawMid = data.meeting_id ?? data.meetingId;
        let meetingId = rawMid != null ? String(rawMid).trim() : '';
        if (!meetingId && joinPath) {
          const m = joinPath.match(/meeting_id=([^&]+)/);
          if (m?.[1]) {
            try {
              meetingId = decodeURIComponent(m[1]);
            } catch {
              meetingId = m[1];
            }
          }
        }
        if (!meetingId) return;
        const message =
          (typeof content.body === 'string' && content.body.trim()) ||
          (typeof content.title === 'string' && content.title.trim()) ||
          'A Reach meeting started. Join to participate.';
        void maybeShowMeetingStartedBanner({ meetingId, message });
      })
      .then((subscription) => {
        receivedNotifListenerRef.current = subscription;
      });
    return () => {
      mounted = false;
      receivedNotifListenerRef.current?.remove();
      receivedNotifListenerRef.current = null;
    };
  }, [user, maybeShowMeetingStartedBanner]);

  // When app returns to foreground, surface any unread meeting-started inbox items.
  useEffect(() => {
    if (!user) return;

    const checkUnreadMeetingStarted = async () => {
      try {
        const res = await apiClient.getNotifications();
        if (!res?.success || !res?.data) return;
        const list = (res.data.notifications ?? []) as Array<{
          id: number;
          title?: string;
          message?: string;
          type?: string;
          read?: boolean;
          metadata?: Record<string, any>;
        }>;
        const hit = list.find((n) => {
          if (n.read) return false;
          if (!isReachMeetingStartedNotificationType(n.type) &&
              !isReachMeetingStartedNotificationType(n.metadata?.action_type)) {
            return false;
          }
          const mid = n.metadata?.meeting_id ?? n.metadata?.meetingId;
          if (!mid) return false;
          const canon = canonicalizeReachMeetingId(mid);
          return !!canon && !dismissedMeetingIdsRef.current.has(canon);
        });
        if (!hit) return;
        const mid = String(hit.metadata?.meeting_id ?? hit.metadata?.meetingId);
        const message =
          (hit.message && String(hit.message).trim()) ||
          (hit.title && String(hit.title).trim()) ||
          'A Reach meeting started. Join to participate.';
        await maybeShowMeetingStartedBanner({
          meetingId: mid,
          message,
          notificationId: hit.id,
        });
      } catch {
        // non-fatal
      }
    };

    void checkUnreadMeetingStarted();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void checkUnreadMeetingStarted();
        void clearMeetingStartedBannerIfJoined();
      }
    });
    return () => sub.remove();
  }, [user, maybeShowMeetingStartedBanner, clearMeetingStartedBannerIfJoined]);

  // Drop banner once the user is already in that meeting or on the join/call screens for it.
  useEffect(() => {
    if (!meetingStartedBanner) return;
    if (isMeetingScreen || isJoinMeetingScreen) {
      setMeetingStartedBanner(null);
      return;
    }
    void clearMeetingStartedBannerIfJoined(meetingStartedBanner.meetingId);
  }, [
    meetingStartedBanner,
    isMeetingScreen,
    isJoinMeetingScreen,
    clearMeetingStartedBannerIfJoined,
  ]);

  const handleMeetingStartedJoin = useCallback(() => {
    const banner = meetingStartedBanner;
    if (!banner) return;
    dismissedMeetingIdsRef.current.add(canonicalizeReachMeetingId(banner.meetingId));
    setMeetingStartedBanner(null);
    if (banner.notificationId != null) {
      apiClient.markNotificationRead(banner.notificationId).catch(() => {});
    }
    const path = getReachMeetingJoinPath({ meeting_id: banner.meetingId });
    if (!path) return;
    try {
      const { pathname, params } = parseNotificationPath(path);
      if (params && Object.keys(params).length > 0) {
        router.push({ pathname, params } as any);
      } else {
        router.push(pathname as any);
      }
    } catch {
      router.push('/quick-reach/meeting-call' as any);
    }
  }, [meetingStartedBanner, router]);

  const handleMeetingStartedDismiss = useCallback(() => {
    const banner = meetingStartedBanner;
    if (!banner) return;
    dismissedMeetingIdsRef.current.add(canonicalizeReachMeetingId(banner.meetingId));
    setMeetingStartedBanner(null);
    if (banner.notificationId != null) {
      apiClient.markNotificationRead(banner.notificationId).catch(() => {});
    }
  }, [meetingStartedBanner]);

  useEffect(() => {
    if (!user) return;
    void runSignatureGCOnLaunch();
    void evictStaleSessions();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshDefaultHomePathFromWebUser();
        useProgressStore.getState().cleanupStaleProgress();
      }
    });
    return () => sub.remove();
  }, [user]);

  const APP_LOCK_REMINDER_KEY = '@grabdocs_app_lock_reminder_last_shown';
  const APP_LOCK_REMINDER_OPTOUT_KEY = '@grabdocs_app_lock_reminder_opt_out';
  const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Register for push and send token to backend when user is logged in
  useEffect(() => {
    if (!user) return;
    let mounted = true;
    initializePushNotifications().then((token) => {
      if (mounted && token) {
        apiClient.registerPushToken(token).catch(() => {});
      }
    });
    return () => { mounted = false; };
  }, [user]);

  // Remind user to enable app lock periodically until they do (GrabDocs PIN hidden; unlock via biometric + device passcode)
  // Do not show when user opened the app from an external link (deep link / universal link)
  const openedViaLinkRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!user || appLockEnabled) return;

    const maybeShowReminder = async () => {
      try {
        const optedOut = await AsyncStorage.getItem(APP_LOCK_REMINDER_OPTOUT_KEY);
        if (optedOut === 'true') return;

        if (openedViaLinkRef.current === null) {
          const initialUrl = await Linking.getInitialURL();
          openedViaLinkRef.current = !!(initialUrl && initialUrl.trim().length > 0);
        }
        if (openedViaLinkRef.current) return;

        const lastStr = await AsyncStorage.getItem(APP_LOCK_REMINDER_KEY);
        const lastShown = lastStr ? parseInt(lastStr, 10) : 0;
        if (lastShown && Date.now() - lastShown < REMINDER_INTERVAL_MS) return;

        setAppLockReminderVisible(true);
        await AsyncStorage.setItem(APP_LOCK_REMINDER_KEY, String(Date.now()));
      } catch {
        // ignore storage/alert errors
      }
    };

    const sub = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') maybeShowReminder();
    });

    // Show once on mount if they're logged in and no PIN (e.g. first open), unless opened via link
    maybeShowReminder();

    return () => sub.remove();
  }, [user, appLockEnabled, router]);

  useEffect(() => {
    if (authLoading || coldStartAuthenticatedUserIdRef.current !== undefined) return;
    coldStartAuthenticatedUserIdRef.current = user?.id ?? null;
  }, [authLoading, user?.id]);

  // On logout, mark the cold-start id as "no session" (null, not undefined) so a same-session
  // re-login is treated as a FRESH login — notification auto-open stays disabled until the next
  // cold start. Without this, the guard below could fail open and hijack a re-login to /notifications.
  useEffect(() => {
    if (!user && coldStartAuthenticatedUserIdRef.current) {
      coldStartAuthenticatedUserIdRef.current = null;
    }
  }, [user]);

  const navigateFromNotificationData = useCallback(
    (data: Record<string, unknown>) => {
      const path = getNotificationScreen(data as Record<string, any>);
      try {
        const { pathname, params } = parseNotificationPath(path);
        if (params && Object.keys(params).length > 0) {
          router.push({ pathname, params } as any);
        } else {
          router.push(pathname as any);
        }
      } catch {
        router.push('/notifications');
      }
    },
    [router]
  );

  const handleNotificationResponse = useCallback(
    async (response: Notifications.NotificationResponse) => {
      if (!userRef.current) return;

      const notifId = response.notification.request.identifier;
      const actionId = response.actionIdentifier;
      const data = (response.notification.request.content.data || {}) as Record<string, unknown>;

      if (isJoinRequestNotificationAction(actionId)) {
        if (lastHandledNotifIdRef.current === notifId) return;
        lastHandledNotifIdRef.current = notifId;
        AsyncStorage.setItem(LAST_HANDLED_NOTIF_KEY, notifId).catch(() => {});
        try {
          await executeJoinRequestNotificationAction(actionId, data as Record<string, any>);
          await Notifications.dismissNotificationAsync(notifId).catch(() => {});
        } catch (err) {
          console.warn('Join request notification action failed:', err);
        }
        return;
      }

      if (isEmailReplyNotificationAction(actionId)) {
        if (lastHandledNotifIdRef.current === notifId) return;
        lastHandledNotifIdRef.current = notifId;
        AsyncStorage.setItem(LAST_HANDLED_NOTIF_KEY, notifId).catch(() => {});
        try {
          const path = getEmailReplyComposeScreen(data as Record<string, any>);
          const { pathname, params } = parseNotificationPath(path);
          if (params && Object.keys(params).length > 0) {
            router.push({ pathname, params } as any);
          } else {
            router.push(pathname as any);
          }
          await Notifications.dismissNotificationAsync(notifId).catch(() => {});
        } catch (err) {
          console.warn('Email reply notification action failed:', err);
        }
        return;
      }

      if (actionId !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      if (lastHandledNotifIdRef.current === notifId) return;
      lastHandledNotifIdRef.current = notifId;
      AsyncStorage.setItem(LAST_HANDLED_NOTIF_KEY, notifId).catch(() => {});
      navigateFromNotificationData(data);
    },
    [navigateFromNotificationData, router]
  );

  // AsyncStorage key used to persist the last notification ID that was handled so that
  // a stale lastNotificationResponse from a previous session is never re-processed after
  // the user logs in (or after an app restart).
  const LAST_HANDLED_NOTIF_KEY = '@grabdocs_last_handled_notif_id';

  // In-memory dedup for the current session: prevents the same notification from being
  // processed twice if React re-runs the effect (e.g. due to an unrelated state change).
  const lastHandledNotifIdRef = useRef<string | null>(null);

  // When user taps a notification and app was killed, listener is not registered yet — use last response.
  // Guard behind `user` so unauthenticated users are never routed to /notifications.
  // Double-guard with in-memory + AsyncStorage dedup so a stale lastNotificationResponse
  // from a previous session does not route the user to /notifications every time they log in.
  useEffect(() => {
    if (!user) return;
    // Fresh login in this session (Google, email, etc.) — never hijack with stale notification state.
    if (coldStartAuthenticatedUserIdRef.current !== user.id) return;
    if (!lastNotificationResponse) return;

    const notifId = lastNotificationResponse.notification.request.identifier;
    if (lastHandledNotifIdRef.current === notifId) return;

    void (async () => {
      try {
        const previouslyHandledId = await AsyncStorage.getItem(LAST_HANDLED_NOTIF_KEY);
        if (previouslyHandledId === notifId) {
          lastHandledNotifIdRef.current = notifId;
          return;
        }
      } catch {
        // Non-fatal: storage errors must not block notification routing.
      }

      await handleNotificationResponse(lastNotificationResponse);
    })();
  }, [user, lastNotificationResponse, handleNotificationResponse]);

  // When user taps a push notification (app already running), open the right screen or run action buttons.
  useEffect(() => {
    pushNotificationService.addNotificationResponseReceivedListener((response) => {
      void handleNotificationResponse(response);
    }).then((subscription) => {
      pushListenerRef.current = subscription;
    });
    return () => {
      pushListenerRef.current?.remove();
    };
  }, [handleNotificationResponse]);

  const showLock = !!user && appLockEnabled && isLocked;
  const mainContentRef = useRef<any>(null);

  const handleSkipToContent = () => {
    const handle = findNodeHandle(mainContentRef.current);
    if (handle != null) {
      AccessibilityInfo.setAccessibilityFocus(handle);
    }
  };

  const appLockReminderItems = useMemo((): ActionMenuItem[] => [
    {
      id: 'settings',
      label: 'Open Settings',
      icon: 'settings-outline',
      iconColor: '#007AFF',
      onPress: () => router.navigate('/(tabs)/settings'),
    },
    {
      id: 'later',
      label: 'Later',
      icon: 'time-outline',
      onPress: () => {},
    },
    {
      id: 'opt-out',
      label: "Don't remind me again",
      icon: 'notifications-off-outline',
      destructive: true,
      onPress: () => {
        void AsyncStorage.setItem(APP_LOCK_REMINDER_OPTOUT_KEY, 'true');
      },
    },
  ], [router]);

  return (
    <>
      {showLock && <AppLockScreen />}
      <StatusBar style={isMeetingScreen ? "light" : isDark ? "light" : "dark"} />
      {meetingStartedBanner && !isMeetingScreen && !isJoinMeetingScreen && (
        <ReachMeetingStartedBanner
          message={meetingStartedBanner.message}
          onJoin={handleMeetingStartedJoin}
          onDismiss={handleMeetingStartedDismiss}
        />
      )}
      {/* Skip to main content - WCAG 2.4.1 Bypass Blocks; visually hidden, first focusable for screen readers */}
      <Pressable
        onPress={handleSkipToContent}
        style={styles.skipLink}
        accessibilityLabel="Skip to main content"
        accessibilityRole="button"
      >
        <View />
      </Pressable>
      {/* Persistent Network Indicator - hidden on meeting screen for full-screen UX */}
      {!isMeetingScreen && !meetingStartedBanner && (
        <SafeAreaView
          style={styles.networkIndicatorContainer}
          edges={['top']}
          pointerEvents="box-none"
        >
          <NetworkIndicator compact persistent />
        </SafeAreaView>
      )}
      <ChatGDSheetProvider>
      <View ref={mainContentRef} style={[styles.mainContainer, { backgroundColor: isDark ? '#151718' : '#fff' }]} accessibilityLabel="Main content">
        <HeaderVisibilityProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="login-success" options={{ headerShown: false }} />
          <Stack.Screen name="login-error" options={{ headerShown: false }} />
          {/* Match file routes: app/analytics/dashboard.tsx — not "analytics" */}
          <Stack.Screen name="analytics/dashboard" options={{ headerShown: false }} />
          <Stack.Screen name="bookmarks" options={{ headerShown: false }} />
          <Stack.Screen name="drafts" options={{ headerShown: false }} />
          {/* Documents tab lives under (tabs)/documents — no root app/documents */}
          <Stack.Screen name="forms" options={{ headerShown: false }} />
          <Stack.Screen name="calendar" options={{ headerShown: false }} />
          <Stack.Screen name="quick-reach" options={{ headerShown: false }} />
          <Stack.Screen name="join-meeting" options={{ headerShown: false }} />
          <Stack.Screen name="upload-links" options={{ headerShown: false }} />
          <Stack.Screen name="intake" options={{ headerShown: false }} />
          <Stack.Screen name="clients" options={{ headerShown: false }} />
          <Stack.Screen name="email-sync" options={{ headerShown: false }} />
          <Stack.Screen name="email-oauth" options={{ headerShown: false }} />
          <Stack.Screen name="signatures" options={{ headerShown: false }} />
          <Stack.Screen name="workspaces" options={{ headerShown: false }} />
          <Stack.Screen name="billing" options={{ headerShown: false }} />
          <Stack.Screen name="scanner" options={{ headerShown: false }} />
          <Stack.Screen name="public-upload" options={{ headerShown: false }} />
          <Stack.Screen name="notifications" options={{ headerShown: false }} />
        </Stack>
        </HeaderVisibilityProvider>
        <View style={styles.bottomNavContainer}>
          <PersistentBottomNavigation />
        </View>
      </View>
      <ChatGDBottomSheetHost />
      </ChatGDSheetProvider>
      <ActionMenuModal
        visible={appLockReminderVisible}
        title="Set up app lock"
        message="For better security, lock the app 10 minutes after you leave it. You can unlock with Face ID, Touch ID, or your device passcode.

Go to Settings → Security & 2FA to turn it on."
        items={appLockReminderItems}
        onClose={() => setAppLockReminderVisible(false)}
      />
      <Toast />
      <GlobalProgressBar
        visible={visible}
        minimized={minimized}
        progressData={progressData}
        onMinimize={minimizeProgress}
        onExpand={expandProgress}
        onClose={closeProgress}
      />
    </>
  );
}

function AuthWrapper() {
  const { loading } = useAuth();
  const [updateRequired, setUpdateRequired] = useState<{ storeUrl: string; message?: string } | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [softStoreUpdate, setSoftStoreUpdate] = useState<{
    message: string;
    storeUrl: string;
    latestVersion?: string;
  } | null>(null);
  const lastUpdateCheckRef = useRef(0);
  const UPDATE_CHECK_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

  useEffect(() => {
    if (!loading) {
      SplashScreen.hideAsync().catch((err) => {
        if (!err?.message?.includes('No native splash screen registered')) {
          console.warn('SplashScreen.hideAsync failed:', err);
        }
      });
    }
  }, [loading]);

  const runUpdateChecks = useCallback(async () => {
    try {
      const config = await fetchAppConfig();
      const minResult = await checkMinVersion(undefined, config);
      if (minResult.mustUpdate) {
        reportUpdateTelemetry('min_version_blocked', {}).catch(() => {});
        setUpdateRequired({ storeUrl: minResult.storeUrl, message: minResult.message });
        setSoftStoreUpdate(null);
        return;
      }
      setUpdateRequired(null);
      if (minResult.softWarning) {
        setSoftStoreUpdate({
          message: minResult.softWarning.message,
          storeUrl: minResult.softWarning.storeUrl,
        });
        return;
      }
      const soft = await checkSoftStoreUpdate(undefined, config);
      if (soft.updateAvailable) {
        setSoftStoreUpdate({
          message: `A new version of GrabDocs (${soft.latestVersion}) is available. Update for the latest features and fixes.`,
          storeUrl: soft.storeUrl,
          latestVersion: soft.latestVersion,
        });
      } else {
        setSoftStoreUpdate(null);
      }
    } catch {
      setSoftStoreUpdate(null);
    }
  }, []);

  // Min version + soft store update: fetch config once, then run both checks.
  useEffect(() => {
    if (loading) return;
    runUpdateChecks();
  }, [loading, runUpdateChecks]);

  // Re-check when app comes to foreground, but throttle to once per 10 minutes
  // to avoid hitting the config endpoint on every app switch.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (Date.now() - lastUpdateCheckRef.current < UPDATE_CHECK_COOLDOWN_MS) return;
      lastUpdateCheckRef.current = Date.now();
      runUpdateChecks();
      // Also re-check OTA when returning to foreground (e.g. update published while app was backgrounded)
      if (!updateRequired) {
        checkOtaAndFetch().then(({ updateReady: ready }) => {
          if (ready) setUpdateReady(true);
        });
      }
    });
    return () => sub.remove();
  }, [runUpdateChecks, updateRequired]);

  // OTA: check and fetch silently; show banner when ready (user restarts when they want)
  useEffect(() => {
    if (loading || updateRequired) return;
    let mounted = true;
    checkOtaAndFetch().then(({ updateReady: ready }) => {
      if (mounted && ready) setUpdateReady(true);
    });
    return () => { mounted = false; };
  }, [loading, updateRequired]);

  if (loading) {
    return null;
  }

  if (updateRequired) {
    return <UpdateRequiredScreen storeUrl={updateRequired.storeUrl} message={updateRequired.message} />;
  }

  return (
    <>
      {updateReady && <OtaUpdateBanner />}
      {!updateReady && softStoreUpdate && (
        <SoftStoreUpdateBanner
          message={softStoreUpdate.message}
          storeUrl={softStoreUpdate.storeUrl}
          latestVersion={softStoreUpdate.latestVersion}
          persistDismissForVersion={softStoreUpdate.latestVersion}
          onDismiss={() => setSoftStoreUpdate(null)}
        />
      )}
      <LimitErrorProvider>
        <RootLayoutNav />
      </LimitErrorProvider>
    </>
  );
}

export default function RootLayout() {
  useEffect(() => {
    // Check if ErrorUtils is available (may not be in all React Native versions)
    if (typeof ErrorUtils === 'undefined' || !ErrorUtils) {
      console.warn('⚠️ ErrorUtils is not available - skipping global error handler setup');
      return;
    }

    // Set up global error handler for unhandled errors
    let originalErrorHandler: ((error: Error, isFatal?: boolean) => void) | undefined;
    
    try {
      originalErrorHandler = ErrorUtils.getGlobalHandler?.();
    } catch (err) {
      console.warn('⚠️ Could not get original error handler:', err);
    }
    
    try {
      ErrorUtils.setGlobalHandler?.((error: Error, isFatal?: boolean) => {
        // Try to log to backend, but don't let it crash the app
        try {
          errorLogger.logError(error, {
            severity: isFatal ? 'critical' : 'error',
            screenName: 'Global',
            userAction: 'Unhandled Error',
            errorType: 'UnhandledError',
          });
        } catch (logError) {
          // If error logging fails, just log to console
          console.error('Failed to log error to backend:', logError);
        }
        
        // Call original handler
        if (originalErrorHandler) {
          originalErrorHandler(error, isFatal);
        }
      });
    } catch (err) {
      console.warn('⚠️ Could not set global error handler:', err);
    }

    // Set up global promise rejection handler
    const unhandledRejectionHandler = (reason: any) => {
      try {
        const error = reason instanceof Error 
          ? reason 
          : new Error(String(reason || 'Unhandled Promise Rejection'));
        
        errorLogger.logError(error, {
          severity: 'error',
          screenName: 'Global',
          userAction: 'Unhandled Promise Rejection',
          errorType: 'UnhandledPromiseRejection',
        });
      } catch (logError) {
        // If error logging fails, just log to console
        console.error('Failed to log promise rejection to backend:', logError);
      }
    };

    // Handle unhandled promise rejections
    if (typeof global !== 'undefined' && global.Promise) {
      const originalUnhandledRejection = global.onunhandledrejection;
      global.onunhandledrejection = (event: any) => {
        unhandledRejectionHandler(event?.reason);
        if (originalUnhandledRejection && typeof originalUnhandledRejection === 'function') {
          (originalUnhandledRejection as any).call(global as any, event);
        }
      };
    }

    // Cleanup on unmount
    return () => {
      try {
        if (ErrorUtils && ErrorUtils.setGlobalHandler && originalErrorHandler) {
          ErrorUtils.setGlobalHandler(originalErrorHandler);
        }
      } catch (err) {
        console.warn('⚠️ Could not restore original error handler:', err);
      }
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <DisplayScaleProvider>
            <UserPreferencesProvider>
            <AuthProvider>
              <Enhanced2FAAuthProvider>
                <AppLockProvider>
                  <AuthWrapper />
                </AppLockProvider>
              </Enhanced2FAAuthProvider>
            </AuthProvider>
            </UserPreferencesProvider>
          </DisplayScaleProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  skipLink: {
    position: 'absolute',
    left: -10000,
    top: 0,
    width: 1,
    height: 1,
    zIndex: 9999,
  },
  mainContainer: {
    flex: 1,
  },
  networkIndicatorContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    alignItems: 'flex-end', // Align to the right
    marginTop: -4,
    paddingTop: 0,
    paddingRight: 8,
  },
  bottomNavContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 100,
  },
}); 