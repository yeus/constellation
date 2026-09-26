package space.taskyon.constellation.plugin

import android.Manifest
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.app.ActivityCompat
import java.io.ByteArrayInputStream
import org.json.JSONObject

class LocationShareService : Service(), LocationListener {
  private val mainHandler = Handler(Looper.getMainLooper())
  private lateinit var store: EncryptedShareStore
  private var webView: WebView? = null
  private var pendingRequest: String? = null
  private var locationManager: LocationManager? = null
  private var refreshCancellation: CancellationSignal? = null
  private var refreshListener: LocationListener? = null
  private var refreshTimeout: Runnable? = null
  private var expiryTask: Runnable? = null
  private var stopTask: Runnable? = null

  override fun onCreate() {
    super.onCreate()
    store = EncryptedShareStore(applicationContext)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ShareServiceContract.ACTION_STOP) {
      requestStop()
      return START_NOT_STICKY
    }
    if (intent?.action == ShareServiceContract.ACTION_BLOCK_VIEWER) {
      if (pendingRequest != null && webView != null) {
        send(JSONObject()
          .put("type", "block-viewer")
          .put("shareId", intent.getStringExtra(ShareServiceContract.EXTRA_SHARE_ID))
          .put("fingerprint", intent.getStringExtra(ShareServiceContract.EXTRA_FINGERPRINT)))
      }
      return START_NOT_STICKY
    }
    val request = intent?.getStringExtra(ShareServiceContract.EXTRA_REQUEST)
    if (request == null) {
      failClosed("Background sharing stopped because its peer identity cannot be restored.")
      return START_NOT_STICKY
    }
    if (expired(request)) {
      finishStop()
      return START_NOT_STICKY
    }
    pendingRequest = request
    startForeground(
      ShareServiceContract.NOTIFICATION_ID,
      ShareNotification.build(this, "Starting private P2P sharing…"),
    )
    scheduleExpiry(request)
    if (webView == null) createRuntime()
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onLocationChanged(location: Location) {
    sendPosition(location, "location")
  }

  private fun sendPosition(location: Location, type: String) {
    val coords = JSONObject()
      .put("latitude", location.latitude)
      .put("longitude", location.longitude)
      .put("accuracy", location.accuracy.toDouble())
      .put("altitude", if (location.hasAltitude()) location.altitude else JSONObject.NULL)
      .put("heading", if (location.hasBearing()) location.bearing.toDouble() else JSONObject.NULL)
      .put("speed", if (location.hasSpeed()) location.speed.toDouble() else JSONObject.NULL)
    send(JSONObject()
      .put("type", type)
      .put("position", JSONObject().put("timestamp", location.time).put("coords", coords)))
  }

  override fun onProviderDisabled(provider: String) {
    send(JSONObject().put("type", "location-error").put("code", 2))
  }

  override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

  override fun onDestroy() {
    stopLocationUpdates()
    expiryTask?.let(mainHandler::removeCallbacks)
    stopTask?.let(mainHandler::removeCallbacks)
    webView?.let { view -> mainHandler.post { view.stopLoading(); view.destroy() } }
    webView = null
    ShareServiceContract.currentStatus = null
    super.onDestroy()
  }

  private fun createRuntime() {
    mainHandler.post {
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
      view.loadUrl(PAGE_URL)
    }
  }

  private fun runtimeClient() = object : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
      request.url.toString() !in setOf(PAGE_URL, SCRIPT_URL)

    override fun shouldInterceptRequest(
      view: WebView,
      request: WebResourceRequest,
    ): WebResourceResponse = when (request.url.toString()) {
      PAGE_URL -> response("text/html", HTML.toByteArray())
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
      mainHandler.post { handleRuntimeMessage(message) }
    }
  }

  private fun handleRuntimeMessage(message: String) {
    val parsed = runCatching { JSONObject(message) }.getOrNull() ?: return
    when (parsed.optString("type")) {
      "ready" -> pendingRequest?.let { request ->
        send(JSONObject().put("type", "start").put("request", JSONObject(request)))
      }
      "location-watch-start" -> startLocationUpdates()
      "location-watch-stop" -> stopLocationUpdates()
      "location-refresh" -> requestFreshLocation()
      "status" -> {
        val status = parsed.optJSONObject("status") ?: return
        ShareServiceContract.currentStatus = status.toString()
        store.saveStatus(redactedStatus(status))
        val viewers = status.optJSONObject("share")?.optInt("viewerCount", 0) ?: 0
        ShareNotification.update(
          this,
          if (viewers == 1) "1 connected viewer" else "$viewers connected viewers",
        )
      }
      "expired", "stopped" -> finishStop()
    }
  }

  private fun startLocationUpdates() {
    if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) !=
      PackageManager.PERMISSION_GRANTED) {
      send(JSONObject().put("type", "location-error").put("code", 1))
      return
    }
    val manager = getSystemService(LocationManager::class.java)
    locationManager = manager
    for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
      if (runCatching { manager.isProviderEnabled(provider) }.getOrDefault(false)) {
        runCatching {
          manager.requestLocationUpdates(
            provider,
            LOCATION_UPDATE_INTERVAL_MS,
            LOCATION_UPDATE_MINIMUM_DISTANCE_METRES,
            this,
            Looper.getMainLooper(),
          )
        }
      }
    }
  }

  private fun stopLocationUpdates() {
    clearRefresh()
    locationManager?.let { manager -> runCatching { manager.removeUpdates(this) } }
    locationManager = null
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
    if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) !=
      PackageManager.PERMISSION_GRANTED) return
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
    val listener = object : LocationListener {
      override fun onLocationChanged(location: Location) {
        clearRefresh()
        sendPosition(location, "location-refresh-result")
      }
    }
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
      webView?.evaluateJavascript("window.__constellationBackgroundCommand?.($encoded)", null)
    }
  }

  private fun scheduleExpiry(request: String) {
    expiryTask?.let(mainHandler::removeCallbacks)
    val expiresAt = JSONObject(request).optLong("expiresAt", -1L)
    if (expiresAt < 0) return
    val task = Runnable { requestStop() }
    expiryTask = task
    mainHandler.postDelayed(task, (expiresAt - System.currentTimeMillis()).coerceAtLeast(0L))
  }

  private fun expired(request: String): Boolean {
    val expiresAt = runCatching { JSONObject(request).optLong("expiresAt", -1L) }.getOrDefault(0L)
    return expiresAt >= 0 && System.currentTimeMillis() >= expiresAt
  }

  private fun redactedStatus(status: JSONObject): String = JSONObject(status.toString())
    .put("location", JSONObject().put("status", "unavailable"))
    .apply {
      remove("diagnostics")
      remove("returnOffers")
    }
    .toString()

  private fun failClosed(message: String) {
    val status = JSONObject()
      .put("state", "error")
      .put("location", JSONObject().put("status", "unavailable"))
      .put("message", message)
      .toString()
    ShareServiceContract.currentStatus = status
    store.saveStatus(status)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun requestStop() {
    if (webView == null) {
      finishStop()
      return
    }
    send(JSONObject().put("type", "stop"))
    stopTask?.let(mainHandler::removeCallbacks)
    val task = Runnable { finishStop() }
    stopTask = task
    mainHandler.postDelayed(task, 3_000L)
  }

  private fun finishStop() {
    stopTask?.let(mainHandler::removeCallbacks)
    stopTask = null
    stopLocationUpdates()
    store.clear()
    store.saveStatus(STOPPED_STATUS)
    ShareServiceContract.currentStatus = STOPPED_STATUS
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun response(mime: String, bytes: ByteArray) = WebResourceResponse(
    mime,
    "utf-8",
    200,
    "OK",
    mapOf("Content-Security-Policy" to "default-src 'none'; script-src 'self'; connect-src https: wss: ws:"),
    ByteArrayInputStream(bytes),
  )

  private companion object {
    const val PAGE_URL = "https://constellation.invalid/runtime.html"
    const val SCRIPT_URL = "https://constellation.invalid/constellation-background.js"
    const val LOCATION_UPDATE_INTERVAL_MS = 5_000L
    const val LOCATION_UPDATE_MINIMUM_DISTANCE_METRES = 5f
    const val HTML = "<!doctype html><meta charset=\"utf-8\"><script src=\"/constellation-background.js\"></script>"
    const val STOPPED_STATUS = "{\"state\":\"stopped\",\"location\":{\"status\":\"unavailable\"},\"message\":\"\"}"
  }
}
