package space.taskyon.constellation.plugin

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import java.util.UUID
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.net.Uri
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
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
class ReturnApprovalArgs {
  var shareId: String = ""
  var peerId: String = ""
}

@InvokeArg
class SharingBehaviorArgs {
  lateinit var behavior: JSObject
}

@InvokeArg
class ClearOldPeersArgs {
  lateinit var protection: JSObject
}

@InvokeArg
class AdoptPeerNameArgs {
  var peerId: String = ""
  var name: String = ""
}

@InvokeArg
class PeerNameArgs {
  var peerId: String = ""
  var associateNames: Boolean = false
  var sharedName: String? = null
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

@InvokeArg
class AndroidPositionOptions {
  var enableHighAccuracy: Boolean = true
  var timeout: Long = 20_000
  var maximumAge: Long = 0
}

@InvokeArg
class AndroidWatchArgs {
  var options: AndroidPositionOptions = AndroidPositionOptions()
  lateinit var channel: Channel
}

@InvokeArg
class AndroidCurrentArgs {
  var options: AndroidPositionOptions = AndroidPositionOptions()
}

@InvokeArg
class AndroidWatchIdArgs {
  var watchId: Long = 0
}
@InvokeArg
class ProjectLinkArgs {
  var target: String = ""
}


@TauriPlugin(permissions = [Permission(
  strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION],
  alias = "location",
), Permission(strings = [Manifest.permission.ACCESS_BACKGROUND_LOCATION], alias = "backgroundLocation"),
Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class ConstellationAndroidPlugin(private val activity: Activity) : Plugin(activity) {
  private val locationManager by lazy { activity.getSystemService(LocationManager::class.java) }
  private val locationHandler = Handler(Looper.getMainLooper())
  private val locationWatches = mutableMapOf<Long, Pair<Channel, LocationListener>>()
  private var cancelCurrentLocation: (() -> Unit)? = null
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

  private fun locationPermissionResult(): JSObject = JSObject()
    .put("grant", locationGrant(activity))
    .put("servicesEnabled", locationManager.isLocationEnabled)

  private fun sharingSetupResult(): JSObject {
    val saved = store.loadPrivateState()?.let(::JSONObject)
    return JSObject().put("behavior", saved?.optJSONObject("sharingBehavior") ?: JSONObject.NULL)
      .put("hasShares", (saved?.optJSONArray("shares")?.length() ?: 0) > 0)
      .put("permissions", JSONObject()
        .put("location", locationGrant(activity) != "none")
        .put("background", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
          ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED)
        .put("notifications", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
          ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        .put("servicesEnabled", locationManager.isLocationEnabled))
  }

  @Command
  fun sharingSetup(invoke: Invoke) {
    try { invoke.resolve(sharingSetupResult()) }
    catch (_: Exception) { invoke.reject("Could not read protected sharing settings.") }
  }

  @Command
  fun enableSharingPermissions(invoke: Invoke) {
    if (locationGrant(activity) == "none")
      requestPermissionForAlias("location", invoke, "sharingLocationPermissionCallback")
    else requestSharingNotifications(invoke)
  }

  @PermissionCallback
  private fun sharingLocationPermissionCallback(invoke: Invoke) {
    if (locationGrant(activity) == "none") invoke.resolve(sharingSetupResult())
    else requestSharingNotifications(invoke)
  }

  private fun requestSharingNotifications(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
      requestPermissionForAlias("notifications", invoke, "sharingNotificationsPermissionCallback")
    else requestSharingBackground(invoke)
  }

  @PermissionCallback
  private fun sharingNotificationsPermissionCallback(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
      invoke.resolve(sharingSetupResult())
    else requestSharingBackground(invoke)
  }

  private fun requestSharingBackground(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) {
        requestPermissionForAlias("backgroundLocation", invoke, "sharingBackgroundPermissionCallback")
        return
      }
      activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}")))
    }
    invoke.resolve(sharingSetupResult())
  }

  @PermissionCallback
  private fun sharingBackgroundPermissionCallback(invoke: Invoke) { invoke.resolve(sharingSetupResult()) }

  @Command
  fun setSharingBehavior(invoke: Invoke) {
    try {
      val behavior = invoke.parseArgs(SharingBehaviorArgs::class.java).behavior
      check(behavior.optString("publication") in setOf("foreground", "background")) { "Invalid publication." }
      check(behavior.optString("battery") in setOf("balanced", "saver")) { "Invalid battery policy." }
      check(behavior.optString("network") in setOf("always", "pause-when-metered")) { "Invalid network policy." }
      if (behavior.optString("publication") == "background") {
        val permissions = sharingSetupResult().getJSONObject("permissions")
        check(listOf("location", "background", "notifications", "servicesEnabled").all { permissions.getBoolean(it) }) {
          "Enable location, background location and notifications before background sharing."
        }
      }
      val request = JSONObject().put("behavior", behavior)
      runReturnCommand(invoke, ShareServiceContract.ACTION_SET_SHARING_BEHAVIOR, "", request = request.toString())
    } catch (_: Exception) { invoke.reject("Sharing settings could not be saved. Check permissions and retry.") }
  }

  @Command
  fun openProjectLink(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ProjectLinkArgs::class.java)
      val url = when (args.target) {
        "project" -> "https://github.com/yeus/constellation"
        "release" -> "https://github.com/yeus/constellation/releases/latest"
        else -> throw IllegalArgumentException("Unknown public destination.")
      }
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(intent)
      invoke.resolve(JSObject())
    } catch (_: Exception) {
      invoke.reject("No external browser could open the project link.")
    }
  }

  @Command
  fun locationPermission(invoke: Invoke) {
    invoke.resolve(locationPermissionResult())
  }

  @PermissionCallback
  private fun locationPermissionCallback(invoke: Invoke) {
    locationPermission(invoke)
  }

  @Command
  fun requestLocationPermission(invoke: Invoke) {
    if (!locationManager.isLocationEnabled || locationGrant(activity) != "none") {
      locationPermission(invoke)
    } else {
      requestPermissionForAlias("location", invoke, "locationPermissionCallback")
    }
  }

  @Command
  fun startLocationWatch(invoke: Invoke) {
    val args = invoke.parseArgs(AndroidWatchArgs::class.java)
    activity.runOnUiThread {
      if (locationGrant(activity) == "none" || !locationManager.isLocationEnabled) {
        invoke.reject("Location access is unavailable.")
        return@runOnUiThread
      }
      val listener = androidLocationListener(onLocationChanged = { location ->
        args.channel.send(JSObject().put("position", locationPositionJson(location)))
      })
      if (!watchAndroidLocation(locationManager, listener, 5_000, 0f)) {
        invoke.reject("No permitted Android location provider is available.")
        return@runOnUiThread
      }
      locationWatches[args.channel.id] = args.channel to listener
      invoke.resolve(JSObject().put("watchId", args.channel.id))
    }
  }

  @Command
  fun stopLocationWatch(invoke: Invoke) {
    val watchId = invoke.parseArgs(AndroidWatchIdArgs::class.java).watchId
    activity.runOnUiThread {
      locationWatches.remove(watchId)?.let { locationManager.removeUpdates(it.second) }
      invoke.resolve()
    }
  }

  @Command
  fun currentLocation(invoke: Invoke) {
    val options = invoke.parseArgs(AndroidCurrentArgs::class.java).options
    activity.runOnUiThread { acquireCurrentLocation(invoke, options) }
  }

  private fun acquireCurrentLocation(invoke: Invoke, options: AndroidPositionOptions) {
    if (locationGrant(activity) == "none" || !locationManager.isLocationEnabled) {
      invoke.reject("Location access is unavailable.")
      return
    }
    val cached = availableLocationProviders(locationManager)
      .mapNotNull { runCatching { locationManager.getLastKnownLocation(it) }.getOrNull() }
      .filter { location ->
        options.maximumAge > 0 &&
          (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000 <=
          options.maximumAge
      }
      .maxByOrNull { it.elapsedRealtimeNanos }
    if (cached != null) {
      invoke.resolve(JSObject(locationPositionJson(cached), arrayOf("timestamp", "coords")))
      return
    }
    cancelCurrentLocation?.invoke()
    var completed = false
    lateinit var timeout: Runnable
    val listener = androidLocationListener(onLocationChanged = { location ->
      if (completed) return@androidLocationListener
      completed = true
      locationHandler.removeCallbacks(timeout)
      cancelCurrentLocation = null
      invoke.resolve(JSObject(locationPositionJson(location), arrayOf("timestamp", "coords")))
    })
    timeout = Runnable {
      if (completed) return@Runnable
      completed = true
      locationManager.removeUpdates(listener)
      cancelCurrentLocation = null
      invoke.reject("Location fix timed out.")
    }
    if (!watchAndroidLocation(locationManager, listener, 0, 0f)) {
      invoke.reject("No permitted Android location provider is available.")
      return
    }
    locationHandler.postDelayed(timeout, options.timeout.coerceIn(1_000, 20_000))
    cancelCurrentLocation = {
      locationHandler.removeCallbacks(timeout)
      locationManager.removeUpdates(listener)
      if (!completed) invoke.reject("Location request was cancelled.")
      completed = true
    }
  }

  override fun onPause() {
    super.onPause()
    locationWatches.values.forEach { locationManager.removeUpdates(it.second) }
    cancelCurrentLocation?.invoke()
    cancelCurrentLocation = null
  }

  override fun onResume() {
    super.onResume()
    val permissionRevoked = locationGrant(activity) == "none"
    if (permissionRevoked || !locationManager.isLocationEnabled) {
      val code = if (permissionRevoked) 1 else 4
      locationWatches.values.forEach { it.first.send(JSObject().put("error", code)) }
      locationWatches.clear()
    } else {
      locationWatches.values.forEach { (channel, listener) ->
        if (!watchAndroidLocation(locationManager, listener, 5_000, 0f)) {
          channel.send(JSObject().put("error", 2))
        }
      }
    }
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
    Log.i("ConstellationPersist", "native-save-invoked")
    try {
      val state = invoke.parseArgs(PrivateStateArgs::class.java).state
      JSONObject(state)
      privateStore.savePrivateState(state)
      Log.i("ConstellationPersist", "native-save-committed")
      invoke.resolve(JSObject())
      Log.i("ConstellationPersist", "native-save-resolved")
    } catch (_: Exception) {
      Log.i("ConstellationPersist", "native-save-failed")
      invoke.reject("Protected location state could not be saved.")
    }
  }

  @Command
  fun startBackgroundShare(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(BackgroundShareArgs::class.java)
      val request = validateRequest(args.request)
      requireLocationPermission(request.optString("publication") == "background")
      if (request.optString("publication") == "background") requireNotificationPermission()
      val running = serviceRunning()
      val initial = if (running) {
        JSONObject(ShareServiceContract.currentStatus ?: store.loadStatus() ?: STARTING_STATUS)
          .apply {
            // A new request must not acknowledge the previous creation's failure.
            // Keep the active grants, history and pending end notifications intact.
            if (optString("state") == "error") {
              put("state", "starting")
              put("peerStatus", "connecting")
              put("message", "")
            }
          }.toString()
      } else {
        STARTING_STATUS
      }
      ShareServiceContract.currentStatus = initial
      ShareServiceContract.startPending = true
      ensureService(ShareServiceContract.ACTION_START, request = request.toString())
      invoke.resolve(statusWithPolicy(initial))
    } catch (error: Exception) {
      ShareServiceContract.startPending = false
      invoke.reject(error.message ?: "Could not start background location sharing.")
    }
  }

  @Command
  fun backgroundShareStatus(invoke: Invoke) {
    try {
      val stored = ShareServiceContract.currentStatus ?: store.loadStatus() ?: STOPPED_STATUS
      val running = serviceRunning()
      val hasSavedShares = store.hasSavedShares()
      val hasBackgroundShares = store.hasBackgroundShares()
      val state = runCatching { JSONObject(stored).optString("state") }.getOrDefault("error")
      Log.i(
        "ConstellationStatus",
        "background-status running=$running has-saved=$hasSavedShares has-background=$hasBackgroundShares current=${ShareServiceContract.currentStatus != null} stored=$state",
      )
      if (ShareServiceContract.startPending && !running) {
        invoke.resolve(statusWithPolicy(STARTING_STATUS))
      } else if (!running && hasBackgroundShares) {
        ShareServiceContract.startPending = true
        store.saveStatus(STARTING_STATUS)
        ShareServiceContract.currentStatus = STARTING_STATUS
        ensureService(ShareServiceContract.ACTION_RESTORE)
        invoke.resolve(statusWithPolicy(STARTING_STATUS))
      } else {
        if (
          running &&
          ShareServiceContract.currentStatus == null &&
          (hasSavedShares || state in setOf("sharing", "starting", "paused"))
        ) {
          invoke.resolve(statusWithPolicy(STARTING_STATUS))
        } else if (!running && state in setOf("sharing", "starting")) {
          invoke.resolve(statusWithPolicy(INTERRUPTED_STATUS))
        } else if (!running) {
          val normalized = JSONObject(stored)
          if (!normalized.has("shares")) normalized.put("shares", org.json.JSONArray())
          normalized.remove("share")
          invoke.resolve(statusWithPolicy(normalized.toString()))
        } else {
          invoke.resolve(statusWithPolicy(stored))
        }
      }
    } catch (_: Exception) {
      invoke.reject("Could not read background sharing status.")
    }
  }

  private fun statusWithPolicy(json: String): JSObject {
    val status = runCatching { JSONObject(json) }.getOrNull() ?: JSONObject()
    store.loadPrivateState()?.let { JSONObject(it).optJSONObject("sharingBehavior") }
      ?.let { status.put("sharingBehavior", it) }
    if (!status.has("state")) status.put("state", "error")
    if (status.optString("state") !in setOf("starting", "sharing", "paused", "stopped", "error")) {
      status.put("state", "error")
    }
    if (!status.has("shares") || status.isNull("shares")) status.put("shares", org.json.JSONArray())
    if (status.opt("shares") !is org.json.JSONArray) status.put("shares", org.json.JSONArray())
    if (!status.has("message") || status.isNull("message")) status.put("message", "")
    if (status.opt("message") !is String) status.put("message", "")
    val location = status.optJSONObject("location")
    if (location == null || location.optString("status") !in setOf(
        "permission-required", "acquiring", "live", "delayed", "stale", "denied",
        "unavailable", "error",
      )
    ) {
      status.put("location", JSONObject().put("status", "unavailable"))
    }
    val shares = status.optJSONArray("shares")
    val pausedCount = (0 until (shares?.length() ?: 0)).count { index ->
      shares?.optJSONObject(index)?.isNull("paused") == false
    }
    if (pausedCount > 0) {
      ShareServiceContract.networkRestriction?.let { status.put("pauseReason", it) }
    }
    status.put("sampling", ShareServiceContract.sampling)
    return JSObject(status.toString())
  }

  @Command
  fun stopBackgroundShare(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ShareIdArgs::class.java)
      check(args.shareId.matches(Regex("[A-Za-z0-9_-]{16,64}"))) { "Invalid share ID." }
      ensureService(ShareServiceContract.ACTION_STOP_SHARE, shareId = args.shareId)
      invoke.resolve(statusWithPolicy(ShareServiceContract.currentStatus ?: STARTING_STATUS))
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
      val state = args.state
      check(state.isNotEmpty()) { "Missing source state." }
      check(state.length <= 131_072) { "Source state is too large." }
      val request = JSONObject().put("state", state)
      runReturnCommand(invoke, ShareServiceContract.ACTION_IMPORT_SOURCE_STATE, "", request = request.toString())
    } catch (_: Exception) { invoke.reject("Protected source links could not be imported.") }
  }

  @Command
  fun approveBackgroundReturnLink(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ShareIdArgs::class.java)
      check(args.shareId.matches(Regex("[A-Za-z0-9_-]{16,64}"))) { "Invalid share ID." }
      runReturnCommand(
        invoke,
        ShareServiceContract.ACTION_APPROVE_RETURN_LINK,
        args.shareId,
      )
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not approve return shares for this link.")
    }
  }

  @Command
  fun backgroundDeviceComparison(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(BackgroundShareArgs::class.java)
      check(args.request.length <= 1024) { "Invalid device comparison request." }
      val request = JSONObject(args.request)
      check(request.optString("shareId").matches(Regex("[A-Za-z0-9_-]{16,64}"))) { "Invalid share ID." }
      check(request.optString("challenge").matches(Regex("[A-Za-z0-9_-]{43}"))) { "Invalid comparison session." }
      check(request.optString("action") in setOf("confirm", "cancel")) { "Invalid comparison action." }
      runReturnCommand(invoke, ShareServiceContract.ACTION_DEVICE_COMPARISON, request.optString("shareId"), request = request.toString())
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not save device comparison.")
    }
  }

  @Command
  fun replaceBackgroundOwner(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(BackgroundShareArgs::class.java)
      check(args.request.length <= 2_048) { "Invalid owner request." }
      val request = JSONObject(args.request)
      check(request.optString("shareId").matches(Regex("[A-Za-z0-9_-]{16,64}"))) {
        "Invalid share ID."
      }
      check(request.optString("sourcePeerId").length in 1..256) { "Invalid source identity." }
      check(request.optString("ownerPeerId").length in 1..256) { "Invalid owner identity." }
      check(request.optString("ownerProof").matches(Regex("[A-Za-z0-9_-]{40,256}"))) {
        "Invalid owner proof."
      }
      when (request.optString("mode")) {
        "recipient" ->
          check(request.optString("recipientPeerId").length in 1..256) {
            "Invalid recipient identity."
          }
        "source" -> check(request.has("recipientPeerId").not()) { "Unexpected recipient identity." }
        else -> throw IllegalArgumentException("Invalid ownership mode.")
      }
      runReturnCommand(invoke, ShareServiceContract.ACTION_REPLACE_BACKGROUND_OWNER,
        request.optString("shareId"), request = request.toString())
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not authenticate the foreground location owner.")
    }
  }

  @Command
  fun approveBackgroundViewer(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ReturnApprovalArgs::class.java)
      check(args.shareId.matches(Regex("[A-Za-z0-9_-]{16,64}"))) { "Invalid share ID." }
      check(args.peerId.length in 1..256) { "Invalid peer identity." }
      runReturnCommand(
        invoke,
        ShareServiceContract.ACTION_APPROVE_VIEWER,
        args.shareId,
        peerId = args.peerId,
      )
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not approve this device.")
    }
  }

  @Command
  fun dismissBackgroundReturnOffer(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(BlockViewerArgs::class.java)
      check(args.shareId.matches(Regex("[A-Za-z0-9_-]{16,64}"))) { "Invalid share ID." }
      check(args.fingerprint.matches(Regex("[A-Za-z0-9_-]{1,32}"))) {
        "Invalid device fingerprint."
      }
      runReturnCommand(
        invoke, ShareServiceContract.ACTION_DISMISS_RETURN_OFFER, args.shareId, args.fingerprint,
      )
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not dismiss this return offer.")
    }
  }

  @Command
  fun dismissBackgroundStoppedViewer(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ReturnApprovalArgs::class.java)
      check(args.shareId.matches(Regex("[A-Za-z0-9_-]{16,64}"))) { "Invalid share ID." }
      check(args.peerId.length in 1..256) { "Invalid peer identity." }
      runReturnCommand(invoke, ShareServiceContract.ACTION_DISMISS_STOPPED_VIEWER,
        args.shareId, peerId = args.peerId)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not dismiss the stop notice.")
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
      invoke.resolve(statusWithPolicy(ShareServiceContract.currentStatus ?: STARTING_STATUS))
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
      invoke.resolve(statusWithPolicy(ShareServiceContract.currentStatus ?: STARTING_STATUS))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not save this device name.")
    }
  }

  @Command
  fun clearOldPeers(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ClearOldPeersArgs::class.java)
      for (key in listOf("peerIds", "shareIds")) {
        val ids = args.protection.getJSONArray(key)
        check(ids.length() <= 1024) { "Too many protected identities." }
        for (index in 0 until ids.length()) {
          val id = ids.getString(index)
          check(if (key == "peerIds") id.length in 1..256
            else id.matches(Regex("[A-Za-z0-9_-]{16,64}"))) { "Invalid protected identity." }
        }
      }
      val request = JSONObject().put("protection", args.protection)
      runReturnCommand(invoke, ShareServiceContract.ACTION_CLEAR_OLD_PEERS, "", request = request.toString())
    } catch (_: Exception) {
      invoke.reject("Could not clear old peers.")
    }
  }

  @Command
  fun adoptBackgroundPeerName(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(AdoptPeerNameArgs::class.java)
      check(args.peerId.length in 1..256 && args.name.trim().length in 1..32) {
        "Invalid name adoption."
      }
      val request = JSONObject().put("peerId", args.peerId).put("name", args.name.trim())
      runReturnCommand(invoke, ShareServiceContract.ACTION_ADOPT_PEER_NAME, "", request = request.toString())
    } catch (_: Exception) {
      invoke.reject("Could not adopt the advertised name.")
    }
  }

  @Command
  fun setBackgroundPeerNames(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PeerNameArgs::class.java)
      check(args.peerId.length in 1..256) { "Invalid peer identity." }
      check(args.sharedName == null || args.sharedName!!.trim().length in 1..32) { "Invalid display name." }
      val request = JSONObject().put("peerId", args.peerId)
        .put("associateNames", args.associateNames)
        .put("sharedName", args.sharedName ?: JSONObject.NULL)
      runReturnCommand(invoke, ShareServiceContract.ACTION_SET_PEER_NAMES, "", request = request.toString())
    } catch (_: Exception) {
      invoke.reject("Could not save peer name preferences.")
    }
  }

  private fun runReturnCommand(
    invoke: Invoke,
    action: String,
    shareId: String,
    fingerprint: String? = null,
    peerId: String? = null,
    request: String? = null,
  ) {
    val requestId = UUID.randomUUID().toString()
    val context = activity.applicationContext
    var completed = false
    lateinit var receiver: BroadcastReceiver
    lateinit var timeout: Runnable
    fun finish(error: String?) {
      if (completed) return
      completed = true
      locationHandler.removeCallbacks(timeout)
      context.unregisterReceiver(receiver)
      if (error == null) invoke.resolve(JSObject()) else invoke.reject(error)
    }
    receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST_ID) != requestId) return
        finish(intent.getStringExtra(ShareServiceContract.EXTRA_ERROR))
      }
    }
    timeout = Runnable { finish("The return-sharing change was not confirmed. Try again.") }
    ContextCompat.registerReceiver(
      context, receiver, IntentFilter(ShareServiceContract.ACTION_COMMAND_COMPLETE),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    locationHandler.postDelayed(timeout, 30_000L)
    try {
      ensureService(
        action,
        shareId = shareId,
        fingerprint = fingerprint,
        peerId = peerId,
        requestId = requestId,
        request = request,
      )
    } catch (_: Exception) {
      finish("Could not send the return-sharing change.")
    }
  }

  private fun ensureService(
    action: String,
    request: String? = null,
    shareId: String? = null,
    fingerprint: String? = null,
    peerId: String? = null,
    name: String? = null,
    visible: Boolean? = null,
    requestId: String? = null,
  ) {
    val intent = Intent(activity, LocationShareService::class.java).setAction(action)
    request?.let { intent.putExtra(ShareServiceContract.EXTRA_REQUEST, it) }
    requestId?.let { intent.putExtra(ShareServiceContract.EXTRA_REQUEST_ID, it) }
    shareId?.let { intent.putExtra(ShareServiceContract.EXTRA_SHARE_ID, it) }
    fingerprint?.let { intent.putExtra(ShareServiceContract.EXTRA_FINGERPRINT, it) }
    peerId?.let { intent.putExtra(ShareServiceContract.EXTRA_PEER_ID, it) }
    name?.let { intent.putExtra(ShareServiceContract.EXTRA_NAME, it) }
    visible?.let { intent.putExtra(ShareServiceContract.EXTRA_VISIBLE, it) }
    // First-run foreground-only settings must be savable before location is granted.
    if (action == ShareServiceContract.ACTION_SET_SHARING_BEHAVIOR && locationGrant(activity) == "none")
      activity.startService(intent)
    else ContextCompat.startForegroundService(activity, intent)
  }

  private fun requireLocationPermission(background: Boolean) {
    check(locationGrant(activity) != "none") {
      "Allow device location before starting a share."
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

  private fun serviceRunning(): Boolean = ShareServiceContract.serviceRunning

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
