package space.taskyon.constellation.plugin

import android.content.Context
import java.io.File
import java.io.Writer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Device-private, date-partitioned operational events. Never pass coordinates, URLs or identities. */
internal class ReliabilityJournal(context: Context) {
  private var lastPrunedDay: String? = null
  private val directory = File(context.filesDir, "reliability-journal-v1")
  private val dayFormat = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }

  @Synchronized
  fun record(event: String, details: String = "") {
    // Logging must never terminate an otherwise healthy background service.
    if (!event.matches(Regex("[a-z][a-z0-9.-]{1,63}")) ||
      details.length > 180 || !details.matches(Regex("[a-zA-Z0-9 ;=,._:-]*"))) return
    runCatching {
      if (!directory.isDirectory && !directory.mkdirs()) return
      val now = System.currentTimeMillis()
      val today = dayFormat.format(Date(now))
      val file = File(directory, "$today.log")
      if (!file.isFile || file.length() < MAX_DAY_BYTES) {
        file.appendText("$now $event${if (details.isBlank()) "" else " $details"}\n")
      }
      if (today != lastPrunedDay) {
        directory.listFiles()?.forEach { previous ->
          if (!previous.name.matches(Regex("\\d{4}-\\d{2}-\\d{2}\\.log")) ||
            previous.name < dayFormat.format(Date(now - (RETENTION_DAYS - 1) * DAY_MS))) {
            previous.delete()
          }
        }
        lastPrunedDay = today
      }
    }
  }

  @Synchronized
  fun writeTo(writer: Writer) {
    if (!directory.isDirectory) return
    val today = System.currentTimeMillis()
    directory.listFiles().orEmpty()
      .filter { it.name.matches(Regex("\\d{4}-\\d{2}-\\d{2}\\.log")) &&
        it.name >= dayFormat.format(Date(today - (RETENTION_DAYS - 1) * DAY_MS)) }
      .sortedBy { it.name }
      .forEach { file -> file.bufferedReader().use { reader -> reader.copyTo(writer) } }
  }

  companion object {
    const val RETENTION_DAYS = 14L
    const val MAX_DAY_BYTES = 4_000_000L
    private const val DAY_MS = 86_400_000L
  }
}
