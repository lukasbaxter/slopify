package com.lukasbaxter.slopify.android.design.color

import android.content.Context
import com.lukasbaxter.slopify.android.design.image.ImageLoader
import com.lukasbaxter.slopify.android.design.theme.RGB
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Cover colours the way the web picks them (api/colors.js), cached per image URL in memory and
 * on disk (ios Design/Color/ArtworkColor.swift). Safe from any coroutine; null when the image
 * fails.
 *
 * - [vibrant]: the raw prominent colour (now playing `--np`).
 * - [mini]: `clampLightness(vibrant)` (mini player card, UI.md 3.1.1).
 * - [hero]: `heroTint(vibrant)` (detail page `--hero`, UI.md 6.3.1).
 * - [palette]: three visualizer stops (colors.js `paletteColors`).
 */
class ArtworkColor(
    private val loader: () -> ImageLoader = { ImageLoader.shared },
    private val file: File? = null,
    /** Bytes to side x side RGBA ints; tests swap it (no BitmapFactory on the JVM). */
    private val pixels: (ByteArray, Int) -> IntArray? = { b, s -> ImageLoader.pixels(b, s) },
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val lock = Any()
    private val memo = HashMap<String, RGB?>()
    private val inflight = HashMap<String, Deferred<RGB?>>()
    private val disk = LinkedHashMap<String, List<Int>>()
    private var dirty = false
    private val codec = MapSerializer(String.serializer(), ListSerializer(Int.serializer()))

    init {
        val f = file
        if (f != null && f.exists()) {
            runCatching { Json.decodeFromString(codec, f.readText()) }.getOrNull()?.let { disk.putAll(it) }
        }
    }

    suspend fun vibrant(url: String?): RGB? {
        if (url == null) return null
        val task = synchronized(lock) {
            if (memo.containsKey(url)) return memo[url]
            disk[url]?.let { c ->
                val rgb = if (c.size == 3) RGB(c[0].toDouble(), c[1].toDouble(), c[2].toDouble()) else null
                memo[url] = rgb
                return rgb
            }
            inflight.getOrPut(url) {
                scope.async {
                    val data = loader().data(url) ?: return@async null
                    pixels(data, 40)?.let { ColorMath.vibrant(it) }
                }
            }
        }
        val rgb = task.await()
        synchronized(lock) {
            inflight.remove(url)
            memo[url] = rgb
            // Only remember successes on disk: a failed fetch may work next launch.
            if (rgb != null) { disk[url] = rgb.ints; scheduleSave() }
        }
        return rgb
    }

    suspend fun mini(url: String?): RGB? = vibrant(url)?.let { ColorMath.clampLightness(it) }
    suspend fun hero(url: String?): RGB? = vibrant(url)?.let(ColorMath::heroTint)

    suspend fun palette(url: String?): List<RGB>? {
        if (url == null) return null
        val data = loader().data(url) ?: return null
        return pixels(data, 48)?.let { ColorMath.palette(it) }
    }

    private fun scheduleSave() {
        if (dirty || file == null) return
        dirty = true
        scope.launch { delay(2000); save() }
    }

    private fun save() {
        val f = file ?: return
        val snapshot = synchronized(lock) {
            dirty = false
            if (disk.size > 5000) {
                val keep = disk.entries.take(4000).map { it.key to it.value }
                disk.clear(); keep.forEach { (k, v) -> disk[k] = v }
            }
            HashMap(disk)
        }
        runCatching {
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(Json.encodeToString(codec, snapshot))
            tmp.renameTo(f)
        }
    }

    companion object {
        @Volatile private var instance: ArtworkColor? = null

        val shared: ArtworkColor
            get() = instance ?: synchronized(this) { instance ?: ArtworkColor().also { instance = it } }

        /** Once, at launch: the disk memo in the cache directory. */
        fun install(context: Context) {
            synchronized(this) {
                if (instance?.file != null) return
                instance = ArtworkColor(file = File(context.applicationContext.cacheDir, "artwork-colors.json"))
            }
        }
    }
}
