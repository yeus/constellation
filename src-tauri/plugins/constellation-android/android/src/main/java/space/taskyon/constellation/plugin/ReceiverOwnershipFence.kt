package space.taskyon.constellation.plugin

import android.content.Context
import org.json.JSONObject

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
    // The JS viewer uses a receiver-only projection. The native store remains
    // the single encrypted source of truth for both application roles.
    viewerState.loadPrivateState()
  }

  fun saveServiceState(generation: Long, state: String) = synchronized(LOCK) {
    requireService(generation)
    val current = requiredState()
    val incoming = JSONObject(state)
    requireSameIdentity(current, incoming)
    // Never replace the Activity's outgoing links, end notices, or preferences
    // with the empty values of the unattended viewer runtime.
    for (key in RECEIVER_FIELDS) {
      if (incoming.has(key)) current.put(key, incoming.get(key))
      else current.remove(key)
    }
    viewerState.savePrivateState(current.toString())
  }

  fun loadActivityState(): String? = synchronized(LOCK) {
    viewerState.loadPrivateState()
  }

  fun saveActivityState(state: String) = synchronized(LOCK) {
    val incoming = JSONObject(state)
    if (snapshot().owner == "activity") {
      viewerState.savePrivateState(state)
      return@synchronized
    }

    // The source/UI may change its own records while the service owns follows.
    // Preserve the service's latest receiver fields even if the Activity is
    // holding a stale copy from before background handoff.
    val current = requiredState()
    requireSameIdentity(current, incoming)
    val keys = mutableListOf<String>()
    val iterator = current.keys()
    while (iterator.hasNext()) keys.add(iterator.next())
    for (key in keys) {
      if (key !in RECEIVER_FIELDS && key != "privateKey" && !incoming.has(key))
        current.remove(key)
    }
    val updates = incoming.keys()
    while (updates.hasNext()) {
      val key = updates.next()
      if (key !in RECEIVER_FIELDS && key != "privateKey")
        current.put(key, incoming.get(key))
    }
    viewerState.savePrivateState(current.toString())
  }

  private fun requiredState(): JSONObject =
    JSONObject(viewerState.loadPrivateState()
      ?: throw IllegalStateException("Protected receiver identity is unavailable."))

  private fun requireSameIdentity(current: JSONObject, incoming: JSONObject) {
    check(current.optInt("version") == 1 &&
      incoming.optInt("version") == 1 &&
      current.optString("privateKey").isNotBlank() &&
      current.optString("privateKey") == incoming.optString("privateKey")) {
      "Protected receiver identity changed during background following."
    }
  }

  private fun requireService(generation: Long) {
    val current = snapshot()
    check(current.owner == "service" && current.generation == generation && generation > 0L) {
      "Background receiver state generation is no longer authoritative."
    }
  }

  private companion object {
    // These fields are written by the service while it owns saved follows.
    // All other fields, including outgoing source keys, are Activity-owned.
    val RECEIVER_FIELDS = setOf(
      "followed",
      "oldSeeing",
      "pendingStopNotices",
      "pendingReturns",
    )
    val LOCK = Any()
  }
}
