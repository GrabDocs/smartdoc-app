# Picture-in-Picture (PiP) — Mobile Setup and Verification

This doc summarizes what is implemented for meeting PiP and how to verify/fix PiP on Android and iOS.

**Video preview in PiP:** The 100ms Room Kit (HMSPrebuilt) enables PiP video by default: when `autoEnterPipMode` is true, it configures PiP with `useActiveSpeaker: true` (iOS) so the active speaker's video is shown in the PiP window. On Android, the same meeting view is shown in the PiP window. **PiP window size:** Square (1:1) on both platforms via `pipConfig={{ aspectRatio: [1, 1] }}` on HMSPrebuilt.

## Root cause of "brief image then black" — fixed

The previous implementation called `GrabDocsPipModule.enterPipForMeeting()` proactively from the AppState listener **in addition to** HMS `autoEnterPipMode`. Both called `enterPictureInPictureMode()` in rapid succession:

1. HMS `autoEnterPipMode` (via `onUserLeaveHint`) enters PiP — video shows briefly.
2. Our module calls it again milliseconds later with different params — video surface is destroyed and recreated — **black screen**.

**Fix applied:**
- `GrabDocsPipModule.enterPipForMeeting()` is no longer called proactively. HMS `autoEnterPipMode` is the **sole PiP entry point** on Android.
- The AppState listener now only triggers on `'background'` (not `'inactive'`). On iOS, `inactive` fires during the app-switcher animation before backgrounding, which was disrupting the HMS PiP transition.
- After 2 seconds, we check `isInPipMode()` and fall back to a notification **only** if HMS PiP truly did not activate.
- iOS: added `"audio"` to `UIBackgroundModes` alongside `"voip"` — required on iOS 18+ for `AVCaptureSession.isMultitaskingCameraAccessEnabled` to allow camera in PiP/background.

## Why is video / user image not showing in PiP?

### iOS — video not showing

1. **Multitasking Camera Access not yet approved**
   You must request [Multitasking Camera Access](https://developer.apple.com/contact/request/multitasking-camera-access/) from Apple. While it is under review (or not yet added to the App ID), iOS will not allow camera access in PiP/background, so the PiP window will show a placeholder or black screen. There is no workaround; you need the entitlement approved and the App ID + provisioning profile to include it.
2. **After approval**
   In [Apple Developer Identifiers](https://developer.apple.com/account/resources/identifiers/list), enable Multitasking Camera Access on your App ID and regenerate or use a provisioning profile that includes it. Build with that profile (EAS or Xcode).

### Android — user image / video not showing

1. **Camera off at join time**
   The app joins with `enable_video: false`. PiP shows the active speaker or local tile; if no one has video on there is nothing to render. Turn the camera on in the meeting before switching apps.
2. **Emulator**
   Many Android emulators do not render video in PiP. Test on a physical device (API 26+).

## Android

### Implemented

- **Manifest:** `android:supportsPictureInPicture="true"` and `android:resizeableActivity="true"` on the main activity (via [plugins/android-pip.js](../plugins/android-pip.js) and [AndroidManifest.xml](../android/app/src/main/AndroidManifest.xml)).
- **100ms:** `HMSPrebuilt` with `autoEnterPipMode={true}`; MainActivity forwards `onUserLeaveHint()` and `onPictureInPictureModeChanged()` to `HMSManager`. HMS is the sole PiP entry point.
- **Notification fallback (2 s):** After backgrounding, if `isInPipMode()` returns false after 2 seconds, a "Tap to return" notification is shown. `GrabDocsPipModule.enterPipForMeeting()` is NOT called proactively.
- **Logging:** `GrabDocsPiP` logs in MainActivity (`onUserLeaveHint`, `onPictureInPictureModeChanged`) for debugging.

### Verification

1. Confirm [android/app/src/main/AndroidManifest.xml](../android/app/src/main/AndroidManifest.xml) has on the main activity:
   - `android:supportsPictureInPicture="true"`
   - `android:resizeableActivity="true"`
2. Test on a physical Android 10+ device (many emulators do not handle PiP correctly).
3. Join a meeting with camera on, then press Home or switch app.
4. Check logcat for `GrabDocsPiP` to confirm `onUserLeaveHint` and `onPictureInPictureModeChanged`.

---

## iOS

### Implemented

- **app.json:** `UIBackgroundModes: ["voip", "audio"]`; plugin [plugins/ios-pip.js](../plugins/ios-pip.js) adds the Multitasking Camera Access entitlement (`com.apple.developer.avfoundation.multitasking-camera-access`). The `"audio"` mode is required on iOS 18+ for `AVCaptureSession` to keep the camera running in PiP/background.
- **100ms:** `autoEnterPipMode={true}` on HMSPrebuilt; iOS PiP is handled entirely by the 100ms native PiP controller.

### Verification (production iOS PiP)

1. **Entitlement and provisioning profile**
   - Request Multitasking Camera Access from Apple: [Request here](https://developer.apple.com/contact/request/multitasking-camera-access/).
   - In Apple Developer Identifiers, enable Multitasking Camera Access on your App ID and save.
   - Regenerate the provisioning profile so it includes this capability, then build again.

2. **Background modes**
   - Confirm `Info.plist` (or `app.json` `infoPlist`) has `UIBackgroundModes` containing both `voip` and `audio`.

3. **Behavior**
   - iOS uses `AVPictureInPictureController`. PiP depends on: entitlement in the provisioning profile, correct AVAudioSession config from 100ms, and the `audio` background mode.

---

## Back vs background

- **Back / swipe (in-app):** Pushes the meeting list (or calendar) **on top of** the live HMS screen without unmounting it (`detachInactiveScreens: false`). The call stays connected; return via the Active meeting card or the “In GrabDocs meeting” notification (`router.navigate` pops back to the mounted screen). Explicit Leave still tears down HMS. No PiP for in-app back.
- **Home / app switch (backgrounded):** HMS `autoEnterPipMode` shows the meeting in a small PiP window. If PiP does not activate after 2 s, a "Tap to return" notification is shown.
