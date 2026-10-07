/**
 * Join Meeting - Deep link handler for grabdocs://join-meeting?meeting_id=...
 * Same logic as web: pre-check (check-requirements), then form for approval meetings (name, PIN),
 * submit via join-by-id, wait for approval (poll + optional push), then join.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useLimitError } from '../contexts/LimitErrorContext';
import { limitErrorFromCaught } from '../utils/limitErrorUtils';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import {
  getReachParticipantDisplayName,
  sanitizeReachDisplayName,
} from '../utils/reachDisplayName';
import { apiClient } from '../services/api';
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
  }>();
  const meetingId = params.meeting_id?.trim() || '';
  const returnTo = typeof params.returnTo === 'string' ? params.returnTo.trim() : '';
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
  const [restoreDone, setRestoreDone] = useState(false);

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

  // Restore waiting state from AsyncStorage on mount (run before pre-check)
  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;

    const restore = async () => {
      if (!meetingId || cancelled) {
        setRestoreDone(true);
        return;
      }
      try {
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
      isMountedRef.current = false;
    };
  }, [meetingId]);

  // Pre-check when we have meetingId, restore has run, auth has hydrated, and not already in form/waiting
  useEffect(() => {
    if (authLoading) return; // wait for auth to finish restoring from storage before reading user
    if (!meetingId || !restoreDone || checkState === 'form' || checkState === 'waiting' || checkState === 'timeout' || checkState === 'rejected') {
      return;
    }
    if (checkState !== 'idle') return;

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

        // Never trust passcode from URL. Only passcode_token (server-issued) or user-typed passcode.
        if (data.passcode_required && !params.passcode_token) {
          if (data.require_join_approval) {
            setCheckState('form');
            setPasscode('');
            return;
          }
          setErrorMessage('This meeting requires a passcode. Please use the link shared by the host.');
          setCheckState('error');
          return;
        }

        if (data.require_join_approval) {
          setCheckState('form');
          setPasscode('');
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

        setCheckState('ready');
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
  }, [meetingId, params.passcode_token, returnTo, router, checkState, restoreDone, user, authLoading]);

  const navigateToMeeting = useCallback(() => {
    if (hasNavigatedRef.current || !isMountedRef.current) return;
    hasNavigatedRef.current = true;
    clearPersistedWaiting();
    const q = new URLSearchParams({ meetingId: meetingId.trim() });
    if (params.passcode_token) q.set('passcode_token', params.passcode_token);
    else if (passcode) q.set('passcode', passcode);
    appendSanitizedUserName(q, getReachParticipantDisplayName(user));
    appendReturnToParam(q, returnTo);
    router.replace(`/quick-reach/hms-meeting-interface?${q.toString()}` as any);
  }, [meetingId, passcode, params.passcode_token, returnTo, router, clearPersistedWaiting, user]);

  const submitJoinRequest = useCallback(async () => {
    const name = participantName.trim() || 'Participant';
    const pc = requirements?.passcode_required ? passcode.trim() : '';
    if (requirements?.passcode_required && !pc) {
      setErrorMessage('Passcode is required.');
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

      // Unexpected 2xx (approval waived) — HMS screen runs prepare again as the canonical join path.
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
  }, [meetingId, participantName, passcode, requirements, params.passcode_token, returnTo, router, clearPersistedWaiting, persistWaitingState, user]);

  // Poll for approval status when in waiting state
  useEffect(() => {
    if (checkState !== 'waiting' || joinRequestId == null) return;

    const pollStatus = async () => {
      if (!isMountedRef.current) return;
      try {
        const res = await apiClient.client.get(`/api/v1/video/join-request/${joinRequestId}/status`);
        const data = res?.data;
        if (!data?.success || !data?.join_request) return;

        const status = data.join_request.status;
        setApprovalStatus(status);

        if (status === 'approved') {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          if (isMountedRef.current && !hasNavigatedRef.current) {
            navigateToMeeting();
          }
        } else if (status === 'rejected') {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          setRejectionMessage('Your join request was rejected by the meeting host. You can try again or contact the host.');
          setCheckState('rejected');
          setJoinRequestId(null);
          setApprovalStatus(null);
          clearPersistedWaiting();
        }
      } catch (_) {
        // continue polling
      }
    };

    pollStatus();
    pollIntervalRef.current = setInterval(pollStatus, POLL_INTERVAL_MS);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [checkState, joinRequestId, navigateToMeeting, clearPersistedWaiting]);

  // Timeout when in waiting state (15 min)
  useEffect(() => {
    if (checkState !== 'waiting') return;

    const elapsed = Date.now() - waitingStartedAtRef.current;
    const remaining = Math.max(0, WAITING_TIMEOUT_MS - elapsed);

    timeoutRef.current = setTimeout(() => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      timeoutRef.current = null;
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
  }, [checkState, clearPersistedWaiting]);

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
    const canSubmit =
      (participantName.trim().length > 0) &&
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
          <Text style={styles.formTitle}>Request to join</Text>
          {requirements?.room_name && (
            <Text style={styles.roomName}>{requirements.room_name}</Text>
          )}
          <Text style={styles.label}>Your name (required for organizer)</Text>
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
              <Text style={styles.primaryButtonText}>Request to join</Text>
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
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.waitingBox}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.waitingTitle}>Waiting for approval</Text>
          <Text style={styles.waitingMessage}>
            Your join request has been submitted. The meeting host will be notified and should respond shortly.
          </Text>
          {approvalStatus === 'pending' && (
            <View style={styles.pendingBadge}>
              <Text style={styles.pendingText}>Status: Pending approval</Text>
            </View>
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
