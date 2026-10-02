package space.taskyon.constellation.plugin

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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

class LocationShareService : Service(), LocationListener {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val ioExecutor = Executors.newSingleThreadExecutor()
  private lateinit var store: EncryptedShareStore
  private var webView: WebView? = null
  private var runtimeStarting = false
  private val pendingCommands = mutableListOf<JSONObject>()
  private val pendingCreateIds = mutableSetOf<String>()
  private var runtimeReady = false
  private var runtimeError = false
  private var lastPersistedStatus: String? = null
  private var lastShares: JSONArray? = null
  private var lastViewerCount = 0
  private var watchRequested = false
  private var appliedSampling: String? = null
  private var networkRestriction: String? = null
  private var networkStateSent: String? = null
  private var connectivityManager: ConnectivityManager? = null
  private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) {
      mainHandler.post { updatePolicyState() }
    }

    override fun onLost(network: Network) {
      mainHandler.post { updatePolicyState() }
    }

    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
      mainHandler.post { updatePolicyState() }
    }
  }
  private val restrictBackgroundReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      mainHandler.post { updatePolicyState() }
    }
  }
  private var locationManager: LocationManager? = null
  private var refreshCancellation: CancellationSignal? = null
  private var refreshListener: LocationListener? = null
  private var refreshTimeout: Runnable? = null

  override fun onCreate() {
    super.onCreate()
    ShareServiceContract.serviceRunning = true
    ShareServiceContract.startPending = false
    store = EncryptedShareStore(applicationContext, discardUnreadable = false)
    connectivityManager = getSystemService(ConnectivityManager::class.java)
    runCatching { connectivityManager?.registerDefaultNetworkCallback(networkCallback) }
    runCatching {
      registerReceiver(
        restrictBackgroundReceiver,
        IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED),
      )
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    return try {
      when (action) {
        ShareServiceContract.ACTION_STOP -> {
          queueCommand(JSONObject().put("type", "stop-all"))
          if (webView == null && !store.hasSavedShares()) finishStop()
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
        ShareServiceContract.ACTION_SET_VISIBLE -> {
          queueCommand(
            JSONObject()
              .put("type", "set-visible")
              .put("visible", intent?.getBooleanExtra(ShareServiceContract.EXTRA_VISIBLE, false) ?: false),
          )
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
          if (!store.hasSavedShares() || (action == null && !store.hasBackgroundShares())) {
            finishStop()
            START_NOT_STICKY
          } else {
            startRuntime()
            START_STICKY
          }
        }
        else -> {
          finishStop()
          START_NOT_STICKY
        }
      }
    } catch (error: Exception) {
      failClosed(error.message ?: "Protected location sharing could not be restored.")
      START_NOT_STICKY
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onLocationChanged(location: Location) {
    sendPosition(location, "location")
  }

  private fun sendPosition(location: Location, type: String) {
    send(JSONObject()
      .put("type", type)
      .put("position", locationPositionJson(location)))
  }

  override fun onProviderDisabled(provider: String) {
    val manager = locationManager ?: return
    if (availableLocationProviders(manager).isEmpty()) {
      send(JSONObject().put("type", "location-error").put("code", 2))
    }
  }

  override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

  override fun onDestroy() {
    stopLocationUpdates()
    runCatching { connectivityManager?.unregisterNetworkCallback(networkCallback) }
    runCatching { unregisterReceiver(restrictBackgroundReceiver) }
    connectivityManager = null
    watchRequested = false
    networkRestriction = null
    networkStateSent = null
    ShareServiceContract.networkRestriction = null
    ShareServiceContract.sampling = "balanced"
    webView?.let { view -> mainHandler.post { view.stopLoading(); view.destroy() } }
    webView = null
    runtimeStarting = false
    ShareServiceContract.currentStatus = null
    ShareServiceContract.serviceRunning = false
    ShareServiceContract.startPending = false
    ioExecutor.shutdown()
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
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
        when (request.optString("action")) {
          "load" -> response.put("state", store.loadPrivateState() ?: JSONObject.NULL)
          "save" -> {
            val state = request.optString("state")
            store.savePrivateState(state)
            response.put("state", JSONObject.NULL)
          }
          else -> throw IllegalArgumentException("Unsupported protected-state operation.")
        }
      } catch (_: Exception) {
        response.put("error", "Protected source state could not be opened or saved.")
      }
      send(response)
    }
  }

  private fun handleRuntimeMessage(parsed: JSONObject) {
    when (parsed.optString("type")) {
      "ready" -> {
        runtimeReady = true
        pendingCommands.toList().forEach(::send)
        pendingCommands.clear()
        updatePolicyState(forceSend = true)
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
      "status" -> {
        val status = parsed.optJSONObject("status") ?: return
        ShareServiceContract.currentStatus = status.toString()
        persistStatusIfChanged(status)
        val shares = status.optJSONArray("shares")
        var viewers = 0
        for (index in 0 until (shares?.length() ?: 0)) {
          viewers += shares?.optJSONObject(index)?.optInt("viewerCount", 0) ?: 0
        }
        lastShares = shares
        lastViewerCount = viewers
        runtimeError = status.optString("state") == "error" && (shares?.length() ?: 0) == 0
        updatePolicyState()
        ShareNotification.update(this, notificationBody(shares, viewers))
        stopWhenIdle()
      }
      "idle", "stopped" -> finishStop()
      "paused" -> finishPause()
    }
  }

  private fun notificationBody(shares: JSONArray?, viewers: Int): String {
    val count = shares?.length() ?: 0
    if (count == 0) return "No active links"
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
        else -> "All links paused"
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
    if (allKnownSharesPaused()) return
    if (locationGrant(this) == "none") {
      send(JSONObject().put("type", "location-error").put("code", 1))
      return
    }
    val sampling = samplingFor(lastShares)
    appliedSampling = sampling
    val manager = getSystemService(LocationManager::class.java)
    locationManager = manager
    if (!watchAndroidLocation(
      manager,
      this,
      intervalFor(sampling),
      distanceFor(sampling),
    )) {
      send(JSONObject().put("type", "location-error").put("code", 2))
    }
  }

  private fun stopLocationUpdates() {
    clearRefresh()
    locationManager?.let { manager -> runCatching { manager.removeUpdates(this) } }
    locationManager = null
    appliedSampling = null
  }

  private fun samplingFor(shares: JSONArray?): String {
    val publishing = shareObjects(shares).filter { it.isNull("paused") }
    val relevant = publishing.ifEmpty { shareObjects(shares) }
    return if (relevant.any { it.optString("battery") == "balanced" }) "balanced" else "saver"
  }

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
    val shares = lastShares
    val restriction = connectivityRestriction()
    val networkState = restriction ?: "unmetered"
    if (forceSend || networkState != networkStateSent) {
      networkStateSent = networkState
      queueCommand(JSONObject().put("type", "network-state").put("state", networkState))
    }
    val sampling = samplingFor(shares)
    networkRestriction = restriction
    ShareServiceContract.networkRestriction = restriction
    ShareServiceContract.sampling = sampling
    if (publishingShareCount(shares) == 0) {
      if (locationManager != null) stopLocationUpdates()
    } else if (watchRequested && (locationManager == null || appliedSampling != sampling)) {
      stopLocationUpdates()
      startLocationUpdates()
    }
    ShareNotification.update(this, notificationBody(shares, lastViewerCount))
  }

  private fun clearRefresh() {
    refreshTimeout?.let(mainHandler::removeCallbacks)
    refreshTimeout = null
    refreshCancellation?.cancel()
    refreshCancellation = null
    refreshListener?.let { listener -> locationManager?.removeUpdates(listener) }
    refreshListener = null
  }

  private fun requestFreshLocation() {
    if (allKnownSharesPaused()) return
    if (locationGrant(this) == "none") return
    val manager = locationManager ?: getSystemService(LocationManager::class.java)
    val provider = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
      .firstOrNull { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) } ?: return
    clearRefresh()
    locationManager = manager
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
    startForeground(
      ShareServiceContract.NOTIFICATION_ID,
      ShareNotification.build(this, foregroundNotificationBody()),
    )
    if (webView == null && !runtimeStarting) createRuntime()
  }

  private fun queueCommand(command: JSONObject) {
    if (runtimeReady) send(command) else pendingCommands.add(command)
  }

  private fun stopWhenIdle() {
    if (!runtimeReady || pendingCreateIds.isNotEmpty()) return
    val status = ShareServiceContract.currentStatus?.let { runCatching { JSONObject(it) }.getOrNull() }
      ?: return
    if ((status.optJSONArray("shares")?.length() ?: 0) > 0) return
    if (runtimeError) {
      ShareServiceContract.serviceRunning = false
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      finishStop()
    }
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
    val status = JSONObject()
      .put("state", "error")
      .put("shares", org.json.JSONArray())
      .put("location", JSONObject().put("status", "unavailable"))
      .put("message", message)
      .toString()
    ShareServiceContract.currentStatus = status
    ShareServiceContract.serviceRunning = false
    runCatching { store.saveStatus(redactedStatus(JSONObject(status))) }
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun finishStop() {
    stopLocationUpdates()
    watchRequested = false
    lastShares = null
    lastViewerCount = 0
    networkRestriction = null
    ShareServiceContract.networkRestriction = null
    runCatching { store.saveStatus(STOPPED_STATUS) }
    ShareServiceContract.currentStatus = STOPPED_STATUS
    ShareServiceContract.serviceRunning = false
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun finishPause() {
    stopLocationUpdates()
    watchRequested = false
    lastShares = null
    lastViewerCount = 0
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
    const val BALANCED_UPDATE_INTERVAL_MS = 5_000L
    const val BALANCED_UPDATE_MINIMUM_DISTANCE_METRES = 5f
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
