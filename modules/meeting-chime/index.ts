import { requireOptionalNativeModule } from 'expo';

type MeetingChimeNativeModule = {
  playJoinChime(): boolean;
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
