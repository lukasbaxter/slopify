package com.lukasbaxter.slopify.android.design.image

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.lukasbaxter.slopify.android.core.api.await
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
import okhttp3.Cache
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException

/**
 * Loads and caches artwork (ios Design/Image/ImageLoader.swift). Decoded images live in memory
 * (an LRU by bytes); bytes live in a dedicated 512 MB OkHttp disk cache that honours the
 * server's headers (immutable `/api/art`, 24 h `/api/image`, ETag revalidation for playlists,
 * API.md §11). Requests send `Accept: image/webp,image/jpeg`. Identical requests in flight
 * are shared. Never throws: a failure is null.
 */
class ImageLoader(
    cacheDir: File? = null,
    diskBytes: Long = 512L shl 20,
    memoryBytes: Long = 64L shl 20,
    base: OkHttpClient? = null,
    /** Bytes to a drawable image; the default decodes with BitmapFactory. Tests swap it. */
    private val decode: (ByteArray) -> ImageBitmap? = { decodeBitmap(it) },
) {
    val http: OkHttpClient = (base?.newBuilder() ?: OkHttpClient.Builder())
        .apply { if (cacheDir != null && diskBytes > 0) cache(Cache(File(cacheDir, "artwork"), diskBytes)) }
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    private val memory = ByteLru(memoryBytes)
    private val inflight = HashMap<String, Deferred<ImageBitmap?>>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Already decoded (no I/O): lets a view paint on its first frame without a flash. */
    fun cached(url: String): ImageBitmap? = memory[url]

    /** The image at `url`, or null (404, network, undecodable). */
    suspend fun image(url: String): ImageBitmap? {
        cached(url)?.let { return it }
        val task = synchronized(inflight) {
            inflight.getOrPut(url) { scope.async { fetch(url) } }
        }
        return try {
            task.await()
        } finally {
            synchronized(inflight) { if (inflight[url] === task && task.isCompleted) inflight.remove(url) }
        }
    }

    /** Raw bytes (for colour sampling without keeping a second decode). */
    suspend fun data(url: String): ByteArray? = withContext(Dispatchers.IO) {
        val req = try {
            Request.Builder().url(url).header("Accept", "image/webp,image/jpeg").build()
        } catch (_: IllegalArgumentException) {
            return@withContext null
        }
        try {
            http.newCall(req).await().use { r ->
                if (!r.isSuccessful) return@use null
                r.body?.bytes()?.takeIf { it.isNotEmpty() }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun fetch(url: String): ImageBitmap? {
        val bytes = data(url) ?: return null
        val img = try { decode(bytes) } catch (_: Exception) { null } ?: return null
        // Upload now, off the main thread, so the first draw does not stall scrolling.
        img.prepareToDraw()
        memory.put(url, img, img.width.toLong() * img.height * 4)
        synchronized(inflight) { inflight.remove(url) }
        return img
    }

    /** Drop the decoded copy (e.g. after a playlist cover upload). */
    fun evict(url: String) = memory.remove(url)

    /** Memory LRU by bytes. android.util.LruCache is not used so JVM tests run it for real. */
    private class ByteLru(private val limit: Long) {
        private val map = LinkedHashMap<String, Pair<ImageBitmap, Long>>(64, 0.75f, true)
        private var total = 0L

        @Synchronized operator fun get(k: String): ImageBitmap? = map[k]?.first

        @Synchronized fun put(k: String, v: ImageBitmap, cost: Long) {
            map.remove(k)?.let { total -= it.second }
            if (cost > limit) return
            map[k] = v to cost
            total += cost
            val it = map.entries.iterator()
            while (total > limit && it.hasNext()) {
                val e = it.next()
                total -= e.value.second
                it.remove()
            }
        }

        @Synchronized fun remove(k: String) { map.remove(k)?.let { total -= it.second } }
    }

    companion object {
        @Volatile private var instance: ImageLoader? = null

        /** The app's loader. [install] gives it the disk cache; before that it is memory only. */
        val shared: ImageLoader
            get() = instance ?: synchronized(this) { instance ?: ImageLoader().also { instance = it } }

        /** Once, at launch (the design root does it). */
        fun install(context: Context) {
            synchronized(this) {
                if (instance?.http?.cache != null) return
                instance = ImageLoader(cacheDir = context.applicationContext.cacheDir)
            }
        }

        fun decodeBitmap(bytes: ByteArray): ImageBitmap? =
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()

        /**
         * The image drawn into a side x side sRGB canvas, RGBA bytes as ints (canvas `drawImage` +
         * `getImageData`), for [com.lukasbaxter.slopify.android.design.color.ColorMath].
         */
        fun pixels(bytes: ByteArray, side: Int): IntArray? {
            val src = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
            return pixels(src, side)
        }

        fun pixels(src: Bitmap, side: Int): IntArray {
            val scaled = Bitmap.createScaledBitmap(src, side, side, true)
            val argb = IntArray(side * side)
            scaled.getPixels(argb, 0, side, 0, 0, side, side)
            val out = IntArray(side * side * 4)
            for (i in argb.indices) {
                val c = argb[i]
                val a = c ushr 24 and 255
                // premultiplied like the iOS canvas, so transparent pixels read dark
                out[i * 4] = (c shr 16 and 255) * a / 255
                out[i * 4 + 1] = (c shr 8 and 255) * a / 255
                out[i * 4 + 2] = (c and 255) * a / 255
                out[i * 4 + 3] = a
            }
            return out
        }
    }
}
