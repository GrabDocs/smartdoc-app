import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { AppState, Platform } from 'react-native';

import { deactivateMeetingAudioSession, reactivateMeetingAudioSession } from '../modules/meeting-chime';

/**
 * iOS AVAudioSession is exclusive. expo-av's setAudioModeAsync keeps a PlayAndRecord
 * session active (it never calls setActive:false — see expo/expo#15873) and 100ms then
 * fails preview with error 3015 ("Can't start meeting audio"). Android has no equivalent.
 *
 * Before preview, and after leave, drop that session so HMS can activate its own.
 * Do not call setAudioModeAsync on iOS.
 */

let releaseGate: Promise<void> = Promise.resolve();
let lastInactiveAt = 0;

if (Platform.OS === 'ios') {
  AppState.addEventListener('change', (next) => {
    if (next !== 'active') lastInactiveAt = Date.now();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilAppIsActive(timeoutMs: number): Promise<void> {
  if (AppState.currentState === 'active') return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      sub.remove();
      resolve();
    }, timeoutMs);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        clearTimeout(timer);
        sub.remove();
        resolve();
      }
    });
  });
}

/** Stop expo-av from owning the session, then really deactivate AVAudioSession. */
export async function releaseIosAudioSessionForHms(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    await Audio.setIsEnabledAsync(false);
  } catch {
    // expo-av may already be disabled
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    if (deactivateMeetingAudioSession()) break;
    await delay(200);
  }
  try {
    await Audio.setIsEnabledAsync(true);
  } catch {
    // Playback outside the meeting still works if this fails.
  }
}

/**
 * Call after HMS has been unmounted. The next preview waits on this so it does not
 * start while the previous WebRTC audio unit still holds the session.
 */
export function scheduleIosAudioReleaseAfterHmsLeave(): void {
  if (Platform.OS !== 'ios') return;
  const job = delay(450).then(() => releaseIosAudioSessionForHms());
  releaseGate = releaseGate.then(() => job, () => job);
}

/** Run after mic permission is granted and before HMSPrebuilt mounts. */
export async function prepareIosAudioForHmsPreview(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  await releaseGate;
  await waitUntilAppIsActive(2000);
  // Permission dialogs and Control Center leave the session interrupted for a beat
  // after AppState flips back to active. Starting preview in that window is 3015.
  if (Date.now() - lastInactiveAt < 1500) {
    await delay(400);
  }
  await releaseIosAudioSessionForHms();
}

/**
 * Android: keep the previous speakerphone audio mode.
 * iOS in-call: re-activate the session without changing category. expo-av's
 * PlayAndRecord/DoNotMix fights HMS and causes error 3015.
 */
export async function restoreHmsCallAudioMode(): Promise<void> {
  if (Platform.OS === 'web') return;
  if (Platform.OS === 'ios') {
    reactivateMeetingAudioSession();
    return;
  }
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
