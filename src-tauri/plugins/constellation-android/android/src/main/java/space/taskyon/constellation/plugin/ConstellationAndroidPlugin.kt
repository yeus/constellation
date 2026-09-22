package space.taskyon.constellation.plugin

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.net.Uri
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class BackgroundShareArgs {
  var request: String = ""
}

@TauriPlugin
class ConstellationAndroidPlugin(private val activity: Activity) : Plugin(activity) {
  private val store by lazy { EncryptedShareStore(activity.applicationContext) }

  @Command
  fun startBackgroundShare(invoke: Invoke) {
    try {
      requireLocationPermission()
      requestNotificationPermission()
      check(!serviceRunning()) { "Stop the current Android share before creating another." }
      val args = invoke.parseArgs(BackgroundShareArgs::class.java)
      val request = validateRequest(args.request)
      store.saveRequest(request.toString())
      store.saveStatus(STARTING_STATUS)
      val intent = Intent(activity, LocationShareService::class.java)
        .setAction(ShareServiceContract.ACTION_START)
        .putExtra(ShareServiceContract.EXTRA_REQUEST, request.toString())
      ContextCompat.startForegroundService(activity, intent)
      invoke.resolve(JSObject(STARTING_STATUS))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not start background location sharing.")
    }
  }

  @Command
  fun backgroundShareStatus(invoke: Invoke) {
    try {
      val stored = store.loadStatus() ?: STOPPED_STATUS
      val state = runCatching { JSONObject(stored).optString("state") }.getOrDefault("error")
      if (state in setOf("sharing", "paused") && !serviceRunning()) {
        store.clear()
        store.saveStatus(INTERRUPTED_STATUS)
        invoke.resolve(JSObject(INTERRUPTED_STATUS))
      } else {
        invoke.resolve(JSObject(stored))
      }
    } catch (_: Exception) {
      invoke.reject("Could not read background sharing status.")
    }
  }

  @Command
  fun stopBackgroundShare(invoke: Invoke) {
    try {
      activity.startService(
        Intent(activity, LocationShareService::class.java)
          .setAction(ShareServiceContract.ACTION_STOP),
      )
      invoke.resolve(JSObject(STOPPED_STATUS))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not stop background location sharing.")
    }
  }

  private fun requireLocationPermission() {
    check(ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED) {
      "Allow precise location before starting a share."
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      if (ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_BACKGROUND_LOCATION) !=
        PackageManager.PERMISSION_GRANTED) {
        activity.startActivity(
          Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:${activity.packageName}"),
          ),
        )
        throw IllegalStateException(
          "Choose Permissions, Location, and Allow all the time; then return and create the share again.",
        )
      }
    }
  }

  private fun requestNotificationPermission() {
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        NOTIFICATION_PERMISSION_REQUEST,
      )
    }
  }

  @Suppress("DEPRECATION")
  private fun serviceRunning(): Boolean {
    val manager = activity.getSystemService(ActivityManager::class.java)
    return manager.getRunningServices(Int.MAX_VALUE).any {
      it.service.className == LocationShareService::class.java.name
    }
  }

  private fun validateRequest(encoded: String): JSONObject {
    require(encoded.isNotBlank() && encoded.length <= 4096) { "Background share request is invalid." }
    val request = JSONObject(encoded)
    require(request.optString("precision") in setOf("exact", "approximate")) {
      "Background share precision is invalid."
    }
    val capacity = request.opt("viewerCapacity")
    require(capacity == "unlimited" || capacity is Number && capacity.toInt() in 1..128) {
      "Background share capacity is invalid."
    }
    val expiresAt = if (request.isNull("expiresAt")) null else request.optLong("expiresAt")
    require(expiresAt == null || expiresAt > System.currentTimeMillis()) {
      "Background share has already expired."
    }
    val baseUrl = request.optString("shareBaseUrl")
    require(baseUrl.startsWith("https://") || baseUrl.startsWith("http://127.0.0.1")) {
      "Background share URL is invalid."
    }
    return request
  }

  private companion object {
    const val STARTING_STATUS = "{\"state\":\"starting\",\"location\":{\"status\":\"acquiring\"},\"message\":\"Starting private P2P sharing…\"}"
    const val STOPPED_STATUS = "{\"state\":\"stopped\",\"location\":{\"status\":\"unavailable\"},\"message\":\"\"}"
    const val INTERRUPTED_STATUS = "{\"state\":\"error\",\"location\":{\"status\":\"unavailable\"},\"message\":\"Background sharing was interrupted and stopped. Create a new link to resume.\"}"
    const val NOTIFICATION_PERMISSION_REQUEST = 4108
  }
}
