import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { Platform } from 'react-native';

/**
 * Re-apply a WebRTC/HMS-friendly audio session after interruptions
 * (app backgrounded during prejoin, phone calls, expo-av join chimes, etc.).
 * Best-effort only — never remount HMS from here.
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
