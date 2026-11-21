/**
 * Join Meeting - Deep link handler for grabdocs://join-meeting?meeting_id=...
 * Signed-in app users join immediately with their account display name.
 * Form only when passcode (no token) or host approval is required.
 */
import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useLimitError } from '../contexts/LimitErrorContext';
import { limitErrorFromCaught } from '../utils/limitErrorUtils';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { io, Socket } from 'socket.io-client';
import {
  getReachParticipantDisplayName,
  sanitizeReachDisplayName,
} from '../utils/reachDisplayName';
import { resumeLiveReachMeetingRoute } from '../constants/reachMeeting';
import { API_BASE_URL, STORAGE_KEYS } from '../constants/Config';
import { apiClient } from '../services/api';
import { secureStorage } from '../utils/storage';
import { useAuth } from './context/auth';

const JOIN_APPROVAL_WAITING_KEY = 'join_approval_waiting';
const POLL_INTERVAL_MS = 3000;
const WAITING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

type CheckState = 'idle' | 'loading' | 'form' | 'waiting' | 'timeout' | 'rejected' | 'error' | 'ready';

interface MeetingRequirements {
  passcode_required: boolean;
  require_join_approval: boolean;
  room_name?: string;
  room_id?: number;
}

/** Only set userName when sanitization yields a non-empty string (omit key otherwise). */
function appendSanitizedUserName(
  q: URLSearchParams,
  rawLabel: string
) {
  const cleaned = sanitizeReachDisplayName(rawLabel);
  if (cleaned) q.set('userName', cleaned);
}

function appendReturnToParam(q: URLSearchParams, returnTo: string | undefined) {
  const v = returnTo?.trim();
  if (v) q.set('returnTo', v);
}

export default function JoinMeetingScreen() {
  const router = useRouter();
  const { showLimitError } = useLimitError();
  const params = useLocalSearchParams<{
    meeting_id?: string;
    passcode?: string;
    passcode_token?: string;
    returnTo?: string;
    join_request_id?: string;
    userName?: string;
  }>();
  const meetingId = params.meeting_id?.trim() || '';
  const returnTo = typeof params.returnTo === 'string' ? params.returnTo.trim() : '';
  const joinRequestIdFromRoute = (() => {
    const raw = params.join_request_id;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const insets = useSafeAreaInsets();
  const { user, loading: authLoading } = useAuth();

  const [checkState, setCheckState] = useState<CheckState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [requirements, setRequirements] = useState<MeetingRequirements | null>(null);
  const [participantName, setParticipantName] = useState<string>('');
  // Never trust passcode from URL (tamperable). Only use passcode_token from URL or user-typed passcode.
  const [passcode, setPasscode] = useState<string>('');
  const [joinRequestId, setJoinRequestId] = useState<number | null>(null);
  const [approvalStatus, setApprovalStatus] = useState<'pending' | 'approved' | 'rejected' | null>(null);
  const [rejectionMessage, setRejectionMessage] = useState<string>('');
  const [joinRequestSubmitting, setJoinRequestSubmitting] = useState(false);

  const isMountedRef = useRef(true);
  const hasNavigatedRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitingStartedAtRef = useRef<number>(0);
  const passcodeRef = useRef('');
  const participantNameRef = useRef('');
  const [restoreDone, setRestoreDone] = useState(false);
  const [joiningAfterApproval, setJoiningAfterApproval] = useState(false);

  // Mount-only — do not clear this when the restore effect re-runs (auth/user churn).
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    passcodeRef.current = passcode;
  }, [passcode]);

  useEffect(() => {
    participantNameRef.current = participantName;
  }, [participantName]);

  const goToAppHome = useCallback(() => {
    router.replace('/(tabs)' as any);
  }, [router]);

  const clearPersistedWaiting = useCallback(() => {
    AsyncStorage.removeItem(JOIN_APPROVAL_WAITING_KEY).catch(() => {});
  }, []);

  const persistWaitingState = useCallback(
    (requestId: number, mid: string, pc: string, name: string) => {
      AsyncStorage.setItem(
        JOIN_APPROVAL_WAITING_KEY,
        JSON.stringify({
          joinRequestId: requestId,
          meetingId: mid,
          passcode: pc,
          participantName: name,
          startedAt: Date.now(),
        })
      ).catch(() => {});
    },
    []
  );

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Restore waiting state from route (HMS redirected after JOIN_APPROVAL_REQUIRED) or AsyncStorage
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      if (!meetingId || cancelled) {
        setRestoreDone(true);
        return;
      }
      try {
        // Prefer explicit join_request_id from navigation (already submitted / push approved).
        if (joinRequestIdFromRoute != null) {
          const nameFromRoute =
            sanitizeReachDisplayName(params.userName || '') ||
            getReachParticipantDisplayName(user) ||
            '';
          let pc = typeof params.passcode === 'string' ? params.passcode : '';
          // Pull passcode from prior wait blob when push/deep link omitted it.
          if (!pc) {
            try {
              const raw = await AsyncStorage.getItem(JOIN_APPROVAL_WAITING_KEY);
              if (raw) {
                const data = JSON.parse(raw);
                if (data.meetingId === meetingId.trim() && data.passcode) {
                  pc = String(data.passcode);
                }
              }
            } catch {
              /* ignore */
            }
          }
          if (cancelled) {
            setRestoreDone(true);
            return;
          }
          setJoinRequestId(joinRequestIdFromRoute);
          if (nameFromRoute) setParticipantName(nameFromRoute);
          if (pc) setPasscode(pc);
          setCheckState('waiting');
          setApprovalStatus('pending');
          waitingStartedAtRef.current = Date.now();
          persistWaitingState(joinRequestIdFromRoute, meetingId.trim(), pc, nameFromRoute);
          setRestoreDone(true);
          return;
        }

        const raw = await AsyncStorage.getItem(JOIN_APPROVAL_WAITING_KEY);
        if (cancelled) {
          setRestoreDone(true);
          return;
        }
        if (raw) {
          const data = JSON.parse(raw);
          const startedAt = data.startedAt || 0;
          if (Date.now() - startedAt <= WAITING_TIMEOUT_MS && data.joinRequestId != null && data.meetingId === meetingId.trim()) {
            setJoinRequestId(data.joinRequestId);
            setPasscode(data.passcode || '');
            setParticipantName(data.participantName || '');
            setCheckState('waiting');
            setApprovalStatus('pending');
            waitingStartedAtRef.current = startedAt;
          } else {
            AsyncStorage.removeItem(JOIN_APPROVAL_WAITING_KEY).catch(() => {});
          }
        }
      } catch (_) {
        // ignore
      }
      setRestoreDone(true);
    };

    restore();
    return () => {
      cancelled = true;
    };
  }, [meetingId, joinRequestIdFromRoute, params.userName, params.passcode, user, persistWaitingState]);

  // Pre-check when we have meetingId, restore has run, auth has hydrated, and not already in form/waiting
  useEffect(() => {
    if (authLoading) return; // wait for auth to finish restoring from storage before reading user
    if (!meetingId || !restoreDone || checkState === 'form' || checkState === 'waiting' || checkState === 'timeout' || checkState === 'rejected') {
      return;
    }
    if (checkState !== 'idle') return;

    const liveRoute = resumeLiveReachMeetingRoute(meetingId);
    if (liveRoute) {
      hasNavigatedRef.current = true;
      clearPersistedWaiting();
      router.replace(liveRoute as any);
      return;
    }

    const runPreCheck = async () => {
      setCheckState('loading');
      setErrorMessage('');

      try {
        const checkRes = await apiClient.client.post('/api/v1/video/room/check-requirements', {
          meeting_id: meetingId.trim(),
        });
        const data = checkRes?.data;

        if (!data?.success) {
          setErrorMessage(data?.error || 'Could not load meeting.');
          setCheckState('error');
          return;
        }

        const isMeetingStarted = data.is_meeting_started ?? (data.status === 'active' || data.meeting_status === 'active');
        const isHost = data.is_owner || data.is_current_host;
        const isPrivateMeeting = data.passcode_required || data.require_join_approval;

        setRequirements({
          passcode_required: data.passcode_required,
          require_join_approval: data.require_join_approval,
          room_name: data.room_name,
          room_id: data.room_id,
        });

        if (!isMeetingStarted && !isHost && isPrivateMeeting) {
          setErrorMessage('Meeting requires host to start. Contact host');
          setCheckState('error');
          return;
        }

        if (isHost && !isMeetingStarted) {
          const roomId = data.room_id;
          if (roomId) {
            try {
              await apiClient.client.post('/api/v1/video/room/schedule/start', {
                scheduled_meeting_id: roomId,
              });
            } catch (startErr) {
              const limitData = limitErrorFromCaught(startErr);
              if (limitData) {
                showLimitError(limitData);
                setErrorMessage(limitData.message || 'Meeting limit reached');
                setCheckState('error');
                return;
              }
              console.warn('App warm: schedule/start failed (proceeding anyway):', startErr);
            }
          }
        }

        // Never trust passcode from URL. Only passcode_token (server-issued) or user-typed passcode.
        // Passcode-only and approval meetings need the form when there is no token.
        if ((data.passcode_required && !params.passcode_token) || data.require_join_approval) {
          setPasscode('');
          const defaultName = getReachParticipantDisplayName(user);
          if (defaultName) setParticipantName(defaultName);
          setCheckState('form');
          return;
        }

        // Already in this call on the HMS screen — stay there (do not remount / leave).
        const liveRoute = resumeLiveReachMeetingRoute(meetingId);
        if (liveRoute) {
          hasNavigatedRef.current = true;
          clearPersistedWaiting();
          router.replace(liveRoute as any);
          return;
        }

        // Open meeting immediately — use signed-in account name (no name-collection screen).
        hasNavigatedRef.current = true;
        clearPersistedWaiting();
        const q = new URLSearchParams({ meetingId: meetingId.trim() });
        if (params.passcode_token) q.set('passcode_token', params.passcode_token);
        appendSanitizedUserName(q, getReachParticipantDisplayName(user));
        appendReturnToParam(q, returnTo);
        router.replace(`/quick-reach/hms-meeting-interface?${q.toString()}` as any);
      } catch (err: any) {
        const limitData = limitErrorFromCaught(err);
        if (limitData) {
          showLimitError(limitData);
          setErrorMessage(limitData.message || 'Meeting limit reached');
          setCheckState('error');
          return;
        }
        const msg = err?.response?.data?.error || err?.message || 'Could not load meeting.';
        setErrorMessage(msg);
        setCheckState('error');
      }
    };

    runPreCheck();
  }, [
    meetingId,
    params.passcode_token,
    returnTo,
    router,
    checkState,
    restoreDone,
    user,
    authLoading,
    clearPersistedWaiting,
    showLimitError,
  ]);

  const navigateToMeeting = useCallback(async () => {
    if (hasNavigatedRef.current) return false;

    let pc = (passcodeRef.current || '').trim();
    let name =
      sanitizeReachDisplayName(participantNameRef.current) ||
      getReachParticipantDisplayName(user) ||
      '';
    let approvedJoinRequestId = joinRequestId;
    try {
      const raw = await AsyncStorage.getItem(JOIN_APPROVAL_WAITING_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.meetingId === meetingId.trim()) {
          if (!pc && data.passcode) pc = String(data.passcode).trim();
          if (!name && data.participantName) {
            name = sanitizeReachDisplayName(String(data.participantName)) || String(data.participantName);
          }
          if (approvedJoinRequestId == null && data.joinRequestId != null) {
            const n = Number(data.joinRequestId);
            if (Number.isFinite(n) && n > 0) approvedJoinRequestId = n;
          }
        }
      }
    } catch {
      /* ignore */
    }

    const liveRoute = resumeLiveReachMeetingRoute(meetingId);
    hasNavigatedRef.current = true;
    clearPersistedWaiting();
    if (liveRoute) {
      router.replace(liveRoute as any);
      return true;
    }
    const q = new URLSearchParams({ meetingId: meetingId.trim() });
    if (params.passcode_token) q.set('passcode_token', params.passcode_token);
    else if (pc) q.set('passcode', pc);
    appendSanitizedUserName(q, name || getReachParticipantDisplayName(user));
    appendReturnToParam(q, returnTo);
    if (approvedJoinRequestId != null) q.set('join_request_id', String(approvedJoinRequestId));
    router.replace(`/quick-reach/hms-meeting-interface?${q.toString()}` as any);
    return true;
  }, [meetingId, params.passcode_token, returnTo, router, clearPersistedWaiting, user, joinRequestId]);

  const enterMeetingAfterApproval = useCallback(async () => {
    if (hasNavigatedRef.current) return;
    setJoiningAfterApproval(true);
    setApprovalStatus('approved');
    try {
      const ok = await navigateToMeeting();
      if (!ok && isMountedRef.current) {
        // Allow a manual retry if navigation was skipped.
        hasNavigatedRef.current = false;
        setJoiningAfterApproval(false);
      }
    } catch {
      if (isMountedRef.current) {
        hasNavigatedRef.current = false;
        setJoiningAfterApproval(false);
      }
    }
  }, [navigateToMeeting]);

  const submitJoinRequest = useCallback(async () => {
    const name =
      sanitizeReachDisplayName(participantName) ||
      getReachParticipantDisplayName(user) ||
      'Participant';
    const pc = requirements?.passcode_required ? passcode.trim() : '';
    if (requirements?.passcode_required && !pc) {
      setErrorMessage('Passcode is required.');
      return;
    }

    // Passcode-only (no host approval): join directly with the typed passcode.
    if (!requirements?.require_join_approval) {
      setErrorMessage('');
      void navigateToMeeting();
      return;
    }

    setJoinRequestSubmitting(true);
    setErrorMessage('');

    try {
      await apiClient.prepareVideoJoinById({
        meeting_id: meetingId.trim(),
        participant_name: name,
        enable_audio: false,
        enable_video: false,
        // host/guest — backend downgrades non-creators; streaming maps both to near-realtime.
        // For explicit streaming latency, pass viewer_type: 'near-realtime' | 'realtime'.
        viewer_type: user ? 'host' : 'guest',
        join_intent: 'prepare',
        ...(params.passcode_token ? { passcode_token: params.passcode_token } : (pc ? { passcode: pc } : {})),
      });

      // 2xx here means meeting host/creator (approval waived). Invitees get 403 + wait.
      clearPersistedWaiting();
      hasNavigatedRef.current = true;
      const q = new URLSearchParams({ meetingId: meetingId.trim() });
      if (params.passcode_token) q.set('passcode_token', params.passcode_token);
      else if (pc) q.set('passcode', pc);
      appendSanitizedUserName(q, name);
      appendReturnToParam(q, returnTo);
      router.replace(`/quick-reach/hms-meeting-interface?${q.toString()}` as any);
    } catch (err: any) {
      setJoinRequestSubmitting(false);
      const limitData = limitErrorFromCaught(err);
      if (limitData) {
        showLimitError(limitData);
        setCheckState('form');
        return;
      }
      const status = err?.response?.status;
      const errData = err?.response?.data || {};
      const joinRequestIdFromResponse = errData.join_request_id ?? errData.joinRequestId;

      if (status === 403 && joinRequestIdFromResponse != null) {
        const id = Number(joinRequestIdFromResponse);
        setJoinRequestId(id);
        setApprovalStatus('pending');
        setCheckState('waiting');
        waitingStartedAtRef.current = Date.now();
        persistWaitingState(id, meetingId.trim(), pc, name);
        return;
      }

      setErrorMessage(errData?.error || errData?.message || err?.message || 'Failed to request join.');
      setCheckState('form');
    }
  }, [
    meetingId,
    participantName,
    passcode,
    requirements,
    params.passcode_token,
    returnTo,
    router,
    clearPersistedWaiting,
    persistWaitingState,
    user,
    navigateToMeeting,
    showLimitError,
  ]);

  // Poll for approval status when in waiting state (fallback if socket misses the event)
  useEffect(() => {
    if (checkState !== 'waiting' || joinRequestId == null) return;

    const pollStatus = async () => {
      if (!isMountedRef.current || hasNavigatedRef.current) return;
      try {
        const res = await apiClient.client.get(`/api/v1/video/join-request/${joinRequestId}/status`);
        const data = res?.data;
        if (!data?.success || !data?.join_request) return;

        const status = data.join_request.status;
        if (status === 'approved') {
          setApprovalStatus('approved');
          stopPolling();
          await enterMeetingAfterApproval();
        } else if (status === 'rejected') {
          stopPolling();
          setRejectionMessage('Your join request was rejected by the meeting host. You can try again or contact the host.');
          setCheckState('rejected');
          setJoinRequestId(null);
          setApprovalStatus(null);
          clearPersistedWaiting();
        } else {
          setApprovalStatus(status);
        }
      } catch (_) {
        // continue polling
      }
    };

    pollStatus();
    pollIntervalRef.current = setInterval(pollStatus, POLL_INTERVAL_MS);

    const onAppState = (next: AppStateStatus) => {
      if (next === 'active') {
        void pollStatus();
      }
    };
    const appSub = AppState.addEventListener('change', onAppState);

    return () => {
      appSub.remove();
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [checkState, joinRequestId, enterMeetingAfterApproval, clearPersistedWaiting, stopPolling]);

  // Socket.IO realtime approval (web parity): join_request_{id} room + user room
  useEffect(() => {
    if (checkState !== 'waiting' || joinRequestId == null) return;

    let cancelled = false;
    let socket: Socket | null = null;

    const handleRejected = () => {
      stopPolling();
      if (!isMountedRef.current || hasNavigatedRef.current) return;
      setRejectionMessage(
        'Your join request was rejected by the meeting host. You can try again or contact the host.'
      );
      setCheckState('rejected');
      setJoinRequestId(null);
      setApprovalStatus(null);
      clearPersistedWaiting();
    };

    const handleApproved = () => {
      if (!isMountedRef.current || hasNavigatedRef.current) return;
      stopPolling();
      void enterMeetingAfterApproval();
    };

    const connect = async () => {
      const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN).catch(() => null);
      if (cancelled) return;

      const isLocalApi = /localhost|127\.0\.0\.1|192\.168\.|10\.\d+\./.test(API_BASE_URL);
      socket = io(API_BASE_URL, {
        ...(token ? { auth: { token } } : {}),
        transports: isLocalApi ? ['polling', 'websocket'] : ['websocket'],
        upgrade: isLocalApi,
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000,
        reconnectionAttempts: 10,
        timeout: 20000,
        path: '/socket.io/',
      });

      const joinRooms = () => {
        if (!socket?.connected) return;
        socket.emit('join_join_request_room', { join_request_id: joinRequestId });
        const uid = user?.id != null ? Number(user.id) : NaN;
        if (Number.isFinite(uid) && uid >= 0) {
          socket.emit('authenticate', { user_id: uid });
          socket.emit('join_user_room', { user_id: uid });
        }
      };

      socket.on('connect', joinRooms);

      socket.on('join_request_updated', (data: any) => {
        const update = data?.update ?? data;
        const updatedId = update?.join_request_id ?? update?.joinRequestId;
        if (updatedId == null || Number(updatedId) !== Number(joinRequestId)) return;
        const action = String(update?.action || update?.status || '').toLowerCase();
        if (action === 'approved') handleApproved();
        else if (action === 'rejected') handleRejected();
      });
    };

    void connect();

    return () => {
      cancelled = true;
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
      }
    };
  }, [
    checkState,
    joinRequestId,
    user?.id,
    enterMeetingAfterApproval,
    clearPersistedWaiting,
    stopPolling,
  ]);

  // Timeout when in waiting state (15 min)
  useEffect(() => {
    if (checkState !== 'waiting') return;

    const elapsed = Date.now() - waitingStartedAtRef.current;
    const remaining = Math.max(0, WAITING_TIMEOUT_MS - elapsed);

    timeoutRef.current = setTimeout(() => {
      stopPolling();
      if (isMountedRef.current) {
        setCheckState('timeout');
        setJoinRequestId(null);
        setApprovalStatus(null);
        clearPersistedWaiting();
      }
    }, remaining);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [checkState, clearPersistedWaiting, stopPolling]);

  // Redirect when no meeting ID (e.g. invalid deep link)
  useEffect(() => {
    if (!meetingId || typeof meetingId !== 'string' || !meetingId.trim()) {
      router.replace('/(tabs)');
    }
  }, [meetingId, router]);

  if (!meetingId || typeof meetingId !== 'string' || !meetingId.trim()) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  if (checkState === 'error') {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>GrabDocs Meeting</Text>
          <Text style={styles.errorMessage}>{errorMessage}</Text>
          <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
            <Text style={styles.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (checkState === 'form') {
    const needsApproval = !!requirements?.require_join_approval;
    const hasName = sanitizeReachDisplayName(participantName).length > 0;
    const canSubmit =
      hasName &&
      (!requirements?.passcode_required || passcode.trim().length > 0) &&
      !joinRequestSubmitting;
    const isSubmitting = joinRequestSubmitting;

    return (
      <KeyboardAvoidingView
        style={[styles.container, { paddingTop: insets.top }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 20}
      >
        <ScrollView
          contentContainerStyle={styles.formScroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.formTitle}>{needsApproval ? 'Request to join' : 'Join meeting'}</Text>
          {requirements?.room_name && (
            <Text style={styles.roomName}>{requirements.room_name}</Text>
          )}
          <Text style={styles.label}>Your name (required)</Text>
          <TextInput
            style={styles.input}
            value={participantName}
            onChangeText={setParticipantName}
            placeholder="Enter your name"
            placeholderTextColor="#666"
            editable={!isSubmitting}
            autoCapitalize="words"
          />
          {requirements?.passcode_required && (
            <>
              <Text style={styles.label}>Passcode</Text>
              <TextInput
                style={styles.input}
                value={passcode}
                onChangeText={setPasscode}
                placeholder="Enter passcode"
                placeholderTextColor="#666"
                secureTextEntry
                keyboardType="number-pad"
                editable={!isSubmitting}
              />
            </>
          )}
          {errorMessage ? <Text style={styles.inlineError}>{errorMessage}</Text> : null}
          <TouchableOpacity
            style={[styles.primaryButton, (!canSubmit || isSubmitting) && styles.primaryButtonDisabled]}
            onPress={submitJoinRequest}
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.primaryButtonText}>{needsApproval ? 'Request to join' : 'Join'}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={goToAppHome}>
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  if (checkState === 'waiting') {
    const approved = approvalStatus === 'approved' || joiningAfterApproval;
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.waitingBox}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.waitingTitle}>
            {approved ? 'Approved — joining…' : 'Waiting for approval'}
          </Text>
          <Text style={styles.waitingMessage}>
            {approved
              ? 'The host approved your request. Opening the meeting now.'
              : 'Your join request has been submitted. The meeting host will be notified and should respond shortly.'}
          </Text>
          {!approved && approvalStatus === 'pending' && (
            <View style={styles.pendingBadge}>
              <Text style={styles.pendingText}>Status: Pending approval</Text>
            </View>
          )}
          {approved && (
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => {
                hasNavigatedRef.current = false;
                void enterMeetingAfterApproval();
              }}
              disabled={joiningAfterApproval && hasNavigatedRef.current}
            >
              <Text style={styles.primaryButtonText}>Join meeting</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
            <Text style={styles.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (checkState === 'timeout') {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>No response</Text>
          <Text style={styles.errorMessage}>The host has not responded.</Text>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => {
              setCheckState('form');
              setErrorMessage('');
            }}
          >
            <Text style={styles.primaryButtonText}>Try again</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
            <Text style={styles.backButtonText}>Leave</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (checkState === 'rejected') {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Request rejected</Text>
          <Text style={styles.errorMessage}>{rejectionMessage}</Text>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => {
              setRejectionMessage('');
              setCheckState('form');
            }}
          >
            <Text style={styles.primaryButtonText}>Try again</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.backButton} onPress={goToAppHome}>
            <Text style={styles.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ActivityIndicator size="large" color="#007AFF" />
      <Text style={styles.loadingText}>Checking meeting...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  loadingText: {
    color: '#999',
    marginTop: 12,
    fontSize: 14,
  },
  errorBox: {
    padding: 24,
    alignItems: 'center',
    maxWidth: 320,
  },
  errorTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  errorMessage: {
    color: '#ccc',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 24,
  },
  backButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#007AFF',
    marginTop: 12,
  },
  backButtonText: {
    color: '#007AFF',
    fontSize: 16,
  },
  formScroll: {
    padding: 24,
    paddingTop: 40,
  },
  formTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  roomName: {
    color: '#999',
    fontSize: 14,
    marginBottom: 20,
  },
  label: {
    color: '#ccc',
    fontSize: 14,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#222',
    borderWidth: 1,
    borderColor: '#444',
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 16,
    marginBottom: 16,
  },
  inlineError: {
    color: '#ff6b6b',
    fontSize: 14,
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  secondaryButtonText: {
    color: '#007AFF',
    fontSize: 16,
  },
  waitingBox: {
    padding: 24,
    alignItems: 'center',
    maxWidth: 320,
  },
  waitingTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 12,
  },
  waitingMessage: {
    color: '#ccc',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 20,
  },
  pendingBadge: {
    backgroundColor: 'rgba(255,193,7,0.2)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 24,
  },
  pendingText: {
    color: '#ffc107',
    fontSize: 12,
  },
});
