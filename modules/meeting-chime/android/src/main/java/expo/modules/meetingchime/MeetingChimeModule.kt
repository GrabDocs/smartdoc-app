package expo.modules.meetingchime

import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Plays the join chime only when the phone would ring for a notification:
 * ringer mode normal, notification volume above zero, and Do Not Disturb off.
 * Uses the notification stream so the user's notification volume applies.
 */
class MeetingChimeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MeetingChime")

    Function("playJoinChime") {
      val context = appContext.reactContext ?: return@Function false
      if (!ringerAllowsChime(context)) return@Function false
      playChime(context)
    }
  }

  private fun ringerAllowsChime(context: Context): Boolean {
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      ?: return false
    if (audioManager.ringerMode != AudioManager.RINGER_MODE_NORMAL) return false
    if (audioManager.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == 0) return false

    val notificationManager =
      context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
    val filter = notificationManager?.currentInterruptionFilter
      ?: NotificationManager.INTERRUPTION_FILTER_ALL
    return filter == NotificationManager.INTERRUPTION_FILTER_ALL ||
      filter == NotificationManager.INTERRUPTION_FILTER_UNKNOWN
  }

  private fun playChime(context: Context): Boolean {
    val resId = context.resources.getIdentifier("meeting_join_chime", "raw", context.packageName)
    if (resId == 0) return false

    return try {
      val afd = context.resources.openRawResourceFd(resId) ?: return false
      val player = MediaPlayer()
      player.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build()
      )
      afd.use { player.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
      player.setOnCompletionListener { it.release() }
      player.setOnErrorListener { mp, _, _ ->
        mp.release()
        true
      }
      player.prepare()
      player.start()
      true
    } catch (e: Exception) {
      false
    }
  }
}
