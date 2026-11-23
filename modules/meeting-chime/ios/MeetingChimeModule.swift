import AudioToolbox
import AVFoundation
import ExpoModulesCore

/// System sounds (unlike AVAudioPlayer / expo-av) are muted by the Ring/Silent switch and
/// play at ringer volume, and they never touch the app's AVAudioSession — so the chime
/// can't disturb the 100ms call audio.
public class MeetingChimeModule: Module {
  private var soundId: SystemSoundID = 0

  public func definition() -> ModuleDefinition {
    Name("MeetingChime")

    Function("playJoinChime") { () -> Bool in
      guard let id = self.loadSoundId() else { return false }
      AudioServicesPlaySystemSound(id)
      return true
    }

    // expo-av never calls setActive(false) (expo/expo#15873), so a previous recording
    // or call leaves AVAudioSession exclusive and HMS preview fails with error 3015.
    Function("deactivateAudioSession") { () -> Bool in
      Self.onMain {
        do {
          try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
          return true
        } catch {
          return false
        }
      }
    }

    Function("reactivateAudioSession") { () -> Bool in
      Self.onMain {
        do {
          try AVAudioSession.sharedInstance().setActive(true)
          return true
        } catch {
          return false
        }
      }
    }

    OnDestroy {
      if self.soundId != 0 {
        AudioServicesDisposeSystemSoundID(self.soundId)
        self.soundId = 0
      }
    }
  }

  private func loadSoundId() -> SystemSoundID? {
    if soundId != 0 { return soundId }
    guard let url = Self.chimeURL() else { return nil }
    var id: SystemSoundID = 0
    let status = AudioServicesCreateSystemSoundID(url as CFURL, &id)
    guard status == kAudioServicesNoError, id != 0 else { return nil }
    soundId = id
    return id
  }

  private static func onMain<T>(_ work: () -> T) -> T {
    if Thread.isMainThread {
      return work()
    }
    return DispatchQueue.main.sync(execute: work)
  }

  private static func chimeURL() -> URL? {
    let name = "meeting_join_chime"
    let candidates = [Bundle.main, Bundle(for: MeetingChimeModule.self)]
    for bundle in candidates {
      if let resourceBundleURL = bundle.url(forResource: "MeetingChime", withExtension: "bundle"),
         let resourceBundle = Bundle(url: resourceBundleURL),
         let url = resourceBundle.url(forResource: name, withExtension: "wav") {
        return url
      }
      if let url = bundle.url(forResource: name, withExtension: "wav") {
        return url
      }
    }
    return nil
  }
}
