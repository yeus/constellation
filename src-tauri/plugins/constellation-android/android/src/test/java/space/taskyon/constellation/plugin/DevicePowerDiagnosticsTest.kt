package space.taskyon.constellation.plugin

import org.junit.Assert.assertTrue
import org.junit.Test

class DevicePowerDiagnosticsTest {
  @Test fun powerDiagnosticsFitThePrivacyJournalEvenWithLongestCauseAndUnknownFields() {
    val snapshot = formatPowerConditionsSnapshot(
      "unknown", "unknown", "unknown", "unknown", "unknown",
      "unknown", "restricted", "unknown", "unknown", "unsupported",
    )
    for (cause in listOf("charging-disconnected", "battery-state", "battery-saver", "screen-off")) {
      val details = "cause=$cause;$snapshot"
      assertTrue("$cause produced ${details.length} characters", details.length <= MAX_JOURNAL_DETAILS_LENGTH)
    }
    assertTrue(snapshot.contains("saver=unknown"))
    assertTrue(snapshot.contains("lowStandby=unsupported"))
  }

  @Test fun normalDiagnosticsFitAndIncludePowerAndBatteryStates() {
    val snapshot = formatPowerConditionsSnapshot(
      "100", "false", "true", "true", "disabled",
      "priority", "restricted", "false", "true", "false",
    )
    assertTrue(snapshot.length <= MAX_JOURNAL_DETAILS_LENGTH)
    assertTrue(snapshot.contains("pct=100"))
    assertTrue(snapshot.contains("saver=false"))
  }
}
