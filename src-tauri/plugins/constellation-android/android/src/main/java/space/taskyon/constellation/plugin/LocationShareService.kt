package space.taskyon.constellation.plugin

import android.Manifest
import android.app.ActivityManager
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

class LocationShareService : Service(), LocationListener {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val ioExecutor = Executors.newSingleThreadExecutor()
  private lateinit var store: EncryptedShareStore
  private lateinit var receiverFence: ReceiverOwnershipFence
  private var webView: WebView? = null
  private var runtimeStarting = false
  private val pendingCommandIds = mutableSetOf<String>()
  private val pendingPauseCommandIds = mutableSetOf<String>()
  private val pendingCommands = mutableListOf<JSONObject>()
  private val pendingReceiverStops = mutableMapOf<String, Long>()
  private val pendingCreateIds = mutableSetOf<String>()
  private var runtimeReady = false
  private var finishing = false
  private var lastPersistedStatus: String? = null
  private var lastShares: JSONArray? = null
  private var lastViewerCount = 0
  private var lastPaused = false
  private val viewingBudget = ViewingBoostBudget()
  private var activeViewingBoostUntil = 0L
  private val viewingBoostTimer = Runnable { updatePolicyState() }
  private var networkOnlyPolicy = false
  private var activeViewingBoostPolicy = true
  private fun reloadLocationPolicies() {
    val wasNetworkOnly = networkOnlyPolicy
    val loaded = runCatching { store.loadBehaviorPreference()?.let(::JSONObject) }
    if (loaded.isFailure) {
      // Unreadable power preferences must not silently reactivate GPS.
      networkOnlyPolicy = true
      activeViewingBoostPolicy = false
      journal.record("location.policy.fallback", "reason=unreadable-preferences")
    } else {
      val desired = loaded.getOrNull()
      networkOnlyPolicy = desired?.optString("locationProvider") == "network-only"
      activeViewingBoostPolicy = desired?.optBoolean("activeViewingBoost", true) != false
    }
    // Only a policy transition must cancel a pending automatic/GPS one-shot fix.
    // Ordinary low-power sampler changes must preserve the first viewer's refresh.
    if (!wasNetworkOnly && networkOnlyPolicy) clearRefresh()
  }
  /** Android may kill the process without invoking onDestroy; inspect the previous exit. */
  private fun recordPreviousProcessExit() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    runCatching {
      getSystemService(ActivityManager::class.java)
        ?.getHistoricalProcessExitReasons(packageName, 0, 1)
        ?.firstOrNull()
        ?.let { exit ->
          journal.record("service.previous.process.exit", "reason=${exit.reason};at=${exit.timestamp};importance=${exit.importance};process=${if (exit.processName == packageName) "app" else "other"}")
        }
    }
  }
  private lateinit var journal: ReliabilityJournal
  private var lastJournalMode: String? = null
  private var lastJournalReceived = -1L
  private var lastJournalRecorded = -1L
  private var lastJournalRecordingFollows = -1
  private var lastJournalSubmitted = -1L
  private var lastJournalConfirmed = -1L
  private var lastJournalSessionSequence = 0L
  private var watchFixesSinceJournal = 0L
  private var refreshFixesSinceJournal = 0L
  private var lastFixJournalAt = -1L
  private val safeSessionKinds = setOf(
    "stream-open", "redeem-denied", "admitted", "left", "transport-closed",
    "heartbeat-timeout", "heartbeat-failed", "expired", "blocked", "stopped",
  )
  private val journalHeartbeat = object : Runnable {
    override fun run() {
      if (finishing) return
      flushLocationFixJournal()
      val power = getSystemService(PowerManager::class.java)
      val activity = getSystemService(ActivityManager::class.java)
      // The journal caps each entry at 180 characters; a combined heartbeat + power
      // snapshot silently exceeded that limit and dropped the entire heartbeat.
      journal.record("service.heartbeat", "owner=${receiverFence.snapshot().owner};online=${connectivityManager?.activeNetwork != null};idle=${power?.isDeviceIdleMode == true};saver=${power?.isPowerSaveMode == true};exempt=${power?.isIgnoringBatteryOptimizations(packageName) == true};restricted=${activity?.isBackgroundRestricted == true};watch=$watchRequested")
      journal.record("service.power.snapshot", powerConditionsSnapshot(applicationContext))
      mainHandler.postDelayed(this, 300_000L)
    }
  }
  private var watchRequested = false
  /** WebView restarts default to hidden, never silently enabling background GPS. */
  private var appVisible = false
  private fun canPublishInBackground(): Boolean =
    (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED) &&
      NotificationManagerCompat.from(this).areNotificationsEnabled() &&
      (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
  /** The saved global mode takes precedence over stale background watchers. */
  private fun canPublishRequestedInBackground(): Boolean =
    store.loadBehaviorPreference()?.let(::JSONObject)?.optString("publication") != "foreground" &&
      canPublishInBackground()

  private fun receiverRequested(): Boolean =
    receiverFence.snapshot().owner == "service" && store.loadFollowingPreference() == true &&
      NotificationManagerCompat.from(this).areNotificationsEnabled() &&
      (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)


  private var appliedSampling: String? = null
  private var networkRestriction: String? = null
  private var networkStateSent: String? = null
  private var networkOnlineSent: Boolean? = null
  private var connectivityManager: ConnectivityManager? = null
  private var lastActiveNetwork: Network? = null
  private var sufferedNetworkLoss = false
  private fun requestTransportRecovery() {
    journal.record("transport.reconnect.attempt", "mode=background;online=true")
    queueCommand(JSONObject().put("type", "recover-background-sources").put("online", true))
    queueCommand(JSONObject().put("type", "recover-background-viewer").put("online", true).put("force", true))
  }
  private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) {
      mainHandler.post {
        val changed = lastActiveNetwork != null && lastActiveNetwork != network
        val recovering = changed || sufferedNetworkLoss
        lastActiveNetwork = network
        sufferedNetworkLoss = false
        updatePolicyState()
        if (recovering) requestTransportRecovery()
      }
    }

    override fun onLost(network: Network) {
      mainHandler.post {
        if (lastActiveNetwork == network) {
          lastActiveNetwork = null
          sufferedNetworkLoss = true
        }
        updatePolicyState()
      }
    }

    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
      mainHandler.post { updatePolicyState() }
    }
  }
  private val deviceLocationReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      mainHandler.post {
        val enabled = getSystemService(LocationManager::class.java).isLocationEnabled
        if (!enabled) {
          stopLocationUpdates()
          send(JSONObject().put("type", "location-error").put("code", 4))
        } else {
          updatePolicyState(forceSend = true)
        }
      }
    }
  }
  private val restrictBackgroundReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      mainHandler.post {
        journal.record("service.power.changed", "cause=data-saver;${powerConditionsSnapshot(applicationContext)}")
        updatePolicyState()
      }
    }
  }
  private val idleReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      mainHandler.post {
        journal.record("service.power.changed", "cause=doze;${powerConditionsSnapshot(applicationContext)}")
        val power = getSystemService(PowerManager::class.java)
        if (power?.isDeviceIdleMode == false && connectivityManager?.activeNetwork != null) {
          requestTransportRecovery()
        }
      }
    }
  }
  private var lastLoggedBatteryState: String? = null
  private val powerModeReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == Intent.ACTION_BATTERY_CHANGED) {
        val snapshot = powerConditionsSnapshot(applicationContext)
        if (snapshot != lastLoggedBatteryState) {
          lastLoggedBatteryState = snapshot
          journal.record("service.power.changed", "cause=battery-state;$snapshot")
        }
        return
      }
      val cause = when (intent?.action) {
        Intent.ACTION_BATTERY_LOW -> "battery-low"
        Intent.ACTION_BATTERY_OKAY -> "battery-okay"
        Intent.ACTION_POWER_CONNECTED -> "charging-connected"
        Intent.ACTION_POWER_DISCONNECTED -> "charging-disconnected"
        PowerManager.ACTION_POWER_SAVE_MODE_CHANGED -> "battery-saver"
        NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED -> "dnd"
        Intent.ACTION_SCREEN_OFF -> "screen-off"
        Intent.ACTION_SCREEN_ON -> "screen-on"
        else -> "other"
      }
      journal.record("service.power.changed", "cause=$cause;${powerConditionsSnapshot(applicationContext)}")
      mainHandler.post { updatePolicyState() }
    }
  }
  private var locationManager: LocationManager? = null
  private var refreshManager: LocationManager? = null
  private var refreshCancellation: CancellationSignal? = null
  private var refreshListener: LocationListener? = null
  private var refreshTimeout: Runnable? = null

  override fun onCreate() {
    super.onCreate()
    ShareServiceContract.serviceRunning = true
    ShareServiceContract.startPending = false
    journal = ReliabilityJournal(applicationContext)
    journal.record("service.created")
    journal.record("service.power.snapshot", powerConditionsSnapshot(applicationContext))
    recordPreviousProcessExit()
    mainHandler.post(journalHeartbeat)
    store = EncryptedShareStore(applicationContext, discardUnreadable = false)
    reloadLocationPolicies()
    receiverFence = ReceiverOwnershipFence(applicationContext)
    connectivityManager = getSystemService(ConnectivityManager::class.java)
    runCatching { connectivityManager?.registerDefaultNetworkCallback(networkCallback) }
    runCatching { registerReceiver(deviceLocationReceiver, IntentFilter().apply {
      addAction(LocationManager.MODE_CHANGED_ACTION)
      addAction(LocationManager.PROVIDERS_CHANGED_ACTION)
    }) }
    runCatching {
      registerReceiver(
        restrictBackgroundReceiver,
        IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED),
      )
    }
    runCatching {
      registerReceiver(idleReceiver, IntentFilter(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED))
    }
    runCatching {
      ContextCompat.registerReceiver(this, powerModeReceiver, IntentFilter().apply {
        addAction(Intent.ACTION_BATTERY_CHANGED)
        addAction(Intent.ACTION_BATTERY_LOW)
        addAction(Intent.ACTION_BATTERY_OKAY)
        addAction(Intent.ACTION_POWER_CONNECTED)
        addAction(Intent.ACTION_POWER_DISCONNECTED)
        addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED)
        addAction(Intent.ACTION_SCREEN_OFF)
        addAction(Intent.ACTION_SCREEN_ON)
      }, ContextCompat.RECEIVER_NOT_EXPORTED)
      journal.record("service.power.monitor", "status=registered")
    }.onFailure { journal.record("service.power.monitor", "status=failed;type=${it.javaClass.simpleName.take(40)}") }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    var stage = "dispatch"
    journal.record("service.start", "reason=${when (action) { ShareServiceContract.ACTION_RESTORE -> "restore"; null -> "system-restart"; ShareServiceContract.ACTION_RECEIVER_START -> "follow-start"; ShareServiceContract.ACTION_RECEIVER_STOP -> "follow-stop"; else -> "command" }}")
    return try {
      when (action) {
        ShareServiceContract.ACTION_RECEIVER_START, ShareServiceContract.ACTION_RECEIVER_STOP -> {
          val requested = JSONObject(intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST) ?: "{}")
          val generation = requested.optLong("generation", -1L)
          check(generation > 0L && receiverFence.snapshot().generation == generation) {
            "Background viewer ownership generation was rejected."
          }
          val requestId = intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST_ID)
            ?: UUID.randomUUID().toString()
          if (action == ShareServiceContract.ACTION_RECEIVER_STOP) pendingReceiverStops[requestId] = generation
          queueCommand(JSONObject()
            .put("type", if (action == ShareServiceContract.ACTION_RECEIVER_START) "receiver-start" else "receiver-stop")
            .put("generation", generation)
            .put("requestId", requestId))
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_STOP -> {
          queueCommand(JSONObject().put("type", "stop-all"))
          if (webView == null && !store.hasSavedShares() && receiverFence.snapshot().owner != "service") finishStop(reason = "explicit-stop")
          else startRuntime()
          START_NOT_STICKY
        }
        ShareServiceContract.ACTION_STOP_SHARE -> {
          queueCommand(
            JSONObject()
              .put("type", "stop-share")
              .put("shareId", intent?.getStringExtra(ShareServiceContract.EXTRA_SHARE_ID)),
          )
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_SET_PAUSED -> {
          // The UI sends EXTRA_REQUEST JSON; the notification uses EXTRA_PAUSED.
          // Never default an absent UI field to false (which silently unpauses).
          val request = intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST)
          val paused = when {
            request != null -> JSONObject(request).getBoolean("paused")
            intent?.hasExtra(ShareServiceContract.EXTRA_PAUSED) == true ->
              intent.getBooleanExtra(ShareServiceContract.EXTRA_PAUSED, false)
            else -> throw IllegalArgumentException("Missing sharing pause value.")
          }
          val requestId = intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST_ID)
          if (requestId != null) pendingPauseCommandIds.add(requestId)
          journal.record("sharing.pause.request",
            "paused=" + paused + ";origin=" + (if (request != null) "ui" else "notification"))
          queueCommand(JSONObject()
            .put("type", "set-paused")
            .put("paused", paused)
            .put("requestId", requestId))
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_SET_VISIBLE -> {
          appVisible = intent?.getBooleanExtra(ShareServiceContract.EXTRA_VISIBLE, false) ?: false
          if (!appVisible) queueCommand(JSONObject().put("type", "set-active-viewing")
            .put("shareId", JSONObject.NULL))
          queueCommand(JSONObject().put("type", "set-visible").put("visible", appVisible))
          startRuntime()
          updatePolicyState()
          START_STICKY
        }
        ShareServiceContract.ACTION_SET_ACTIVE_VIEWING -> {
          val candidate = intent?.getStringExtra(ShareServiceContract.EXTRA_SHARE_ID)
          val shareId = candidate?.takeIf { it.length in 16..64 }
          queueCommand(JSONObject().put("type", "set-active-viewing")
            .put("shareId", shareId ?: JSONObject.NULL))
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_BLOCK_VIEWER -> {
          queueCommand(
            JSONObject()
              .put("type", "block-viewer")
              .put("shareId", intent?.getStringExtra(ShareServiceContract.EXTRA_SHARE_ID))
              .put("fingerprint", intent?.getStringExtra(ShareServiceContract.EXTRA_FINGERPRINT)),
          )
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_DEVICE_COMPARISON -> {
          val command = JSONObject(intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST) ?: "{}")
            .put("type", "device-comparison")
            .put("requestId", intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST_ID))
          queueCommand(command)
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_REPLACE_BACKGROUND_OWNER -> {
          val command = JSONObject(intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST) ?: "{}")
            .put("type", "replace-background-owner")
            .put("requestId", intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST_ID))
          queueCommand(command)
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_APPROVE_VIEWER -> {
          queueCommand(
            JSONObject()
              .put("type", "approve-viewer")
              .put("requestId", intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST_ID))
              .put("shareId", intent?.getStringExtra(ShareServiceContract.EXTRA_SHARE_ID))
              .put("peerId", intent?.getStringExtra(ShareServiceContract.EXTRA_PEER_ID)),
          )
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_APPROVE_RETURN_LINK -> {
          queueCommand(
            JSONObject()
              .put("type", "approve-return-link")
              .put("requestId", intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST_ID))
              .put("shareId", intent?.getStringExtra(ShareServiceContract.EXTRA_SHARE_ID)),
          )
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_DISMISS_RETURN_OFFER -> {
          queueCommand(
            JSONObject()
              .put("type", "dismiss-return-offer")
              .put("requestId", intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST_ID))
              .put("shareId", intent?.getStringExtra(ShareServiceContract.EXTRA_SHARE_ID))
              .put("fingerprint", intent?.getStringExtra(ShareServiceContract.EXTRA_FINGERPRINT)),
          )
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_DISMISS_STOPPED_VIEWER -> {
          queueCommand(
            JSONObject()
              .put("type", "dismiss-stopped-viewer")
              .put("requestId", intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST_ID))
              .put("shareId", intent?.getStringExtra(ShareServiceContract.EXTRA_SHARE_ID))
              .put("peerId", intent?.getStringExtra(ShareServiceContract.EXTRA_PEER_ID)),
          )
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_IMPORT_SOURCE_STATE,
        ShareServiceContract.ACTION_SET_SHARING_BEHAVIOR,
        ShareServiceContract.ACTION_CLEAR_OLD_PEERS,
        ShareServiceContract.ACTION_ADOPT_PEER_NAME,
        ShareServiceContract.ACTION_SET_PEER_NAMES -> {
          val request = JSONObject(intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST)
            ?: throw IllegalArgumentException("Missing name preferences."))
          val commandType = when (intent?.action) {
            ShareServiceContract.ACTION_IMPORT_SOURCE_STATE -> "import-source-state"
            ShareServiceContract.ACTION_SET_SHARING_BEHAVIOR -> "set-sharing-behavior"
            ShareServiceContract.ACTION_CLEAR_OLD_PEERS -> "clear-old-peers"
            ShareServiceContract.ACTION_ADOPT_PEER_NAME -> "adopt-peer-name"
            else -> "set-peer-names"
          }
          queueCommand(request.put("type", commandType)
            .put("requestId", intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST_ID)))
          startRuntime()
          if (commandType == "set-sharing-behavior") {
            reloadLocationPolicies()
            updatePolicyState(forceSend = true)
          }
          START_STICKY
        }
        ShareServiceContract.ACTION_SET_VIEWER_NAME -> {
          queueCommand(
            JSONObject()
              .put("type", "set-viewer-name")
              .put("shareId", intent?.getStringExtra(ShareServiceContract.EXTRA_SHARE_ID))
              .put("fingerprint", intent?.getStringExtra(ShareServiceContract.EXTRA_FINGERPRINT))
              .put("name", intent?.getStringExtra(ShareServiceContract.EXTRA_NAME)),
          )
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_START -> {
          val request = intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST)
            ?: throw IllegalArgumentException("Background share request is missing.")
          // Foreground-only fallback must work immediately for a share
          // started while the Activity is visible, even before a visibility
          // lifecycle callback reaches this service.
          appVisible = JSONObject(request).optBoolean("visible", false)
          val requestId = UUID.randomUUID().toString()
          pendingCreateIds.add(requestId)
          queueCommand(
            JSONObject()
              .put("type", "create-share")
              .put("requestId", requestId)
              .put("request", JSONObject(request)),
          )
          startRuntime()
          START_STICKY
        }
        ShareServiceContract.ACTION_RESTORE, null -> {
          stage = "restore-policy"
          val savedShares = store.hasSavedShares()
          val backgroundShares = store.hasBackgroundShares()
          val receiving = receiverRequested()
          journal.record("service.restart.policy", "trigger=${if (action == null) "system" else "restore"};saved=$savedShares;background=$backgroundShares;receiver=$receiving;owner=${receiverFence.snapshot().owner}")
          if ((!savedShares && !receiving) ||
              (action == null && !backgroundShares && !receiving)) {
            finishStop(reason = "no-authorized-background-work")
            START_NOT_STICKY
          } else {
            if (receiving) {
              queueCommand(JSONObject()
                .put("type", "receiver-start")
                .put("generation", receiverFence.snapshot().generation)
                .put("requestId", UUID.randomUUID().toString()))
            }
            // Reconcile restored source runtime with the requested global policy.
            // Permission fallbacks are execution details, not stored preferences.
            if (savedShares) {
              store.loadBehaviorPreference()?.let(::JSONObject)?.let { desired ->
                val effective = JSONObject(desired.toString())
                val locationAllowed = locationGrant(this) != "none" &&
                  getSystemService(LocationManager::class.java).isLocationEnabled
                if (effective.optString("publication") == "background" &&
                    (!locationAllowed || !canPublishInBackground())) {
                  effective.put("publication", "foreground")
                }
                queueCommand(JSONObject()
                  .put("type", "set-sharing-behavior")
                  .put("requestId", UUID.randomUUID().toString())
                  .put("behavior", effective))
              }
            }
            stage = "restore-runtime"
            startRuntime()
            START_STICKY
          }
        }
        else -> {
          finishStop(reason = "unknown-service-action")
          START_NOT_STICKY
        }
      }
    } catch (error: Exception) {
      journal.record("service.start.failed", "stage=$stage;trigger=${if (action == null) "system" else "intent"};exception=${error.javaClass.simpleName}")
      failClosed("Protected location sharing could not be restored.")
      START_NOT_STICKY
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onLocationChanged(location: Location) {
    sendPosition(location, "location")
  }

  private fun flushLocationFixJournal() {
    if (watchFixesSinceJournal == 0L && refreshFixesSinceJournal == 0L) return
    journal.record("location.fix", "mode=service;watch=$watchFixesSinceJournal;refresh=$refreshFixesSinceJournal")
    watchFixesSinceJournal = 0L
    refreshFixesSinceJournal = 0L
    lastFixJournalAt = SystemClock.elapsedRealtime()
  }

  private fun recordLocationFix(type: String) {
    if (type == "location") watchFixesSinceJournal++ else refreshFixesSinceJournal++
    if (lastFixJournalAt >= 0L && SystemClock.elapsedRealtime() - lastFixJournalAt < 300_000L) return
    flushLocationFixJournal()
  }

  private fun sendPosition(location: Location, type: String) {
    recordLocationFix(type)
    send(JSONObject()
      .put("type", type)
      .put("position", locationPositionJson(location)))
  }

  override fun onProviderDisabled(provider: String) {
    val manager = locationManager ?: return
    if (availableLocationProviders(manager).isEmpty()) {
      send(JSONObject().put("type", "location-error")
        .put("code", if (manager.isLocationEnabled) 2 else 4))
    } else {
      restartLocationAfterProviderChange()
    }
  }

  override fun onProviderEnabled(provider: String) = restartLocationAfterProviderChange()

  private fun restartLocationAfterProviderChange() {
    mainHandler.post {
      if (locationManager != null && watchRequested) {
        stopLocationUpdates(cancelRefresh = false)
        startLocationUpdates()
      }
    }
  }

  override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

  override fun onDestroy() {
    flushLocationFixJournal()
    journal.record("service.destroyed", "finishing=$finishing;runtimeReady=$runtimeReady;watch=$watchRequested")
    mainHandler.removeCallbacks(journalHeartbeat)
    mainHandler.removeCallbacks(viewingBoostTimer)
    stopLocationUpdates()
    runCatching { connectivityManager?.unregisterNetworkCallback(networkCallback) }
    runCatching { unregisterReceiver(restrictBackgroundReceiver) }
    runCatching { unregisterReceiver(deviceLocationReceiver) }
    runCatching { unregisterReceiver(idleReceiver) }
    runCatching { unregisterReceiver(powerModeReceiver) }
    lastActiveNetwork = null
    sufferedNetworkLoss = false
    connectivityManager = null
    watchRequested = false
    networkRestriction = null
    networkStateSent = null
    networkOnlineSent = null
    ShareServiceContract.networkRestriction = null
    ShareServiceContract.sampling = "saver"
    webView?.let { view -> mainHandler.post { view.stopLoading(); view.destroy() } }
    webView = null
    runtimeStarting = false
    if (!finishing) ShareServiceContract.currentStatus = null
    ShareServiceContract.serviceRunning = false
    ShareServiceContract.startPending = false
    ioExecutor.shutdown()
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    journal.record("service.task.removed")
    queueCommand(JSONObject().put("type", "stop-foreground-only"))
    super.onTaskRemoved(rootIntent)
  }

  private fun createRuntime() {
    runtimeStarting = true
    mainHandler.post {
      if (!runtimeStarting) return@post
      val view = WebView(applicationContext)
      view.settings.apply {
        javaScriptEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        domStorageEnabled = false
        databaseEnabled = false
        javaScriptCanOpenWindowsAutomatically = false
        setSupportMultipleWindows(false)
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      }
      view.addJavascriptInterface(RuntimeBridge(), "ConstellationNative")
      view.webViewClient = runtimeClient()
      webView = view
      runtimeStarting = false
      Log.i("ConstellationRuntime", "background-runtime-created")
      view.loadUrl(PAGE_URL)
    }
  }

  private fun runtimeClient() = object : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
      request.url.toString() !in setOf(PAGE_URL, ERROR_SCRIPT_URL, SCRIPT_URL)

    override fun shouldInterceptRequest(
      view: WebView,
      request: WebResourceRequest,
    ): WebResourceResponse = when (request.url.toString()) {
      PAGE_URL -> response("text/html", HTML.toByteArray())
      ERROR_SCRIPT_URL -> response("application/javascript", ERROR_SCRIPT.toByteArray())
      SCRIPT_URL -> response(
        "application/javascript",
        assets.open("constellation-background.js").readBytes(),
      )
      else -> WebResourceResponse(
        "text/plain", "utf-8", 404, "Not Found", emptyMap(),
        ByteArrayInputStream(ByteArray(0)),
      )
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      if (url != PAGE_URL) view.stopLoading()
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      journal.record("service.runtime.crashed")
      failClosed("Background sharing stopped because its protected runtime exited.")
      return true
    }
  }

  private inner class RuntimeBridge {
    @JavascriptInterface
    fun postMessage(message: String) {
      val parsed = runCatching { JSONObject(message) }.getOrNull() ?: return
      when (parsed.optString("type")) {
        "runtime-error" -> Log.e(
          "ConstellationRuntime",
          redactRuntimeError(parsed.optString("message")),
        )
        "private-state" -> handlePrivateStateRequest(parsed)
        else -> mainHandler.post { handleRuntimeMessage(parsed) }
      }
    }
  }

  private fun handlePrivateStateRequest(request: JSONObject) {
    val requestId = request.optString("requestId")
    ioExecutor.execute {
      val response = JSONObject()
        .put("type", "private-state-result")
        .put("requestId", requestId)
      try {
        val scope = request.optString("scope", "source")
        val generation = request.optLong("generation", -1)
        require(scope == "source" || scope == "viewer") { "Unsupported protected-state scope." }
        when (request.optString("action")) {
          "load" -> response.put("state", if (scope == "viewer")
            receiverFence.loadServiceState(generation) ?: JSONObject.NULL
            else store.loadPrivateState() ?: JSONObject.NULL)
          "save" -> {
            val state = request.optString("state")
            if (scope == "viewer") receiverFence.saveServiceState(generation, state)
            else store.savePrivateState(state)
            response.put("state", JSONObject.NULL)
          }
          else -> throw IllegalArgumentException("Unsupported protected-state operation.")
        }
      } catch (error: Exception) {
        Log.e(
          "ConstellationRuntime",
          "private-state-${request.optString("action")}-failed:${error.javaClass.simpleName}",
        )
        response.put("error", "Protected source state could not be opened or saved.")
      }
      send(response)
    }
  }

  private fun handleRuntimeMessage(parsed: JSONObject) {
    if (finishing) return
    when (parsed.optString("type")) {
      "diagnostic" -> {
        val event = parsed.optString("event")
        val state = parsed.optString("state")
        if (event in setOf("follow.reconnect.attempt", "follow.reconnect.finished", "follow.reconnect.failed", "follow.restore.attempt", "follow.restore.finished", "follow.restore.failed") &&
          state in setOf("retry", "connected", "pending", "error")) {
          journal.record(event, "state=$state")
        }
      }
      "ready" -> {
        journal.record("service.runtime.ready")
        runtimeReady = true
        pendingCommands.toList().forEach(::send)
        pendingCommands.clear()
        updatePolicyState(forceSend = true)
        stopWhenIdle()
      }
      "command-complete" -> {
        val completedId = parsed.optString("requestId")
        pendingReceiverStops.remove(completedId)?.let { generation ->
          if (!parsed.has("error")) {
            runCatching { receiverFence.releaseService(generation) }
              .onFailure { parsed.put("error", "Receiver ownership could not be released.") }
          }
        }
        val wasPause = pendingPauseCommandIds.remove(completedId)
        if (wasPause) {
          journal.record("sharing.pause.complete",
            "result=" + (if (parsed.has("error")) "error" else "ok"))
        }
        pendingCommandIds.remove(parsed.optString("requestId"))
        val result = Intent(ShareServiceContract.ACTION_COMMAND_COMPLETE)
          .setPackage(packageName)
          .putExtra(ShareServiceContract.EXTRA_REQUEST_ID, parsed.optString("requestId"))
        if (parsed.has("error")) {
          result.putExtra(ShareServiceContract.EXTRA_ERROR,
            if (wasPause) "Sharing pause could not be saved." else "Could not save the return-sharing change.")
        }
        sendBroadcast(result)
        stopWhenIdle()
      }
      "create-complete" -> {
        pendingCreateIds.remove(parsed.optString("requestId"))
        stopWhenIdle()
      }
      "location-watch-start" -> startLocationUpdates()
      "location-watch-stop" -> {
        watchRequested = false
        stopLocationUpdates()
      }
      "location-refresh" -> requestFreshLocation()
      "receiver-status" -> {
        val follows = parsed.optJSONObject("status")?.optJSONArray("following")
        var received = 0L
        for (index in 0 until (follows?.length() ?: 0)) {
          received += follows?.optJSONObject(index)?.optLong("updatesReceived", 0L) ?: 0L
        }
        if (received != lastJournalReceived) {
          journal.record("follow.received", "total=$received;peers=${follows?.length() ?: 0};owner=service")
          lastJournalReceived = received
        }
        var recorded = 0L
        var recordingFollows = 0
        for (index in 0 until (follows?.length() ?: 0)) {
          val follow = follows?.optJSONObject(index) ?: continue
          if (follow.optBoolean("traceEnabled")) {
            recordingFollows += 1
            recorded += follow.optJSONArray("trace")?.length()?.toLong() ?: 0L
          }
        }
        if (recorded != lastJournalRecorded || recordingFollows != lastJournalRecordingFollows) {
          journal.record("follow.history.status", "recorded=$recorded;enabled=$recordingFollows;owner=service")
          lastJournalRecorded = recorded
          lastJournalRecordingFollows = recordingFollows
        }
        ShareServiceContract.receiverStatus = parsed.optJSONObject("status")?.toString()
        if (parsed.optBoolean("stopped")) ShareServiceContract.receiverStatus = null
        updatePolicyState()
      }
      "status" -> {
        val status = parsed.optJSONObject("status") ?: return
        ShareServiceContract.currentStatus = status.toString()
        persistStatusIfChanged(status)
        // Session event names and counts only, never peer identifiers or locations.
        // The source can keep obtaining fixes even after its P2P session is gone.
        val sessionEvents = status.optJSONObject("diagnostics")?.optJSONArray("sessionEvents")
        for (index in 0 until (sessionEvents?.length() ?: 0)) {
          val entry = sessionEvents?.optJSONObject(index) ?: continue
          val sequence = entry.optLong("sequence", 0L)
          val event = entry.optString("event")
          if (sequence > lastJournalSessionSequence && event in safeSessionKinds) {
            journal.record("sharing.session", "event=$event;active=${entry.optInt("activeSessions", 0).coerceAtLeast(0)}")
            lastJournalSessionSequence = sequence
          }
        }
        val shares = status.optJSONArray("shares")
        var viewers = 0
        for (index in 0 until (shares?.length() ?: 0)) {
          viewers += shares?.optJSONObject(index)?.optInt("viewerCount", 0) ?: 0
        }
        val submitted = (0 until (shares?.length() ?: 0)).maxOfOrNull { index ->
          val viewersForShare = shares?.optJSONObject(index)?.optJSONArray("viewers")
          (0 until (viewersForShare?.length() ?: 0)).maxOfOrNull { j ->
            viewersForShare?.optJSONObject(j)?.optLong("lastSubmittedAt", 0L) ?: 0L
          } ?: 0L
        } ?: 0L
        if (submitted != lastJournalSubmitted) {
          journal.record("sharing.submit", "latest=$submitted;viewers=$viewers")
          lastJournalSubmitted = submitted
        }
        val confirmed = (0 until (shares?.length() ?: 0)).maxOfOrNull { index ->
          val viewersForShare = shares?.optJSONObject(index)?.optJSONArray("viewers")
          (0 until (viewersForShare?.length() ?: 0)).maxOfOrNull { j ->
            viewersForShare?.optJSONObject(j)?.optLong("lastConfirmedAt", 0L) ?: 0L
          } ?: 0L
        } ?: 0L
        if (confirmed != lastJournalConfirmed) {
          journal.record("sharing.confirmed", "latest=$confirmed;viewers=$viewers")
          lastJournalConfirmed = confirmed
        }
        lastShares = shares
        lastViewerCount = viewers
        lastPaused = status.optBoolean("paused", false)
        updatePolicyState()
        ShareNotification.update(
          this,
          notificationBody(shares, viewers),
          (shares?.length() ?: 0) > 0,
          lastPaused,
          receiving = receiverFence.snapshot().owner == "service",
        )
        stopWhenIdle()
      }
      "idle", "stopped" -> stopWhenIdle()
      "paused" -> finishPause()
    }
  }

  private fun notificationBody(shares: JSONArray?, viewers: Int): String {
    val count = shares?.length() ?: 0
    if (count == 0) return if (receiverFence.snapshot().owner == "service")
      "Receiving encrypted location updates from saved peers" else "Notifying peers that location links have ended"
    val precisions = linkedSetOf<String>()
    var nearestExpiry: Long? = null
    for (index in 0 until count) {
      val share = shares?.optJSONObject(index) ?: continue
      when (share.optString("precision")) {
        "exact" -> precisions.add("exact")
        "approximate" -> precisions.add("approximate")
        "very-coarse" -> precisions.add("very coarse")
      }
      if (!share.isNull("expiresAt")) {
        val expiresAt = share.optLong("expiresAt", 0L)
        if (expiresAt > 0L && (nearestExpiry == null || expiresAt < nearestExpiry!!)) {
          nearestExpiry = expiresAt
        }
      }
    }
    val precisionText = if (precisions.isEmpty()) "location" else precisions.joinToString(" + ")
    val expiryText = nearestExpiry?.let { expiresAt ->
      val remainingMinutes = maxOf(1L, (expiresAt - System.currentTimeMillis() + 59_999L) / 60_000L)
      "next ends in $remainingMinutes min"
    } ?: "until stopped"
    val linkText = if (count == 1) "1 link" else "$count links"
    val pausedCount = (0 until count).count { index ->
      shares?.optJSONObject(index)?.isNull("paused") == false
    }
    val pauseText = when {
      pausedCount == 0 -> null
      pausedCount == count -> when (networkRestriction) {
        "metered" -> "All links paused on metered network"
        "data-saver" -> "All links paused by Data Saver"
        else -> "Sharing paused"
      }
      else -> {
        val reason = when (networkRestriction) {
          "metered" -> "metered network"
          "data-saver" -> "Data Saver"
          else -> "network policy"
        }
        "$pausedCount of $count links paused on $reason"
      }
    }
    val details = "$linkText · $precisionText · $viewers connected · $expiryText"
    return if (pauseText == null) details else "$pauseText · $details"
  }

  private fun foregroundNotificationBody(): String {
    val status = ShareServiceContract.currentStatus
      ?.let { runCatching { JSONObject(it) }.getOrNull() }
      ?: return "Restoring private P2P sharing…"
    if (status.optString("state") != "sharing") return "Restoring private P2P sharing…"
    val shares = status.optJSONArray("shares")
    if ((shares?.length() ?: 0) == 0) return "Restoring private P2P sharing…"
    var viewers = 0
    for (index in 0 until (shares?.length() ?: 0)) {
      viewers += shares?.optJSONObject(index)?.optInt("viewerCount", 0) ?: 0
    }
    return notificationBody(shares, viewers)
  }

  private fun startLocationUpdates() {
    watchRequested = true
    // An open invitation is not a reason to keep GPS awake. The authenticated
    // subscription path requests a fresh fix when the first viewer arrives.
    if (lastViewerCount == 0 || allKnownSharesPaused()) return
    // Desired background policy is not a substitute for Android permission.
    // Run only in the foreground until all required OS grants are available.
    if (!appVisible && !canPublishRequestedInBackground()) {
      journal.record("location.policy.fallback", "mode=foreground-only")
      return
    }
    if (locationGrant(this) == "none") {
      send(JSONObject().put("type", "location-error").put("code", 1))
      return
    }
    if (!getSystemService(LocationManager::class.java).isLocationEnabled) {
      send(JSONObject().put("type", "location-error").put("code", 4))
      return
    }
    val sampling = samplingFor(lastShares)
    val preferredProvider = preferredLocationProvider(lastShares)
    val manager = getSystemService(LocationManager::class.java)
    if (watchAndroidLocation(
      manager,
      this,
      intervalFor(sampling),
      distanceFor(sampling),
      preferredProvider = preferredProvider,
      allowFallback = !networkOnlyLocationRequested(),
    )) {
      locationManager = manager
      appliedSampling = "$sampling:$preferredProvider:${networkOnlyLocationRequested()}"
    } else {
      send(JSONObject().put("type", "location-error").put("code", 2))
    }
  }

  private fun stopLocationUpdates(cancelRefresh: Boolean = true) {
    if (cancelRefresh) clearRefresh()
    locationManager?.let { manager -> runCatching { manager.removeUpdates(this) } }
    locationManager = null
    appliedSampling = null
  }

  private fun samplingFor(shares: JSONArray?): String {
    val power = getSystemService(PowerManager::class.java)
    val nowElapsed = SystemClock.elapsedRealtime()
    val nowWall = System.currentTimeMillis()
    val demandAt = shareObjects(shares)
      .filter { it.isNull("paused") && it.optInt("viewerCount", 0) > 0 }
      .maxOfOrNull { it.optLong("activeViewingUntil", 0L) } ?: 0L
    val demandRemaining = (demandAt - nowWall).coerceIn(0L, 25_000L)
    val boostEnabled = activeViewingBoostPolicy
    val allowed = boostEnabled && demandRemaining > 0L &&
      power?.isPowerSaveMode != true && power?.isDeviceIdleMode != true &&
      !lastPaused && canPublishRequestedInBackground()
    activeViewingBoostUntil = viewingBudget.permittedUntil(
      nowElapsed, nowElapsed + demandRemaining, allowed,
    )
    mainHandler.removeCallbacks(viewingBoostTimer)
    if (activeViewingBoostUntil > nowElapsed) {
      mainHandler.postDelayed(viewingBoostTimer, activeViewingBoostUntil - nowElapsed)
      return "balanced"
    }
    if (!appVisible || power?.isPowerSaveMode == true || power?.isInteractive == false) return "saver"
    val publishing = shareObjects(shares).filter { it.isNull("paused") }
    val relevant = publishing.ifEmpty { shareObjects(shares) }
    return if (relevant.any { it.optString("battery") == "balanced" }) "balanced" else "saver"
  }

  private fun networkOnlyLocationRequested(): Boolean = networkOnlyPolicy

  private fun preferredLocationProvider(shares: JSONArray?): String =
    if (!networkOnlyLocationRequested() && locationGrant(this) == "fine" && shareObjects(shares).any {
        it.isNull("paused") && it.optInt("viewerCount", 0) > 0 &&
        it.optString("precision") == "exact" &&
        (appVisible || (activeViewingBoostUntil > SystemClock.elapsedRealtime() &&
          it.optLong("activeViewingUntil", 0L) > System.currentTimeMillis()))
      }) LocationManager.GPS_PROVIDER else LocationManager.NETWORK_PROVIDER

  private fun shareObjects(shares: JSONArray?): List<JSONObject> =
    (0 until (shares?.length() ?: 0)).mapNotNull { shares?.optJSONObject(it) }

  private fun publishingShareCount(shares: JSONArray?): Int =
    shareObjects(shares).count { it.isNull("paused") }

  private fun allKnownSharesPaused(): Boolean {
    val shares = lastShares ?: return false
    return shares.length() > 0 && publishingShareCount(shares) == 0
  }

  private fun intervalFor(sampling: String): Long =
    if (sampling == "saver") SAVER_UPDATE_INTERVAL_MS else BALANCED_UPDATE_INTERVAL_MS

  private fun distanceFor(sampling: String): Float =
    if (sampling == "saver") SAVER_UPDATE_MINIMUM_DISTANCE_METRES else BALANCED_UPDATE_MINIMUM_DISTANCE_METRES

  private fun connectivityRestriction(): String? {
    val manager = connectivityManager ?: return null
    val active = manager.activeNetwork ?: return null
    val capabilities = manager.getNetworkCapabilities(active) ?: return null
    if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) return "metered"
    return if (manager.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED) {
      "data-saver"
    } else {
      null
    }
  }

  private fun updatePolicyState(forceSend: Boolean = false) {
    if (finishing) return
    val shares = lastShares
    val restriction = connectivityRestriction()
    val networkState = restriction ?: "unmetered"
    val online = connectivityManager?.activeNetwork != null
    if (forceSend || networkState != networkStateSent || online != networkOnlineSent) {
      journal.record("service.network", "online=$online;policy=$networkState")
      networkStateSent = networkState
      networkOnlineSent = online
      queueCommand(JSONObject().put("type", "network-state").put("state", networkState).put("online", online))
    }
    val sampling = samplingFor(shares)
    networkRestriction = restriction
    val mode = "sharing=${publishingShareCount(shares) > 0};following=${receiverFence.snapshot().owner == "service"};sampling=$sampling"
    if (mode != lastJournalMode) {
      journal.record("service.mode", mode)
      lastJournalMode = mode
    }
    ShareServiceContract.networkRestriction = restriction
    ShareServiceContract.sampling = sampling
    val permitted = appVisible || canPublishRequestedInBackground()
    if (publishingShareCount(shares) == 0 || lastViewerCount == 0 || !permitted) {
      if (locationManager != null || refreshManager != null) stopLocationUpdates()
    } else if (watchRequested &&
      (locationManager == null || appliedSampling != "$sampling:${preferredLocationProvider(shares)}:${networkOnlyLocationRequested()}")) {
      stopLocationUpdates(cancelRefresh = false)
      startLocationUpdates()
    }
    ShareNotification.update(
      this,
      notificationBody(shares, lastViewerCount),
      (shares?.length() ?: 0) > 0,
      lastPaused,
      receiving = receiverFence.snapshot().owner == "service",
    )
  }

  private fun clearRefresh() {
    refreshTimeout?.let(mainHandler::removeCallbacks)
    refreshTimeout = null
    refreshCancellation?.cancel()
    refreshCancellation = null
    refreshListener?.let { listener -> refreshManager?.removeUpdates(listener) }
    refreshListener = null
    refreshManager = null
  }

  private fun requestFreshLocation() {
    if (!appVisible && !canPublishRequestedInBackground()) {
      journal.record("location.policy.fallback", "mode=refresh-foreground-only")
      return
    }
    if (allKnownSharesPaused()) return
    if (locationGrant(this) == "none") return
    val manager = locationManager ?: getSystemService(LocationManager::class.java)
    val provider = preferredOneShotLocationProvider(
      availableLocationProviders(manager),
      networkOnlyLocationRequested(),
      locationGrant(this) == "fine",
      shareObjects(lastShares).any { it.isNull("paused") && it.optString("precision") == "exact" },
    ) ?: return
    journal.record("location.refresh", "provider=${if (provider == LocationManager.GPS_PROVIDER) "gps" else "network"}")
    clearRefresh()
    refreshManager = manager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val cancellation = CancellationSignal()
      refreshCancellation = cancellation
      val timeout = Runnable { clearRefresh() }
      refreshTimeout = timeout
      mainHandler.postDelayed(timeout, 20_000L)
      runCatching {
        manager.getCurrentLocation(provider, cancellation, mainExecutor) { location ->
          clearRefresh()
          if (location != null) sendPosition(location, "location-refresh-result")
        }
      }.onFailure { clearRefresh() }
      return
    }
    val listener = androidLocationListener(onLocationChanged = { location ->
      clearRefresh()
      sendPosition(location, "location-refresh-result")
    })
    refreshListener = listener
    val timeout = Runnable { clearRefresh() }
    refreshTimeout = timeout
    mainHandler.postDelayed(timeout, 20_000L)
    runCatching { manager.requestSingleUpdate(provider, listener, Looper.getMainLooper()) }
      .onFailure { clearRefresh() }
  }

  private fun send(command: JSONObject) {
    val encoded = JSONObject.quote(command.toString())
    mainHandler.post {
      webView?.evaluateJavascript(
        "if (window.__constellationBackgroundCommand) window.__constellationBackgroundCommand($encoded)",
        null,
      )
    }
  }

  private fun startRuntime() {
    val receiving = receiverRequested()
    val backgroundSourceShares = runCatching { store.hasBackgroundShares() }.getOrDefault(false)
    // Preserve the existing location-type lifecycle for outgoing shares and
    // durable ended-link notices; receiver-only devices need no location grant.
    val location = locationGrant(this) != "none" &&
      getSystemService(LocationManager::class.java).isLocationEnabled &&
      (appVisible || (backgroundSourceShares && canPublishRequestedInBackground())) &&
      (!receiving || backgroundSourceShares || pendingCreateIds.isNotEmpty())
    if (location || receiving) {
      journal.record("service.foreground.attempt", "location=$location;receiver=$receiving")
      val notice = ShareNotification.build(
        this, if (receiving && !location) "Receiving encrypted updates from saved peers" else foregroundNotificationBody(),
        sharing = location, paused = lastPaused, receiving = receiving,
      )
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        val types = (if (location) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0) or
          (if (receiving) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
        startForeground(ShareServiceContract.NOTIFICATION_ID, notice, types)
      } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(ShareServiceContract.NOTIFICATION_ID, notice,
          if (location) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0)
      } else {
        startForeground(ShareServiceContract.NOTIFICATION_ID, notice)
      }
      journal.record("service.foreground.ready", "location=$location;receiver=$receiving")
    }
    if (webView == null && !runtimeStarting) createRuntime()
  }

  private fun queueCommand(command: JSONObject) {
    val requestId = command.optString("requestId")
    if (requestId.isNotEmpty() && command.optString("type") != "create-share")
      pendingCommandIds.add(requestId)
    if (runtimeReady) send(command) else pendingCommands.add(command)
  }

  private fun stopWhenIdle() {
    if (!runtimeReady || pendingCreateIds.isNotEmpty() || pendingCommandIds.isNotEmpty()) return
    val status = ShareServiceContract.currentStatus?.let { runCatching { JSONObject(it) }.getOrNull() }
      ?: return
    if ((status.optJSONArray("shares")?.length() ?: 0) > 0 ||
        status.optInt("endNotificationCount", 0) > 0) return
    if (receiverRequested()) return
    finishStop(status.takeIf { it.optString("state") == "error" }, reason = "runtime-idle")
  }

  private fun redactRuntimeError(message: String): String = message
    .replace(Regex("#share=[A-Za-z0-9_-]+"), "#share=<redacted>")
    .take(2_048)

  private fun redactedStatus(status: JSONObject): String = JSONObject(status.toString())
    .apply {
      put("location", JSONObject().put("status", "unavailable"))
      remove("diagnostics")
      remove("returnOffers")
      remove("shares")
      remove("share")
      remove("message")
    }
    .toString()

  private fun persistStatusIfChanged(status: JSONObject) {
    val redacted = redactedStatus(status)
    if (redacted == lastPersistedStatus) return
    store.saveStatus(redacted)
    lastPersistedStatus = redacted
  }

  private fun failClosed(message: String) {
    finishStop(JSONObject().put("state", "error").put("message", message))
  }

  private fun finishStop(failure: JSONObject? = null, reason: String = "explicit-stop") {
    if (finishing) return
    journal.record("service.stop", "reason=$reason;failed=${failure != null};runtimeReady=$runtimeReady")
    finishing = true
    stopLocationUpdates()
    watchRequested = false
    lastShares = null
    lastViewerCount = 0
    lastPaused = false
    networkRestriction = null
    ShareServiceContract.networkRestriction = null
    val stopped = JSONObject(failure?.toString() ?: STOPPED_STATUS)
      .put("shares", org.json.JSONArray())
      .put("location", JSONObject().put("status", "unavailable"))
    ShareServiceContract.currentStatus?.let { current ->
      val previous = runCatching { JSONObject(current) }.getOrNull()
      previous?.optJSONObject("sharingBehavior")?.let { stopped.put("sharingBehavior", it) }
      for (key in listOf("oldSharing", "stoppedViewers", "peerNamePreferences")) {
        previous?.optJSONArray(key)?.let { stopped.put(key, it) }
      }
    }
    val stoppedStatus = stopped.toString()
    runCatching { store.saveStatus(if (failure == null) stoppedStatus else redactedStatus(stopped)) }
    ShareServiceContract.currentStatus = stoppedStatus
    ShareServiceContract.serviceRunning = false
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun finishPause() {
    if (finishing) return
    journal.record("service.stop", "reason=foreground-only-paused;runtimeReady=$runtimeReady")
    finishing = true
    stopLocationUpdates()
    watchRequested = false
    lastShares = null
    lastViewerCount = 0
    lastPaused = false
    networkRestriction = null
    ShareServiceContract.networkRestriction = null
    val status = "{\"state\":\"paused\",\"shares\":[],\"location\":{\"status\":\"unavailable\"},\"message\":\"Foreground-only links are paused until Constellation is reopened.\"}"
    runCatching { store.saveStatus(redactedStatus(JSONObject(status))) }
    ShareServiceContract.currentStatus = status
    ShareServiceContract.serviceRunning = false
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun response(mime: String, bytes: ByteArray) = WebResourceResponse(
    mime,
    "utf-8",
    200,
    "OK",
    mapOf(
      "Content-Security-Policy" to "default-src 'none'; script-src 'self'; connect-src https: wss: ws:",
      "Access-Control-Allow-Origin" to "*",
    ),
    ByteArrayInputStream(bytes),
  )

  private companion object {
    const val PAGE_URL = "https://constellation.invalid/runtime.html"
    const val ERROR_SCRIPT_URL = "https://constellation.invalid/runtime-errors.js"
    const val SCRIPT_URL = "https://constellation.invalid/constellation-background.js"
    const val BALANCED_UPDATE_INTERVAL_MS = 15_000L
    const val BALANCED_UPDATE_MINIMUM_DISTANCE_METRES = 15f
    const val SAVER_UPDATE_INTERVAL_MS = 30_000L
    const val SAVER_UPDATE_MINIMUM_DISTANCE_METRES = 25f
    val ERROR_SCRIPT = """
      (function () {
        function report(message) {
          try {
            ConstellationNative.postMessage(JSON.stringify({ type: 'runtime-error', message: String(message).slice(0, 2048) }));
          } catch (_) {}
        }
        window.addEventListener('error', function (event) {
          var detail = String(event.message || 'Unknown runtime error') +
            ' @ ' + String(event.filename || '<inline>') + ':' + String(event.lineno || 0) + ':' + String(event.colno || 0);
          if (event.error && event.error.stack) detail += '\n' + event.error.stack;
          report(detail);
        });
        window.addEventListener('unhandledrejection', function (event) {
          var reason = event.reason;
          report(reason && reason.stack ? reason.stack : String(reason || 'Unhandled rejection'));
        });
      })();
    """.trimIndent()
    const val HTML = "<!doctype html><meta charset=\"utf-8\"><script src=\"/runtime-errors.js\"></script><script crossorigin=\"anonymous\" src=\"/constellation-background.js\"></script>"
    const val STOPPED_STATUS = "{\"state\":\"stopped\",\"location\":{\"status\":\"unavailable\"},\"message\":\"\"}"
  }
}
