package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import kotlinx.serialization.Serializable
import java.io.File
import java.util.concurrent.Executors

/**
 * Queue + playhead on disk, so a relaunch shows the last song paused (web `saveQueue` /
 * `savePlayhead`). Two files: the queue (big, written when it changes) and the playhead
 * (tiny, written every few seconds while playing, on pause and on backgrounding).
 */
class PlayerPersistence(val dir: File) {
    @Serializable
    data class Playhead(
        val trackId: String,
        val index: Int,
        val position: Double,
        val repeatMode: RepeatMode,
        val shuffle: ShuffleMode,
        val volume: Double? = null,
        /** Epoch ms written. Compared with the server session's `at` (§20.4). */
        val at: Double,
    )

    data class Saved(val queue: PlayQueue, val position: Double, val volume: Double?, val at: Double)

    private val queueFile get() = File(dir, "queue.json")
    private val headFile get() = File(dir, "playhead.json")

    fun saveQueue(q: PlayQueue) {
        if (q.isEmpty) return
        val text = runCatching { SlopifyJson.encodeToString(PlayQueue.serializer(), q) }.getOrNull() ?: return
        io.execute { write(queueFile, text) }
    }

    fun savePlayhead(h: Playhead) {
        val text = SlopifyJson.encodeToString(Playhead.serializer(), h)
        io.execute { write(headFile, text) }
    }

    fun load(): Saved? {
        val q = runCatching { SlopifyJson.decodeFromString(PlayQueue.serializer(), queueFile.readText()) }.getOrNull()
        if (q == null || q.isEmpty) return null
        val head = runCatching { SlopifyJson.decodeFromString(Playhead.serializer(), headFile.readText()) }.getOrNull()
        // Prefer the track id over the index (web restore).
        if (head != null) {
            val byId = q.entries.indexOfFirst { it.track.id == head.trackId }
            q.index = if (byId >= 0) byId else head.index.coerceIn(0, q.entries.size - 1)
            q.repeatMode = head.repeatMode
            q.shuffle = head.shuffle
        }
        q.index = q.index.coerceIn(0, q.entries.size - 1)
        val dur = q.current?.track?.duration ?: 0.0
        val p = head?.position ?: 0.0
        val pos = maxOf(0.0, if (dur > 0) minOf(p, dur) else p)
        return Saved(q, pos, head?.volume, head?.at ?: 0.0)
    }

    fun clear() { io.execute { dir.deleteRecursively() } }

    /** Synchronous write (tests, app going to the background). */
    fun flush(q: PlayQueue?, h: Playhead?) {
        val qt = q?.takeIf { !it.isEmpty }?.let { runCatching { SlopifyJson.encodeToString(PlayQueue.serializer(), it) }.getOrNull() }
        val ht = h?.let { SlopifyJson.encodeToString(Playhead.serializer(), it) }
        io.submit {
            if (qt != null) write(queueFile, qt)
            if (ht != null) write(headFile, ht)
        }.get()
    }

    private fun write(f: File, text: String) {
        runCatching {
            dir.mkdirs()
            val tmp = File(dir, f.name + ".tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        }
    }

    companion object {
        /** Serial, so two writes of one file never land out of order. */
        private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "slopify-player-persist").apply { isDaemon = true } }

        /** One folder per signed-in account + server so another account never sees this queue. */
        fun forAccount(root: File, key: String): PlayerPersistence {
            val safe = key.map { if (it.isLetterOrDigit()) it else '_' }.joinToString("")
            return PlayerPersistence(File(File(root, "player"), safe))
        }
    }
}
