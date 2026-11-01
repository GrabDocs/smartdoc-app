/**
 * Runs after HMS Room Kit completes prejoin Join: notifies parent once the local user is actually
 * in the room, then the app POSTs `/api/v1/video/room/join-by-id/confirm` for GrabDocs presence.
 *
 * Web detects "connected" via `useHMSStore(selectIsConnectedToRoom)`. The native package
 * (`@100mslive/react-native-hms`) does NOT export that selector on RN 1.12.
 *
 * CRITICAL — do NOT call HMSNativeEventListener.addListener with a hardcoded SDK id (e.g. '12345'):
 * Room Kit registers ON_PREVIEW / ON_JOIN on the dynamic id from HMSSDK.build(). The emitter's
 * listenerCount is global per event type, so the first subscriber wins enableEvent({ id }).
 * Subscribing with the wrong id prevents Room Kit from ever receiving ON_PREVIEW (black spinner)
 * or ON_JOIN (stuck Join button).
 *
 * CRITICAL — do NOT attach a raw `new NativeEventEmitter(HMSManagerModule)` either; that breaks
 * ref-counting and stops all SDK events (v1.0.53 regression).
 *
 * Safe path: `useHMSPeerUpdates` — the SDK's dedicated ON_PEER_UPDATE channel (DEFAULT_SDK_ID).
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';

let hmsPkgCache: Record<string, unknown> | null | undefined;

function getHmsPkg(): Record<string, unknown> | null {
  if (hmsPkgCache !== undefined) return hmsPkgCache;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    hmsPkgCache = require('@100mslive/react-native-hms') as Record<string, unknown>;
    /* eslint-enable @typescript-eslint/no-require-imports */
  } catch {
    hmsPkgCache = null;
  }
  return hmsPkgCache;
}

type Props = {
  enabled: boolean;
  /** When true, join confirm succeeded — disable stuck timer entirely. */
  joinCompleted?: boolean;
  onEnteredRoom: () => void;
  /** Local peer's name as entered in the HMS preview (fires before onEnteredRoom when known). */
  onLocalPeerName?: (name: string) => void;
  /**
   * Called when join never completes within {@link STUCK_JOIN_TIMEOUT_MS}. Surfaces an error
   * instead of leaving the HMS prebuilt spinner hanging forever.
   */
  onConnectionStuck?: () => void;
};

/** Max time from bridge enable until we treat the join as failed (no room-entry signal). */
const STUCK_JOIN_TIMEOUT_MS = 90000;

/** Room-entry signals from useHMSPeerUpdates (local join may not emit PEER_JOINED). */
function isRoomEntryPeerUpdate(data: {
  type?: string;
  peer?: { peerID?: string; isLocal?: boolean };
} | undefined): boolean {
  if (!data) return false;
  if (data.peer?.isLocal === true) return true;
  const t = (data.type ?? '').toUpperCase();
  if (
    t === 'ROOM_JOINED' ||
    t === 'PEER_LIST_UPDATED' ||
    t === 'ROLE_CHANGED' ||
    t === 'LOCAL_PEER_UPDATE'
  ) {
    return true;
  }
  // Remote peer joined — we are also in the room.
  if (t === 'PEER_JOINED' && data.peer) return true;
  return false;
}

function InnerPresenceBridge({ enabled, joinCompleted, onEnteredRoom, onLocalPeerName, onConnectionStuck }: Props) {
  const doneRef = useRef(false);
  const firedRef = useRef(false);
  const stuckFiredRef = useRef(false);
  const stuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onConnectionStuckRef = useRef<(() => void) | undefined>(undefined);
  onConnectionStuckRef.current = onConnectionStuck;
  const onLocalPeerNameRef = useRef<((name: string) => void) | undefined>(undefined);
  onLocalPeerNameRef.current = onLocalPeerName;
  const hmsPkg = useMemo(() => getHmsPkg(), []);

  const clearStuckTimer = useCallback(() => {
    if (stuckTimerRef.current) {
      clearTimeout(stuckTimerRef.current);
      stuckTimerRef.current = null;
    }
  }, []);

  const scheduleStuckTimer = useCallback(() => {
    if (Platform.OS === 'web' || !enabled || joinCompleted || doneRef.current) return;
    clearStuckTimer();
    stuckTimerRef.current = setTimeout(() => {
      if (doneRef.current || stuckFiredRef.current || joinCompleted) return;
      stuckFiredRef.current = true;
      onConnectionStuckRef.current?.();
    }, STUCK_JOIN_TIMEOUT_MS);
  }, [enabled, joinCompleted, clearStuckTimer]);

  const fireOnce = useCallback(() => {
    if (doneRef.current || firedRef.current) return;
    firedRef.current = true;
    clearStuckTimer();
    queueMicrotask(() => {
      if (doneRef.current) return;
      doneRef.current = true;
      onEnteredRoom();
    });
  }, [onEnteredRoom, clearStuckTimer]);

  useEffect(() => {
    if (!enabled) {
      clearStuckTimer();
      return;
    }
    doneRef.current = false;
    firedRef.current = false;
    stuckFiredRef.current = false;
    scheduleStuckTimer();
    return clearStuckTimer;
  }, [enabled, joinCompleted, scheduleStuckTimer, clearStuckTimer]);

  useEffect(() => {
    if (joinCompleted) clearStuckTimer();
  }, [joinCompleted, clearStuckTimer]);

  const useHMSPeerUpdates = (
    typeof hmsPkg?.useHMSPeerUpdates === 'function'
      ? (hmsPkg.useHMSPeerUpdates as (handler: (...args: unknown[]) => void, deps: unknown[]) => void)
      : (_h: (...args: unknown[]) => void, _d: unknown[]) => {}
  );

  useHMSPeerUpdates(
    (...args: unknown[]) => {
      if (!enabled) return;
      const data = args[0] as {
        type?: string;
        peer?: { peerID?: string; isLocal?: boolean; name?: string };
      } | undefined;
      const localName = data?.peer?.isLocal === true ? (data.peer.name ?? '').trim() : '';
      if (localName) onLocalPeerNameRef.current?.(localName);
      if (doneRef.current || joinCompleted) return;
      if (isRoomEntryPeerUpdate(data)) {
        fireOnce();
      }
    },
    [enabled, joinCompleted, fireOnce],
  );

  return null;
}

export function MeetingPresenceConfirmBridge(props: Props) {
  if (Platform.OS === 'web' || !props.enabled) return null;
  return (
    <InnerPresenceBridge
      enabled={props.enabled}
      joinCompleted={props.joinCompleted}
      onEnteredRoom={props.onEnteredRoom}
      onLocalPeerName={props.onLocalPeerName}
      onConnectionStuck={props.onConnectionStuck}
    />
  );
}

