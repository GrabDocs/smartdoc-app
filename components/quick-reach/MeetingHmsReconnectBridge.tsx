/**
 * Surfaces HMS media reconnect state to the parent so we can show "Connection lost"
 * only when the user cannot stay in the meeting (matches web PrebuiltVideoMeeting).
 *
 * Backend /health reachability is intentionally ignored — API blips must not interrupt
 * a healthy HMS call.
 *
 * Safe listen path (same constraints as MeetingPresenceConfirmBridge):
 * - Do NOT call hmsInstance.addEventListener for RECONNECTING/RECONNECTED — Room Kit
 *   owns the single JS delegate and we would overwrite it.
 * - Do NOT create a raw NativeEventEmitter on HMSManager.
 * - After Room Kit has joined, add a parallel HMSNativeEventListener (DEFAULT_SDK_ID),
 *   matching useHMSPeerUpdates. Room Kit already enabled the native event, so we only
 *   attach another JS subscriber and never steal enableEvent.
 */
import React, { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';

type NativeSub = { remove: () => void };

type NativeListenerApi = {
  addListener: (
    id: string,
    eventType: string,
    listener: (...args: unknown[]) => void
  ) => NativeSub;
};

let nativeListenerCache: NativeListenerApi | null | undefined;
let defaultsCache:
  | { sdkId: string; reconnecting: string; reconnected: string }
  | null
  | undefined;

function getNativeListener(): NativeListenerApi | null {
  if (nativeListenerCache !== undefined) return nativeListenerCache;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    // Not exported from package index; same internal module useHMSPeerUpdates uses.
    nativeListenerCache = require('@100mslive/react-native-hms/src/classes/HMSNativeEventListener')
      .default as NativeListenerApi;
    /* eslint-enable @typescript-eslint/no-require-imports */
  } catch {
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      nativeListenerCache = require('@100mslive/react-native-hms/lib/commonjs/classes/HMSNativeEventListener')
        .default as NativeListenerApi;
      /* eslint-enable @typescript-eslint/no-require-imports */
    } catch {
      nativeListenerCache = null;
    }
  }
  return nativeListenerCache;
}

function getReconnectDefaults(): {
  sdkId: string;
  reconnecting: string;
  reconnected: string;
} | null {
  if (defaultsCache !== undefined) return defaultsCache;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const hmsPkg = require('@100mslive/react-native-hms') as {
      HMSUpdateListenerActions?: { RECONNECTING?: string; RECONNECTED?: string };
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
    const reconnecting = hmsPkg.HMSUpdateListenerActions?.RECONNECTING;
    const reconnected = hmsPkg.HMSUpdateListenerActions?.RECONNECTED;
    if (!reconnecting || !reconnected) {
      defaultsCache = null;
      return null;
    }
    // Same id useHMSPeerUpdates / MeetingPresenceConfirmBridge rely on.
    defaultsCache = { sdkId: '12345', reconnecting, reconnected };
  } catch {
    defaultsCache = null;
  }
  return defaultsCache;
}

type Props = {
  enabled: boolean;
  onReconnecting: () => void;
  onReconnected: () => void;
};

export function MeetingHmsReconnectBridge({
  enabled,
  onReconnecting,
  onReconnected,
}: Props) {
  const onReconnectingRef = useRef(onReconnecting);
  const onReconnectedRef = useRef(onReconnected);
  onReconnectingRef.current = onReconnecting;
  onReconnectedRef.current = onReconnected;

  useEffect(() => {
    if (Platform.OS === 'web' || !enabled) return;

    const nativeListener = getNativeListener();
    const defaults = getReconnectDefaults();
    if (!nativeListener?.addListener || !defaults) return;

    const maybeFireReconnecting = () => {
      // Match web: only surface reconnect UI while the screen is foregrounded.
      if (AppState.currentState !== 'active') return;
      onReconnectingRef.current();
    };

    const subReconnecting = nativeListener.addListener(
      defaults.sdkId,
      defaults.reconnecting,
      maybeFireReconnecting
    );
    const subReconnected = nativeListener.addListener(
      defaults.sdkId,
      defaults.reconnected,
      () => {
        onReconnectedRef.current();
      }
    );

    return () => {
      subReconnecting?.remove?.();
      subReconnected?.remove?.();
    };
  }, [enabled]);

  return null;
}
