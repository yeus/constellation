package space.taskyon.constellation.plugin

import android.location.LocationManager
import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidLocationAccessTest {
  private val providers = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)

  @Test fun authorizedExactOneShotUsesGpsWhileNetworkWatchRemainsPreferred() {
    assertEquals(
      LocationManager.GPS_PROVIDER,
      preferredOneShotLocationProvider(providers, networkOnly = false, fineGranted = true, exactShare = true),
    )
    assertEquals(
      LocationManager.NETWORK_PROVIDER,
      preferredOneShotLocationProvider(providers, networkOnly = false, fineGranted = true, exactShare = false),
    )
  }

  @Test fun explicitNetworkOnlyAndCoarsePermissionsNeverChooseGpsForExact() {
    assertEquals(
      LocationManager.NETWORK_PROVIDER,
      preferredOneShotLocationProvider(providers, networkOnly = true, fineGranted = true, exactShare = true),
    )
    assertEquals(
      LocationManager.NETWORK_PROVIDER,
      preferredOneShotLocationProvider(providers, networkOnly = false, fineGranted = false, exactShare = true),
    )
    assertEquals(
      null,
      preferredOneShotLocationProvider(listOf(LocationManager.GPS_PROVIDER), networkOnly = true, fineGranted = true, exactShare = true),
    )
  }

  @Test fun missingGpsFallsBackToNetworkForAnExactOneShot() {
    assertEquals(
      LocationManager.NETWORK_PROVIDER,
      preferredOneShotLocationProvider(listOf(LocationManager.NETWORK_PROVIDER), networkOnly = false, fineGranted = true, exactShare = true),
    )
  }
}
