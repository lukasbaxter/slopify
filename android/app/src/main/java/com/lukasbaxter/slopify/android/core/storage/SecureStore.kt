package com.lukasbaxter.slopify.android.core.storage

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import kotlinx.serialization.KSerializer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Small secret values (token, server key): the iOS Keychain's role. */
interface SecureStore {
    fun load(key: String): String?
    fun save(key: String, value: String)
    fun delete(key: String)
}

fun <T> SecureStore.loadJson(key: String, serializer: KSerializer<T>): T? =
    load(key)?.let { runCatching { SlopifyJson.decodeFromString(serializer, it) }.getOrNull() }

fun <T> SecureStore.saveJson(key: String, serializer: KSerializer<T>, value: T) =
    save(key, SlopifyJson.encodeToString(serializer, value))

/**
 * AES-256-GCM with a non-exportable Android Keystore key; ciphertext in private
 * SharedPreferences. Device-only (not in backups: see backup rules). Usable while locked,
 * so background playback can still read the token. A value that no longer decrypts
 * (key wiped, restored from another device) reads as absent.
 */
class KeystoreSecureStore(private val prefs: SharedPreferences) : SecureStore {
    constructor(context: Context) : this(context.getSharedPreferences("slopify.secure", Context.MODE_PRIVATE))

    override fun load(key: String): String? {
        val stored = prefs.getString(key, null) ?: return null
        return runCatching {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_LEN))
            String(cipher.doFinal(bytes, IV_LEN, bytes.size - IV_LEN), Charsets.UTF_8)
        }.getOrNull()
    }

    override fun save(key: String, value: String) {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val out = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit { putString(key, Base64.encodeToString(out, Base64.NO_WRAP)) }
    }

    override fun delete(key: String) = prefs.edit { remove(key) }

    @Synchronized
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "slopify.secure.v1"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_LEN = 12
    }
}
