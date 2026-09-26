package space.taskyon.constellation.plugin

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

internal class EncryptedShareStore(
  context: Context,
  preferencesName: String = "background-share-v1",
  private val keyAlias: String = "constellation-background-share-v1",
  private val discardUnreadable: Boolean = true,
) {
  private val preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)

  @Synchronized
  fun saveStatus(value: String) = save("status", value, 32768)

  @Synchronized
  fun loadStatus(): String? = load("status")

  @Synchronized
  fun savePrivateState(value: String) = save("private-state", value, 131072)

  @Synchronized
  fun loadPrivateState(): String? = load("private-state")

  @Synchronized
  fun hasSavedShares(): Boolean =
    (loadPrivateState()?.let { state -> JSONObject(state).optJSONArray("shares")?.length() } ?: 0) > 0

  @Synchronized
  fun hasBackgroundShares(): Boolean {
    val shares = loadPrivateState()?.let { state -> JSONObject(state).optJSONArray("shares") }
      ?: return false
    return (0 until shares.length()).any { index ->
      shares.optJSONObject(index)?.optString("publication") == "background"
    }
  }

  private fun save(name: String, value: String, maximumLength: Int) {
    require(value.isNotBlank() && value.length <= maximumLength) { "Background share state is invalid." }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    val record = JSONObject()
      .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
    check(preferences.edit().putString(name, record.toString()).commit()) {
      "Protected state could not be saved."
    }
  }

  private fun load(name: String): String? {
    val stored = preferences.getString(name, null) ?: return null
    return try {
      val record = JSONObject(stored)
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(
        Cipher.DECRYPT_MODE,
        key(),
        GCMParameterSpec(128, Base64.decode(record.getString("iv"), Base64.NO_WRAP)),
      )
      String(
        cipher.doFinal(Base64.decode(record.getString("ciphertext"), Base64.NO_WRAP)),
        Charsets.UTF_8,
      )
    } catch (error: Exception) {
      if (!discardUnreadable) throw IllegalStateException("Protected state is unreadable.", error)
      preferences.edit().remove(name).apply()
      null
    }
  }

  private fun key(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(
        KeyGenParameterSpec.Builder(
          keyAlias,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .build(),
      )
      generateKey()
    }
  }

  private companion object {
    const val TRANSFORMATION = "AES/GCM/NoPadding"
  }
}
