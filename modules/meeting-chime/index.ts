import { requireOptionalNativeModule } from 'expo';

type MeetingChimeNativeModule = {
  playJoinChime(): boolean;
  /** iOS only. Real AVAudioSession.setActive(false). False if the session is still busy. */
  deactivateAudioSession?: () => boolean;
  /** iOS only. AVAudioSession.setActive(true) without changing category. */
  reactivateAudioSession?: () => boolean;
};

const MeetingChime = requireOptionalNativeModule<MeetingChimeNativeModule>('MeetingChime');

/**
 * Play the meeting join chime, following the phone's ringer / silent setting.
 * Returns false when silenced, unsupported (web / Expo Go / older binaries), or on failure.
 */
export function playMeetingJoinChime(): boolean {
  if (!MeetingChime) return false;
  try {
    return MeetingChime.playJoinChime();
  } catch {
    return false;
  }
}

/** Release the shared iOS audio session so 100ms can activate it. No-op off iOS. */
export function deactivateMeetingAudioSession(): boolean {
  if (!MeetingChime?.deactivateAudioSession) return false;
  try {
    return MeetingChime.deactivateAudioSession();
  } catch {
    return false;
  }
}

/** Re-activate the current iOS audio session without changing its category. */
export function reactivateMeetingAudioSession(): boolean {
  if (!MeetingChime?.reactivateAudioSession) return false;
  try {
    return MeetingChime.reactivateAudioSession();
  } catch {
    return false;
  }
}
