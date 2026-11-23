import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { Platform } from 'react-native';

/**
 * Re-apply a WebRTC/HMS-friendly audio session after interruptions
 * (app backgrounded during an active call, phone calls, expo-av join chimes).
 * Do not call this on leave or before preview — an exclusive session left
 * active makes the next HMS preview fail with 3015 (CannotInterruptOthers).
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

let pendingRelease: Promise<void> = Promise.resolve();

/**
 * Drop expo-av's play-and-record session so the next HMS preview can activate
 * audio. Leave used to call restoreHmsCallAudioMode(), which kept DoNotMix
 * active and the rejoin looked like "another call is using audio".
 */
export function releaseHmsCallAudioMode(): Promise<void> {
  if (Platform.OS === 'web') return Promise.resolve();
  pendingRelease = Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: false,
    staysActiveInBackground: false,
    interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
    interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
  }).then(
    () => undefined,
    () => undefined,
  );
  return pendingRelease;
}

/** Wait for an in-flight release, but never block join if expo-av hangs. */
export function waitForHmsAudioReleased(timeoutMs = 800): Promise<void> {
  return Promise.race([
    pendingRelease,
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}
