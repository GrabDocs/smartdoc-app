import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { Platform } from 'react-native';

/**
 * Re-apply a WebRTC/HMS-friendly audio session once a meeting token exists
 * (prejoin preview and in-call) and when the app returns to the foreground.
 * Do not call this on leave — leave should not change the audio session.
 */
export async function restoreHmsCallAudioMode(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    });
  } catch {
    // Best-effort — HMS may still recover on its own.
  }
}
