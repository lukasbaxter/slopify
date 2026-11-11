package com.lukasbaxter.slopify.android.core.auth

import com.lukasbaxter.slopify.android.core.api.await
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.asString
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Proves a home (LAN) address is really this server before any token goes to it (API.md §4.3). */
object HomeProof {
    private val rng = SecureRandom()

    fun nonce(): String = ByteArray(16).also { rng.nextBytes(it) }.toHex()

    fun expected(keyHex: String, nonce: String): String? {
        val key = keyHex.hexToBytesOrNull() ?: return null
        if (key.isEmpty()) return null
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
        return mac.doFinal(nonce.toByteArray(Charsets.UTF_8)).toHex()
    }

    fun verify(keyHex: String, nonce: String, proof: String): Boolean {
        val want = expected(keyHex, nonce) ?: return false
        if (want.length != proof.length) return false
        // constant time
        var diff = 0
        val got = proof.lowercase()
        for (i in want.indices) diff = diff or (want[i].code xor got[i].code)
        return diff == 0
    }

    /** Asks `home` for a proof. No token is sent. Short timeout: this runs on every network change. */
    suspend fun check(http: OkHttpClient, home: String, userId: String, keyHex: String, timeoutSeconds: Double): Boolean {
        val n = nonce()
        val url = runCatching {
            home.toHttpUrl().newBuilder().addPathSegments("api/server/proof").addQueryParameter("u", userId).addQueryParameter("n", n).build()
        }.getOrNull() ?: return false
        val ms = (timeoutSeconds * 1000).toLong()
        val client = http.newBuilder().callTimeout(ms, TimeUnit.MILLISECONDS).build()
        val req = Request.Builder().url(url).header("Cache-Control", "no-cache").get().build()
        return runCatching {
            client.newCall(req).await().use { r ->
                if (r.code != 200) return@use false
                val proof = (SlopifyJson.parseToJsonElement(r.body?.string() ?: "") as? JsonObject)?.get("proof").asString() ?: return@use false
                verify(keyHex, n, proof)
            }
        }.getOrDefault(false)
    }
}

internal fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xFF) }

internal fun String.hexToBytesOrNull(): ByteArray? {
    if (length % 2 != 0) return null
    val out = ByteArray(length / 2)
    for (i in out.indices) {
        val h = Character.digit(this[2 * i], 16)
        val l = Character.digit(this[2 * i + 1], 16)
        if (h < 0 || l < 0) return null
        out[i] = (h * 16 + l).toByte()
    }
    return out
}
