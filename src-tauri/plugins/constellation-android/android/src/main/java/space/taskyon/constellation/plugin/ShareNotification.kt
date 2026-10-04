package space.taskyon.constellation.plugin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

internal object ShareServiceContract {
  @Volatile var currentStatus: String? = null
  @Volatile var serviceRunning: Boolean = false
  @Volatile var startPending: Boolean = false
  @Volatile var networkRestriction: String? = null
  @Volatile var sampling: String = "balanced"
  const val ACTION_START = "space.taskyon.constellation.START_LOCATION_SHARE"
  const val ACTION_RESTORE = "space.taskyon.constellation.RESTORE_LOCATION_SHARES"
  const val ACTION_STOP_SHARE = "space.taskyon.constellation.STOP_LOCATION_SHARE_LINK"
  const val ACTION_SET_VISIBLE = "space.taskyon.constellation.SET_LOCATION_SHARING_VISIBILITY"
  const val ACTION_SET_VIEWER_NAME = "space.taskyon.constellation.SET_LOCATION_VIEWER_NAME"
  const val ACTION_STOP = "space.taskyon.constellation.STOP_LOCATION_SHARE"
  const val ACTION_BLOCK_VIEWER = "space.taskyon.constellation.BLOCK_LOCATION_VIEWER"
  const val ACTION_APPROVE_RETURN_LINK = "space.taskyon.constellation.APPROVE_RETURN_LINK"
  const val ACTION_DISMISS_RETURN_OFFER = "space.taskyon.constellation.DISMISS_RETURN_OFFER"
  const val ACTION_COMMAND_COMPLETE = "space.taskyon.constellation.RETURN_COMMAND_COMPLETE"
  const val EXTRA_REQUEST_ID = "space.taskyon.constellation.REQUEST_ID"
  const val EXTRA_ERROR = "space.taskyon.constellation.COMMAND_ERROR"
  const val EXTRA_REQUEST = "space.taskyon.constellation.SHARE_REQUEST"
  const val EXTRA_VISIBLE = "space.taskyon.constellation.VISIBLE"
  const val EXTRA_SHARE_ID = "space.taskyon.constellation.SHARE_ID"
  const val EXTRA_FINGERPRINT = "space.taskyon.constellation.VIEWER_FINGERPRINT"
  const val EXTRA_NAME = "space.taskyon.constellation.VIEWER_NAME"
  const val CHANNEL_ID = "constellation-location-share-v1"
  const val NOTIFICATION_ID = 4107
}

internal object ShareNotification {
  fun build(context: Context, body: String, sharing: Boolean = true): Notification {
    ensureChannel(context)
    val stopIntent = Intent(context, LocationShareService::class.java)
      .setAction(ShareServiceContract.ACTION_STOP)
    val stopPending = PendingIntent.getService(
      context,
      ShareServiceContract.NOTIFICATION_ID,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = NotificationCompat.Builder(context, ShareServiceContract.CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_constellation)
      .setContentTitle(if (sharing) "Constellation is sharing your location" else "Constellation is sending ended-link notices")
      .setContentText(body)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .addAction(0, if (sharing) "Stop sharing" else "Stop notices", stopPending)
    context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
      launch.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      builder.setContentIntent(PendingIntent.getActivity(
        context,
        ShareServiceContract.NOTIFICATION_ID,
        launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      ))
    }
    return builder.build()
  }

  fun update(context: Context, body: String, sharing: Boolean = true) {
    context.getSystemService(NotificationManager::class.java)
      .notify(ShareServiceContract.NOTIFICATION_ID, build(context, body, sharing))
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      ShareServiceContract.CHANNEL_ID,
      "Active location sharing",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      enableVibration(false)
      setSound(null, null)
      setShowBadge(false)
    }
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }
}
