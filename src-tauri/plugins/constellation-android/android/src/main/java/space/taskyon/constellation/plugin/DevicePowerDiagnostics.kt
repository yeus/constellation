package space.taskyon.constellation.plugin

import android.app.NotificationManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager

/** Best-effort, privacy-safe device state; unsupported readings stay unknown. */
internal fun powerConditionsSnapshot(context: Context): String {
  val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
  val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
  val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
  val percent = if (level >= 0 && scale > 0) (level * 100 / scale).toString() else "unknown"
  val low = battery?.getBooleanExtra(BatteryManager.EXTRA_BATTERY_LOW, false)?.toString() ?: "unknown"
  val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)?.let {
    if (it < 0) "unknown" else (it != 0).toString()
  } ?: "unknown"
  val charging = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)?.let {
    when (it) {
      BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> "true"
      -1, BatteryManager.BATTERY_STATUS_UNKNOWN -> "unknown"
      else -> "false"
    }
  } ?: "unknown"
  val power = context.getSystemService(PowerManager::class.java)
  val network = context.getSystemService(ConnectivityManager::class.java)
  val dataSaver = runCatching {
    when (network?.getRestrictBackgroundStatus()) {
      ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED -> "enabled"
      ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED -> "exempt"
      ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED -> "disabled"
      else -> "unknown"
    }
  }.getOrDefault("unknown")
  val dnd = runCatching {
    when (context.getSystemService(NotificationManager::class.java)?.getCurrentInterruptionFilter()) {
      NotificationManager.INTERRUPTION_FILTER_ALL -> "off"
      NotificationManager.INTERRUPTION_FILTER_PRIORITY -> "priority"
      NotificationManager.INTERRUPTION_FILTER_ALARMS -> "alarms"
      NotificationManager.INTERRUPTION_FILTER_NONE -> "none"
      else -> "unknown"
    }
  }.getOrDefault("unknown")
  val standby = runCatching {
    when (context.getSystemService(UsageStatsManager::class.java)?.getAppStandbyBucket()) {
      UsageStatsManager.STANDBY_BUCKET_ACTIVE -> "active"
      UsageStatsManager.STANDBY_BUCKET_WORKING_SET -> "working"
      UsageStatsManager.STANDBY_BUCKET_FREQUENT -> "frequent"
      UsageStatsManager.STANDBY_BUCKET_RARE -> "rare"
      UsageStatsManager.STANDBY_BUCKET_RESTRICTED -> "restricted"
      else -> "unknown"
    }
  }.getOrDefault("unknown")
  val lowStandby = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    runCatching { power?.isLowPowerStandbyEnabled?.toString() ?: "unknown" }.getOrDefault("unknown")
  } else "unsupported"
  return formatPowerConditionsSnapshot(
    percent, low, charging, plugged, dataSaver, dnd, standby,
    power?.isPowerSaveMode?.toString() ?: "unknown",
    power?.isInteractive?.toString() ?: "unknown", lowStandby,
  )
}

// Compact field names keep even the longest change event below the journal's
// 180-character limit. This must be checked in a native regression test.
internal fun formatPowerConditionsSnapshot(
  percent: String, low: String, charging: String, plugged: String, dataSaver: String,
  dnd: String, standby: String, saver: String, screen: String, lowStandby: String,
): String = listOf(
  "pct=$percent", "low=$low", "charge=$charging", "plug=$plugged",
  "data=$dataSaver", "dnd=$dnd", "bucket=$standby",
  "saver=$saver", "screen=$screen", "lowStandby=$lowStandby",
).joinToString(";")
