package space.taskyon.constellation.plugin

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
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

internal fun watchAndroidLocation(
  manager: LocationManager,
  listener: LocationListener,
  intervalMs: Long,
  minimumDistanceMetres: Float,
): Boolean {
  var registered = false
  for (provider in availableLocationProviders(manager)) {
    val success = runCatching {
      manager.requestLocationUpdates(
        provider,
        intervalMs,
        minimumDistanceMetres,
        listener,
        Looper.getMainLooper(),
      )
    }.isSuccess
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
