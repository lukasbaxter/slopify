package com.lukasbaxter.slopify.android.core.api

import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.asString
import com.lukasbaxter.slopify.android.core.session.SocketIdentity
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.serializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * One signed-in server. All REST calls go through [get] / [request]; media URLs come from the
 * URL builders so the token rides in the query (API.md §3.1, §11, §12). [baseUrl] can move
 * between the main and the home address at runtime (§4.4).
 *
 * Callbacks run on the caller's coroutine context (the app calls from Main).
 */
class ApiClient(
    @Volatile var baseUrl: String,
    @Volatile var token: String? = null,
    val http: OkHttpClient = defaultHttp(),
) {
    /** Any 401 (except login): the app signs out. */
    var onUnauthorized: (() -> Unit)? = null
    /** 403 "password change required". */
    var onPasswordChangeRequired: (() -> Unit)? = null
    /** true after any server answer, false when the server could not be reached (Connectivity). */
    var onReachability: ((Boolean) -> Unit)? = null

    // Requests

    /**
     * `path` is "/"-separated; a segment escaped with [segment] stays one segment even when it
     * holds "/". Query entries with a null value are left out; the rest are sorted by name.
     */
    fun url(path: String, query: Map<String, String?> = emptyMap()): HttpUrl {
        val b = baseUrl.toHttpUrl().newBuilder()
        for (seg in path.split('/')) if (seg.isNotEmpty()) b.addPathSegment(percentDecode(seg))
        for ((k, v) in query.entries.sortedBy { it.key }) if (v != null) b.addEncodedQueryParameter(queryEncode(k), queryEncode(v))
        return b.build()
    }

    suspend fun <T> get(path: String, query: Map<String, String?> = emptyMap(), strategy: DeserializationStrategy<T>, timeout: Double? = null): T =
        request("GET", path, query, null, strategy, timeout)

    suspend inline fun <reified T> get(path: String, query: Map<String, String?> = emptyMap(), timeout: Double? = null): T =
        get(path, query, serializer<T>(), timeout)

    /** A call whose answer only matters as success (`{ ok }` or empty). */
    suspend fun send(method: String, path: String, body: JsonElement? = null, headers: Map<String, String> = emptyMap()) {
        request(method, path, emptyMap(), body, JsonElement.serializer(), null, headers)
    }

    /** A call with a typed answer. */
    suspend inline fun <reified T> call(method: String, path: String, body: JsonElement? = null, timeout: Double? = null, headers: Map<String, String> = emptyMap()): T =
        request(method, path, emptyMap(), body, serializer<T>(), timeout, headers)

    /** Raw bytes upload (covers, avatar). */
    suspend fun <T> upload(path: String, bytes: ByteArray, contentType: String, strategy: DeserializationStrategy<T>, headers: Map<String, String> = emptyMap()): T {
        val req = Request.Builder().url(url(path)).post(bytes.toRequestBody(contentType.toMediaType()))
        headers.forEach { (k, v) -> req.header(k, v) }
        return perform(req, strategy, null)
    }

    suspend fun <T> request(
        method: String,
        path: String,
        query: Map<String, String?>,
        body: JsonElement?,
        strategy: DeserializationStrategy<T>,
        timeout: Double?,
        headers: Map<String, String> = emptyMap(),
    ): T {
        val rb: RequestBody? = when {
            body != null -> body.toString().toRequestBody(JSON)
            method == "GET" || method == "HEAD" || method == "DELETE" -> null
            else -> ByteArray(0).toRequestBody(null)
        }
        val req = Request.Builder().url(url(path, query)).method(method, rb)
        headers.forEach { (k, v) -> req.header(k, v) }
        return perform(req, strategy, timeout)
    }

    suspend fun <T> perform(builder: Request.Builder, strategy: DeserializationStrategy<T>, timeout: Double?): T {
        token?.let { builder.header("Authorization", "Bearer $it") }
        builder.header("Accept", "application/json")
        val req = builder.build()
        val client = if (timeout == null) http else {
            val ms = (timeout * 1000).toLong()
            http.newBuilder().callTimeout(ms, TimeUnit.MILLISECONDS).readTimeout(ms, TimeUnit.MILLISECONDS).build()
        }
        val (status, message, data) = try {
            client.newCall(req).awaitUse { r -> Triple(r.code, r.message, r.body?.string() ?: "") }
        } catch (e: IOException) {
            // Like the web, a timeout alone says nothing about the link (a slow server).
            if (!isTimeout(e) && isUnreachable(e)) onReachability?.invoke(false)
            throw ApiError.Offline(e)
        }
        onReachability?.invoke(true)
        if (status !in 200..299) {
            val msg = runCatching { (SlopifyJson.parseToJsonElement(data) as? JsonObject)?.get("error").asString() }.getOrNull()
                ?: message.ifEmpty { "HTTP $status" }
            if (status == 401 && !req.url.encodedPath.endsWith("/auth/login")) {
                onUnauthorized?.invoke(); throw ApiError.Unauthorized()
            }
            if (status == 403 && msg == ApiError.PASSWORD_CHANGE) {
                onPasswordChangeRequired?.invoke(); throw ApiError.PasswordChangeRequired()
            }
            throw ApiError.Http(status, msg)
        }
        return try {
            SlopifyJson.decodeFromString(strategy, data.ifBlank { "{}" })
        } catch (e: Exception) {
            throw ApiError.Decoding("${req.url.encodedPath}: ${e.message}", e)
        }
    }

    // Media URLs (token in the query: GET only)

    /** Album cover by art hash (immutable). Snaps to 64/160/320/640. */
    fun artUrl(hash: String, size: Int): HttpUrl {
        val snapped = listOf(64, 160, 320, 640).firstOrNull { it >= size } ?: 640
        return url("api/art/$hash/$snapped.webp")
    }

    /** Picture by id: album, track, artist, playlist (pl_), folder (fd_). `bust` = playlist cover hash. */
    fun imageUrl(id: String, size: Int, banner: Boolean = false, bust: String? = null): HttpUrl =
        url(
            "api/image/$id",
            mapOf("size" to size.toString(), "kind" to if (banner) "banner" else null, "w" to if (banner) size.toString() else null, "c" to bust?.take(10)),
        )

    /** HLS master for a track. `max`: aac-96 | aac-160 | aac-320 | alac. `norm`: track | album | null. */
    fun hlsUrl(trackId: String, max: String, norm: String?): HttpUrl =
        url("api/stream/$trackId/hls/master.m3u8", mapOf("max" to max, "norm" to if (max == "alac") null else norm, "token" to token))

    fun wholeFileUrl(trackId: String, profile: String, norm: String?): HttpUrl =
        url("api/stream/$trackId/whole/$profile", mapOf("norm" to norm, "token" to token))

    fun downloadUrl(trackId: String, fmt: String = "original"): HttpUrl =
        url("api/download/$trackId", mapOf("fmt" to fmt, "token" to token))

    fun avatarUrl(userId: String): HttpUrl = url("api/users/$userId/avatar")

    /** `ws(s)://<base>/api/ws`. The token goes in `hello`, never in the URL. */
    val webSocketUrl: String get() = SocketIdentity.webSocketUrl(baseUrl)

    companion object {
        private val JSON = "application/json".toMediaType()

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        /** One path segment from free text (a genre name): every reserved character escaped. */
        fun segment(s: String): String = buildString {
            for (b in s.toByteArray(Charsets.UTF_8)) {
                val c = b.toInt().toChar()
                if (b >= 0 && (c.isLetterOrDigit() || c in "-._~")) append(c) else append('%').append(HEX[(b.toInt() shr 4) and 0xF]).append(HEX[b.toInt() and 0xF])
            }
        }

        private const val HEX = "0123456789ABCDEF"
        // URLQueryItem's allowed set minus the characters that would break a pair ('&', '=', '+').
        private const val QUERY_SAFE = "-._~!$'()*,;:@/?"

        internal fun queryEncode(s: String): String = buildString {
            for (b in s.toByteArray(Charsets.UTF_8)) {
                val c = b.toInt().toChar()
                if (b >= 0 && (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c in QUERY_SAFE)) append(c)
                else append('%').append(HEX[(b.toInt() shr 4) and 0xF]).append(HEX[b.toInt() and 0xF])
            }
        }

        /** `%XX` -> byte; anything malformed is kept as typed. `+` stays `+` (paths). */
        internal fun percentDecode(s: String): String {
            if ('%' !in s) return s
            val out = java.io.ByteArrayOutputStream()
            var i = 0
            val bytes = s.toByteArray(Charsets.UTF_8)
            while (i < bytes.size) {
                val b = bytes[i]
                if (b == '%'.code.toByte() && i + 2 < bytes.size) {
                    val h = Character.digit(bytes[i + 1].toInt(), 16)
                    val l = Character.digit(bytes[i + 2].toInt(), 16)
                    if (h >= 0 && l >= 0) { out.write(h * 16 + l); i += 3; continue }
                }
                out.write(b.toInt()); i++
            }
            return out.toString(Charsets.UTF_8.name())
        }

        private fun isTimeout(e: IOException): Boolean =
            e is java.net.SocketTimeoutException || (e is InterruptedIOException && e.message == "timeout")

        private fun isUnreachable(e: IOException): Boolean =
            e is UnknownHostException || e is ConnectException || e is NoRouteToHostException || e is SocketException
    }
}

/**
 * The call, with [block] (which reads the body) run on IO, never on the caller's thread: the
 * app calls from Main, and reading a body there throws NetworkOnMainThreadException (11-12).
 */
internal suspend fun <T> Call.awaitUse(block: (Response) -> T): T = withContext(Dispatchers.IO) { await().use(block) }

/** OkHttp call as a cancellable suspend. Read the body through [awaitUse], not after this returns. */
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(e) }
        override fun onResponse(call: Call, response: Response) {
            if (cont.isActive) cont.resume(response) else response.close()
        }
    })
}
