package space.taskyon.constellation.plugin

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import androidx.core.content.ContextCompat
import org.json.JSONObject

internal fun locationGrant(context: Context): String = when {
  ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
    PackageManager.PERMISSION_GRANTED -> "fine"
  ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
    PackageManager.PERMISSION_GRANTED -> "coarse"
  else -> "none"
}

internal fun availableLocationProviders(manager: LocationManager): List<String> =
  listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
    .filter { provider -> runCatching { manager.isProviderEnabled(provider) }.getOrDefault(false) }

/**
 * Initial refresh is issued only by an authorized sensor subscription.
 * Exact sharing can request one GPS fix while the ongoing background watch
 * remains network-first; explicit network-only policy always excludes GPS.
 */
internal fun preferredOneShotLocationProvider(
  available: List<String>,
  networkOnly: Boolean,
  fineGranted: Boolean,
  exactShare: Boolean,
): String? {
  val priority = when {
    networkOnly -> listOf(LocationManager.NETWORK_PROVIDER)
    fineGranted && exactShare -> listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
    else -> listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
  }
  return priority.firstOrNull { it in available }
}

internal fun androidLocationListener(
  onLocationChanged: (Location) -> Unit,
  onProviderDisabled: (String) -> Unit = {},
): LocationListener = object : LocationListener {
  override fun onLocationChanged(location: Location) = onLocationChanged(location)

  override fun onProviderDisabled(provider: String) = onProviderDisabled(provider)

  override fun onProviderEnabled(provider: String) = Unit

  @Suppress("DEPRECATION")
  override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
}

internal fun watchAndroidLocation(
  manager: LocationManager,
  listener: LocationListener,
  intervalMs: Long,
  minimumDistanceMetres: Float,
  preferredProvider: String? = null,
  allowFallback: Boolean = true,
): Boolean {
  val providers = availableLocationProviders(manager)
  val selected = if (preferredProvider == null) providers else
    listOfNotNull(preferredProvider.takeIf { it in providers }) +
      (if (allowFallback) providers.filter { it != preferredProvider } else emptyList())
  var registered = false
  for (provider in selected) {
    val success = runCatching {
      manager.requestLocationUpdates(
        provider,
        intervalMs,
        minimumDistanceMetres,
        listener,
        Looper.getMainLooper(),
      )
    }.isSuccess
    if (preferredProvider != null && success) return true
    registered = registered || success
  }
  return registered
}

internal fun locationPositionJson(location: Location): JSONObject {
  val coords = JSONObject()
    .put("latitude", location.latitude)
    .put("longitude", location.longitude)
    .put("accuracy", location.accuracy.toDouble())
    .put("altitude", if (location.hasAltitude()) location.altitude else JSONObject.NULL)
    .put("heading", if (location.hasBearing()) location.bearing.toDouble() else JSONObject.NULL)
    .put("speed", if (location.hasSpeed()) location.speed.toDouble() else JSONObject.NULL)
  return JSONObject().put("timestamp", location.time).put("coords", coords)
}
