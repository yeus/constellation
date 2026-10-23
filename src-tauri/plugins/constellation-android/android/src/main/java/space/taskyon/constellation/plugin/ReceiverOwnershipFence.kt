package space.taskyon.constellation.plugin

import android.content.Context

/**
 * Process-wide, persistent writer fence for the Activity's encrypted viewer identity/state.
 * The Activity and the protected WebView service run in one application process.
 * No bearer link or private key is stored by this fence.
 */
internal class ReceiverOwnershipFence(context: Context) {
  private val prefs = context.getSharedPreferences("receiver-ownership-v1", Context.MODE_PRIVATE)
  private val viewerState = EncryptedShareStore(
    context,
    "private-ui-state-v1",
    "constellation-private-ui-state-v1",
    false,
  )

  data class Snapshot(val owner: String, val generation: Long)

  fun snapshot(): Snapshot = synchronized(LOCK) {
    Snapshot(prefs.getString("owner", "activity") ?: "activity", prefs.getLong("generation", 0L))
  }

  fun acquireService(nextGeneration: Long) = synchronized(LOCK) {
    val current = snapshot()
    check(current.owner == "activity" && nextGeneration > current.generation) {
      "Receiver ownership cannot be acquired by a stale runtime."
    }
    check(prefs.edit().putString("owner", "service")
      .putLong("generation", nextGeneration).commit()) {
      "Protected receiver ownership could not be committed."
    }
  }

  fun releaseService(generation: Long) = synchronized(LOCK) {
    requireService(generation)
    check(prefs.edit().putString("owner", "activity").commit()) {
      "Protected receiver ownership could not be released."
    }
  }

  fun loadServiceState(generation: Long): String? = synchronized(LOCK) {
    requireService(generation)
    viewerState.loadPrivateState()
  }

  fun saveServiceState(generation: Long, state: String) = synchronized(LOCK) {
    requireService(generation)
    viewerState.savePrivateState(state)
  }

  fun loadActivityState(): String? = synchronized(LOCK) {
    // Read-only use is permitted, including for foreground status projections.
    viewerState.loadPrivateState()
  }

  fun saveActivityState(state: String) = synchronized(LOCK) {
    check(snapshot().owner == "activity") {
      "A background receiver currently owns protected following data."
    }
    viewerState.savePrivateState(state)
  }

  private fun requireService(generation: Long) {
    val current = snapshot()
    check(current.owner == "service" && current.generation == generation && generation > 0L) {
      "Background receiver state generation is no longer authoritative."
    }
  }

  private companion object {
    val LOCK = Any()
  }
}
