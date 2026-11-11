package com.lukasbaxter.slopify.android.features.detail

import android.content.Context
import com.lukasbaxter.slopify.android.core.model.ArtistDetail
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import java.io.File

/**
 * Album and artist pages kept on the device, the last 40 opened (App.jsx keepPage), so a page
 * seen before paints at once, also offline, and refreshes behind (ios DetailCache.swift).
 * Blocking file IO: call it off the main thread.
 * TODO(lead): one shared page cache for every detail screen (6.0.15).
 */
class DetailCache(private val dir: File) {
    private val lock = Any()
    private val memory = HashMap<String, String>()
    /** Strictly rising write stamps, so the trim order holds even within one clock tick. */
    private var lastStamp = 0L

    init {
        dir.mkdirs()
        lastStamp = dir.listFiles()?.maxOfOrNull { it.lastModified() } ?: 0L
    }

    /** `key` like "al.<id>"; `scope` keeps accounts apart. */
    fun <T> load(key: String, scope: String?, serializer: KSerializer<T>): T? {
        val k = name(key, scope)
        val text = synchronized(lock) { memory[k] } ?: runCatching { File(dir, k).takeIf { it.exists() }?.readText() }.getOrNull() ?: return null
        synchronized(lock) { memory[k] = text }
        return runCatching { SlopifyJson.decodeFromString(serializer, text) }.getOrNull()
    }

    fun <T> save(value: T, key: String, scope: String?, serializer: KSerializer<T>) {
        val k = name(key, scope)
        val text = runCatching { SlopifyJson.encodeToString(serializer, value) }.getOrNull() ?: return
        synchronized(lock) {
            memory[k] = text
            runCatching {
                val f = File(dir, k)
                val tmp = File(dir, "$k.tmp")
                tmp.writeText(text)
                if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
                lastStamp = maxOf(System.currentTimeMillis(), lastStamp + 1)
                f.setLastModified(lastStamp)
            }
            trim()
        }
    }

    private fun name(key: String, scope: String?): String = ((scope ?: "anon") + "." + key).replace('/', '_') + ".json"

    /** Oldest written first out. */
    private fun trim() {
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") } ?: return
        if (files.size <= LIMIT) return
        for (f in files.sortedBy { it.lastModified() }.take(files.size - LIMIT)) {
            f.delete()
            memory.remove(f.name)
        }
    }

    companion object {
        const val LIMIT = 40

        @Volatile private var instance: DetailCache? = null

        /** The app's copy, in the cache directory. */
        fun shared(context: Context): DetailCache = instance ?: synchronized(this) {
            instance ?: DetailCache(File(context.applicationContext.cacheDir, "detail-pages")).also { instance = it }
        }
    }
}

/** What an artist page keeps (App.jsx `ar.<id>`): the artist, its tracks, albums, and the popular order. */
@Serializable
data class DetailArtistPage(val detail: ArtistDetail, val popular: List<String>? = null)
