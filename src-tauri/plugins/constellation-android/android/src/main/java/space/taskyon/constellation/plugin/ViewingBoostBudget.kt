package space.taskyon.constellation.plugin

import java.util.ArrayDeque

/**
 * Monotonic, process-local energy cap. Records only elapsed boosted intervals; never
 * records coordinates, viewer identities or links. Does not grant any authorization.
 */
internal class ViewingBoostBudget(
  // A full ten-minute allowance in a ten-minute rolling window is an
  // unlimited duty cycle. Reserve at least ten minutes for saver mode.
  private val windowMs: Long = 1_200_000L,
  private val limitMs: Long = 600_000L,
) {
  private val spent = ArrayDeque<Pair<Long, Long>>()
  private var lastSampleAt = -1L
  private var previousBoostUntil = 0L

  /**
   * Returns a monotonic elapsedRealtime deadline, or zero if the source must
   * remain in saver mode. An inactive request immediately revokes the boost.
   */
  fun permittedUntil(now: Long, demandUntil: Long, enabled: Boolean): Long {
    if (lastSampleAt >= 0 && previousBoostUntil > lastSampleAt) {
      val end = minOf(now, previousBoostUntil)
      if (end > lastSampleAt) spent.addLast(lastSampleAt to end)
    }
    lastSampleAt = now
    val cutoff = now - windowMs
    while (!spent.isEmpty() && spent.peekFirst().second <= cutoff) spent.removeFirst()
    if (!spent.isEmpty() && spent.peekFirst().first < cutoff) {
      val first = spent.removeFirst()
      spent.addFirst(cutoff to first.second)
    }
    val used = spent.sumOf { it.second - it.first }
    val remaining = (limitMs - used).coerceAtLeast(0L)
    previousBoostUntil = if (enabled && demandUntil > now && remaining > 0) {
      minOf(demandUntil, now + remaining)
    } else 0L
    return previousBoostUntil
  }
}
