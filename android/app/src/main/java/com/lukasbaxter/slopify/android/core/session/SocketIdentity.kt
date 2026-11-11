package com.lukasbaxter.slopify.android.core.session

import com.lukasbaxter.slopify.android.core.storage.KeyValueStore
import java.security.SecureRandom

/** The ids sent in `hello` (API.md §20.3, §2). */
object SocketIdentity {
    const val STORE_KEY = "slopify.clientId"
    private val rng = SecureRandom()

    /** Random per process launch: lets the server tell a reconnect from a second copy. */
    val instance: String = "i_" + random(16)

    /** Persisted per install. A stored value that does not match the server's rule is replaced. */
    fun clientId(store: KeyValueStore): String {
        store.getString(STORE_KEY)?.let { if (isValid(it)) return it }
        val id = "c_" + random(16)
        store.putString(STORE_KEY, id)
        return id
    }

    /** `^[\w-]{4,64}$` (ASCII), never `server:*` (the colon already fails the pattern). */
    fun isValid(id: String): Boolean = id.length in 4..64 && id.all { it == '_' || it == '-' || it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' }

    fun random(n: Int): String {
        val chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        return String(CharArray(n) { chars[rng.nextInt(chars.length)] })
    }

    /** ws/wss + /api/ws, same rule as `ApiClient.webSocketUrl`. */
    fun webSocketUrl(base: String): String {
        val b = base.trimEnd('/')
        return when {
            b.startsWith("https://", ignoreCase = true) -> "wss://" + b.substring(8)
            b.startsWith("http://", ignoreCase = true) -> "ws://" + b.substring(7)
            else -> b
        } + "/api/ws"
    }
}
