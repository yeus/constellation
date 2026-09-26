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

@InvokeArg
class PrivateStateArgs {
  var state: String = ""
}

@InvokeArg
class BlockViewerArgs {
  var shareId: String = ""
  var fingerprint: String = ""
}

@InvokeArg
class ShareIdArgs {
  var shareId: String = ""
}

@InvokeArg
class ViewerNameArgs {
  var shareId: String = ""
  var fingerprint: String = ""
  var name: String = ""
}

@InvokeArg
class VisibilityArgs {
  var visible: Boolean = false
}

@TauriPlugin
class ConstellationAndroidPlugin(private val activity: Activity) : Plugin(activity) {
  private val store by lazy {
    EncryptedShareStore(activity.applicationContext, discardUnreadable = false)
  }
  private val privateStore by lazy {
    EncryptedShareStore(
      activity.applicationContext,
      "private-ui-state-v1",
      "constellation-private-ui-state-v1",
      false,
    )
  }

  @Command
  fun takeSharedText(invoke: Invoke) {
    val intent = activity.intent
    val text = if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
      intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.length <= 8192 }
    } else null
    if (intent?.action == Intent.ACTION_SEND) {
      intent.removeExtra(Intent.EXTRA_TEXT)
      intent.action = Intent.ACTION_MAIN
    }
    val result = JSObject()
    result.put("text", text ?: "")
    invoke.resolve(result)
  }

  @Command
  fun loadPrivateState(invoke: Invoke) {
    try {
      val result = JSObject()
      result.put("state", privateStore.loadPrivateState() ?: "")
      invoke.resolve(result)
    } catch (_: Exception) {
      invoke.reject("Protected location state could not be opened.")
    }
  }

  @Command
  fun savePrivateState(invoke: Invoke) {
    try {
      val state = invoke.parseArgs(PrivateStateArgs::class.java).state
      JSONObject(state)
      privateStore.savePrivateState(state)
      invoke.resolve(JSObject())
    } catch (_: Exception) {
      invoke.reject("Protected location state could not be saved.")
    }
  }

  @Command
  fun startBackgroundShare(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(BackgroundShareArgs::class.java)
      val request = validateRequest(args.request)
      requireLocationPermission(request.optString("publication") == "background")
      requireNotificationPermission()
      val initial = if (serviceRunning()) {
        ShareServiceContract.currentStatus ?: store.loadStatus() ?: STARTING_STATUS
      } else {
        STARTING_STATUS
      }
      ensureService(ShareServiceContract.ACTION_START, request = request.toString())
      invoke.resolve(JSObject(initial))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not start background location sharing.")
    }
  }

  @Command
  fun backgroundShareStatus(invoke: Invoke) {
    try {
      val stored = ShareServiceContract.currentStatus ?: store.loadStatus() ?: STOPPED_STATUS
      if (!serviceRunning() && store.hasBackgroundShares()) {
        store.saveStatus(STARTING_STATUS)
        ShareServiceContract.currentStatus = STARTING_STATUS
        ensureService(ShareServiceContract.ACTION_RESTORE)
        invoke.resolve(JSObject(STARTING_STATUS))
      } else {
        val state = runCatching { JSONObject(stored).optString("state") }.getOrDefault("error")
        if (serviceRunning() && ShareServiceContract.currentStatus == null) {
          invoke.resolve(JSObject(STARTING_STATUS))
        } else if (!serviceRunning() && state in setOf("sharing", "starting")) {
          invoke.resolve(JSObject(INTERRUPTED_STATUS))
        } else if (!serviceRunning()) {
          val normalized = JSONObject(stored)
          if (!normalized.has("shares")) normalized.put("shares", org.json.JSONArray())
          normalized.remove("share")
          invoke.resolve(JSObject(normalized))
        } else {
          invoke.resolve(JSObject(stored))
        }
      }
    } catch (_: Exception) {
      invoke.reject("Could not read background sharing status.")
    }
  }

  @Command
  fun stopBackgroundShare(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ShareIdArgs::class.java)
      check(args.shareId.matches(Regex("[A-Za-z0-9_-]{16,64}"))) { "Invalid share ID." }
      ensureService(ShareServiceContract.ACTION_STOP_SHARE, shareId = args.shareId)
      invoke.resolve(JSObject(ShareServiceContract.currentStatus ?: STARTING_STATUS))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not revoke this location link.")
    }
  }

  @Command
  fun setBackgroundVisibility(invoke: Invoke) {
    try {
      val visible = invoke.parseArgs(VisibilityArgs::class.java).visible
      if (!serviceRunning() && visible && store.hasSavedShares()) {
        ensureService(ShareServiceContract.ACTION_RESTORE)
        ensureService(ShareServiceContract.ACTION_SET_VISIBLE, visible = true)
      } else if (serviceRunning()) {
        activity.startService(
          Intent(activity, LocationShareService::class.java)
            .setAction(ShareServiceContract.ACTION_SET_VISIBLE)
            .putExtra(ShareServiceContract.EXTRA_VISIBLE, visible),
        )
      }
      invoke.resolve(JSObject())
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not update sharing visibility.")
    }
  }

  @Command
  fun importSourceState(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PrivateStateArgs::class.java)
      importSourceState(args.state)
      invoke.resolve(JSObject())
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not move Android source links to protected storage.")
    }
  }

  @Command
  fun blockBackgroundViewer(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(BlockViewerArgs::class.java)
      check(args.shareId.matches(Regex("[A-Za-z0-9_-]{16,64}"))) { "Invalid share ID." }
      check(args.fingerprint.matches(Regex("[A-Za-z0-9_-]{1,32}"))) {
        "Invalid device fingerprint."
      }
      ensureService(
        ShareServiceContract.ACTION_BLOCK_VIEWER,
        shareId = args.shareId,
        fingerprint = args.fingerprint,
      )
      invoke.resolve(JSObject(ShareServiceContract.currentStatus ?: STARTING_STATUS))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not block this device.")
    }
  }

  @Command
  fun setBackgroundViewerName(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ViewerNameArgs::class.java)
      check(args.shareId.matches(Regex("[A-Za-z0-9_-]{16,64}"))) { "Invalid share ID." }
      check(args.fingerprint.matches(Regex("[A-Za-z0-9_-]{1,32}"))) {
        "Invalid device fingerprint."
      }
      check(args.name.length <= 32) { "Device name is invalid." }
      ensureService(
        ShareServiceContract.ACTION_SET_VIEWER_NAME,
        shareId = args.shareId,
        fingerprint = args.fingerprint,
        name = args.name,
      )
      invoke.resolve(JSObject(ShareServiceContract.currentStatus ?: STARTING_STATUS))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not save this device name.")
    }
  }

  private fun ensureService(
    action: String,
    request: String? = null,
    shareId: String? = null,
    fingerprint: String? = null,
    name: String? = null,
    visible: Boolean? = null,
  ) {
    val intent = Intent(activity, LocationShareService::class.java).setAction(action)
    request?.let { intent.putExtra(ShareServiceContract.EXTRA_REQUEST, it) }
    shareId?.let { intent.putExtra(ShareServiceContract.EXTRA_SHARE_ID, it) }
    fingerprint?.let { intent.putExtra(ShareServiceContract.EXTRA_FINGERPRINT, it) }
    name?.let { intent.putExtra(ShareServiceContract.EXTRA_NAME, it) }
    visible?.let { intent.putExtra(ShareServiceContract.EXTRA_VISIBLE, it) }
    ContextCompat.startForegroundService(activity, intent)
  }

  private fun importSourceState(encoded: String) {
    require(encoded.isNotBlank() && encoded.length <= 131_072) { "Protected source state is invalid." }
    val incoming = JSONObject(encoded)
    require(incoming.optInt("version") == 1) { "Protected source state version is unsupported." }
    require(incoming.optString("privateKey").length in 40..1_024) {
      "Protected source identity is invalid."
    }
    val incomingShares = incoming.optJSONArray("shares")
      ?: throw IllegalArgumentException("Protected source links are invalid.")
    require(incomingShares.length() <= 128) { "Too many source links to migrate." }
    val existing = store.loadPrivateState()?.let(::JSONObject)
    val existingShares = existing?.optJSONArray("shares")?.length() ?: 0
    if (existingShares > 0) {
      check(existing?.optString("privateKey") == incoming.optString("privateKey")) {
        "Android source links already use a different protected identity."
      }
      return
    }
    store.savePrivateState(incoming.toString())
  }

  private fun requireLocationPermission(background: Boolean) {
    check(ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED) {
      "Allow precise location before starting a share."
    }
    if (background && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
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

  private fun requireNotificationPermission() {
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
      throw IllegalStateException("Allow notifications, then create the share again.")
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
    require(request.optString("precision") in setOf("exact", "approximate", "very-coarse")) {
      "Background share precision is invalid."
    }
    require(request.optString("publication") in setOf("foreground", "background")) {
      "Location publication mode is invalid."
    }
    require(request.opt("visible") is Boolean) { "Location sharing visibility is invalid." }
    val capacity = request.opt("viewerCapacity")
    require(capacity == "unlimited" || capacity is Number && capacity.toInt() in 1..128) {
      "Background share capacity is invalid."
    }
    require(request.optString("name").length <= 32) { "Background share name is invalid." }
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
    const val STARTING_STATUS = "{\"state\":\"starting\",\"shares\":[],\"location\":{\"status\":\"acquiring\"},\"message\":\"Restoring private P2P sharing…\"}"
    const val STOPPED_STATUS = "{\"state\":\"stopped\",\"shares\":[],\"location\":{\"status\":\"unavailable\"},\"message\":\"\"}"
    const val INTERRUPTED_STATUS = "{\"state\":\"error\",\"shares\":[],\"location\":{\"status\":\"unavailable\"},\"message\":\"Background sharing could not be restored from protected state.\"}"
    const val NOTIFICATION_PERMISSION_REQUEST = 4108
  }
}
