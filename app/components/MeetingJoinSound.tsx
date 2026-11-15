/**
 * MeetingJoinSound - Plays a chime when someone joins the meeting (mobile only)
 * Uses @100mslive/react-native-hms useHMSPeerUpdates to detect PEER_JOINED events.
 *
 * The chime follows the phone's settings: it plays when the ringer is on and is muted when
 * the phone is silenced (iPhone silent switch, Android silent/vibrate or Do Not Disturb).
 * See modules/meeting-chime.
 *
 * Only render this when HMSPrebuilt is available (not in Expo Go).
 */
import { useCallback, useRef } from 'react';
import { playMeetingJoinChime } from '../../modules/meeting-chime';

/** Collapse a burst of joins (e.g. peer list replay) into one chime. */
const CHIME_COOLDOWN_MS = 1500;

interface MeetingJoinSoundProps {
  enabled: boolean;
  onPeerJoined?: (peerName: string) => void;
}

/**
 * Renders nothing - this component only sets up the peer join listener.
 * Must be used when in a meeting (HMSPrebuilt is rendered).
 * Only mount when HMS is available (not Expo Go).
 */
export function MeetingJoinSound({ enabled, onPeerJoined }: MeetingJoinSoundProps): null {
  const recentPeerIdsRef = useRef<Set<string>>(new Set());
  const lastChimeAtRef = useRef(0);

  const handlePeerUpdate = useCallback(
    (data: { peer: { peerID?: string; name?: string; isLocal?: boolean }; type: string }) => {
      if (!enabled) return;
      if (data.type !== 'PEER_JOINED') return;
      // Our own join is not news to us.
      if (data.peer?.isLocal === true) return;

      const peerId = data.peer?.peerID ?? 'unknown';
      if (recentPeerIdsRef.current.has(peerId)) return;
      recentPeerIdsRef.current.add(peerId);
      setTimeout(() => {
        recentPeerIdsRef.current.delete(peerId);
      }, 2000);

      onPeerJoined?.(data.peer?.name || 'Someone');

      const now = Date.now();
      if (now - lastChimeAtRef.current < CHIME_COOLDOWN_MS) return;
      lastChimeAtRef.current = now;
      playMeetingJoinChime();
    },
    [enabled, onPeerJoined]
  );

  // useHMSPeerUpdates must be called unconditionally (hooks rule)
  // This component is only rendered when HMSPrebuilt is available, so the HMS SDK is loaded
  const { useHMSPeerUpdates } = require('@100mslive/react-native-hms');
  useHMSPeerUpdates(handlePeerUpdate, [enabled, handlePeerUpdate]);

  return null;
}
