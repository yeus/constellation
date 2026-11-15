package space.taskyon.constellation.plugin

import android.content.BroadcastReceiver
import android.location.LocationManager
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationManagerCompat

/** Restore only opt-in, persisted services; no location or secret is read before unlock. */
class RestoreReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action !in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) return
    val pending = goAsync()
    Thread {
      try {
        val journal = ReliabilityJournal(context)
        val fence = ReceiverOwnershipFence(context).snapshot()
        val store = EncryptedShareStore(context, discardUnreadable = false)
        // A stale service ownership fence is not permission to restore an opted-out
        // receiver. Missing native preference is fail-closed pending migration.
        val notificationsAllowed = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
          (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        val receiving = fence.owner == "service" && store.loadFollowingPreference() == true && notificationsAllowed
        val publishing = runCatching { store.hasBackgroundShares() }.getOrDefault(false)
        // Boot/package-replaced are background FGS start exemptions, but a
        // location-type service still needs a background-location grant and GPS on.
        val allowedLocation = (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
          ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED) &&
          context.getSystemService(LocationManager::class.java).isLocationEnabled
        val canStart = (publishing && allowedLocation && notificationsAllowed) || receiving
        if (canStart) {
          val restore = Intent(context, LocationShareService::class.java)
            .setAction(ShareServiceContract.ACTION_RESTORE)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(restore)
          else context.startService(restore)
        }
        journal.record("service.restore.broadcast", "reason=${if (intent.action == Intent.ACTION_BOOT_COMPLETED) "boot" else "update"};following=$receiving;sharing=$publishing;started=$canStart")
        Log.i("ConstellationRestore", "${intent.action}: following=$receiving sharing=$publishing started=$canStart")
      } catch (error: Exception) {
        runCatching { ReliabilityJournal(context).record("service.restore.deferred", "error=${error.javaClass.simpleName}") }
        Log.w("ConstellationRestore", "Restore deferred: ${error.javaClass.simpleName}")
      } finally {
        pending.finish()
      }
    }.start()
  }
}
