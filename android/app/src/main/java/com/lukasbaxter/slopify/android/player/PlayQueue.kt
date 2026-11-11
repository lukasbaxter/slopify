package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.session.Command
import kotlinx.serialization.Serializable
import kotlin.math.ceil
import kotlin.random.Random

/**
 * One queue row. `queued` = added with "Add to queue" (web `_queued`); `rec` = a smart
 * shuffle pick mixed in (web `_rec`), never part of the remembered original order.
 */
@Serializable
data class QueueEntry(val track: Track, val queued: Boolean = false, val rec: Boolean = false)

/** What happens when a song ends (`auto`) or next is pressed (web `advance`). */
sealed interface Advance {
    data class Skip(val index: Int) : Advance
    /** Repeat one: the same song from the top. */
    data object Replay : Advance
    /** Repeat all at the end: the context from the top (fresh order when shuffled). */
    data object Restart : Advance
    /** Played from an artist page: more of that artist. */
    data class MoreOfArtist(val artistId: String) : Advance
    /** Autoplay: similar songs appended. `orRestart`: start the context over if none. */
    data class Autoplay(val orRestart: Boolean) : Advance
    /** Sleep timer "end of track": park paused at the start of `index`. */
    data class SleepStop(val index: Int) : Advance
}

/**
 * The local play queue: order, original (unshuffled) order, modes. Pure, so the rules are
 * testable without audio (ios PlayQueue.swift; every rule copies web/src/player/usePlayer.js).
 * Lists are immutable, so [copy] is a safe snapshot.
 */
@Serializable
data class PlayQueue(
    var entries: List<QueueEntry> = emptyList(),
    /** The real order while shuffled (web `originalQueueRef`). */
    var original: List<QueueEntry> = emptyList(),
    var index: Int = 0,
    var context: String? = null,
    var shuffle: ShuffleMode = ShuffleMode.Off,
    var repeatMode: RepeatMode = RepeatMode.Off,
) {
    val current: QueueEntry? get() = entries.getOrNull(index)
    val tracks: List<Track> get() = entries.map { it.track }
    val isEmpty: Boolean get() = entries.isEmpty()

    /** web `playQueue`: shuffled keeps the chosen track first and scrambles the rest. */
    fun start(list: List<Track>, at: Int, context: String?, rng: Random) {
        val rows = list.map { QueueEntry(it) }
        val i = if (at in rows.indices) at else 0
        this.context = context
        original = rows
        if (shuffle != ShuffleMode.Off && rows.size > 1) {
            val rest = rows.toMutableList()
            val chosen = rest.removeAt(i)
            entries = listOf(chosen) + rest.shuffled(rng)
            index = 0
        } else {
            entries = rows
            index = if (rows.isEmpty()) 0 else i
        }
    }

    /** Take a queue as handed over (transfer, session adoption): no reshuffle. */
    fun adopt(rows: List<QueueEntry>, index: Int, original: List<QueueEntry>? = null, context: String?) {
        entries = rows
        this.index = if (rows.isEmpty()) 0 else index.coerceIn(0, rows.size - 1)
        this.original = original?.takeIf { it.isNotEmpty() } ?: rows
        this.context = context
    }

    /**
     * web `addToQueue`: after the current song and anything already queued that way, ahead of
     * the rest of the context. An empty queue just becomes the tracks. True when it was empty.
     */
    fun add(list: List<Track>): Boolean {
        if (list.isEmpty()) return false
        if (entries.isEmpty()) {
            entries = list.map { QueueEntry(it) }
            original = entries; index = 0
            return true
        }
        var at = index + 1
        while (at < entries.size && entries[at].queued) at++
        val flagged = list.map { QueueEntry(it, queued = true) }
        entries = entries.take(at) + flagged + entries.drop(at)
        original = original + flagged
        return false
    }

    /** "Play next": straight after the current song, ahead of other queued songs (marked queued). */
    fun insertNext(list: List<Track>): Boolean {
        if (list.isEmpty()) return false
        if (entries.isEmpty()) return add(list)
        val flagged = list.map { QueueEntry(it, queued = true) }
        val at = minOf(index + 1, entries.size)
        entries = entries.take(at) + flagged + entries.drop(at)
        original = original + flagged
        return false
    }

    /** web `removeFromQueue`: never the current one. */
    fun remove(at: Int): Boolean {
        if (at !in entries.indices || at == index) return false
        entries = entries.filterIndexed { i, _ -> i != at }
        if (at < index) index--
        return true
    }

    /** web `moveInQueue`: only the upcoming part moves. */
    fun move(from: Int, to: Int): Boolean {
        if (from == to || from <= index || to <= index || from >= entries.size || to >= entries.size) return false
        entries = entries.toMutableList().apply { add(to, removeAt(from)) }
        return true
    }

    /** web `clearQueued`: every queued song after the current one. */
    fun clearQueued() {
        entries = entries.filterIndexed { i, e -> i <= index || !e.queued }
    }

    /** web `applyShuffleOrder`: re-order for a mode change, keeping the current song. */
    fun setShuffle(mode: ShuffleMode, rng: Random) {
        val cur = current
        if (mode != ShuffleMode.Off) {
            if (shuffle == ShuffleMode.Off) original = entries
            if (cur != null && entries.size > 1) {
                val rest = entries.filter { it.track.id != cur.track.id }
                entries = listOf(cur) + rest.shuffled(rng)
                index = 0
            }
        } else {
            val orig = original.ifEmpty { entries }
            val pos = if (cur != null) maxOf(0, orig.indexOfFirst { it.track.id == cur.track.id }) else index
            entries = orig
            index = if (entries.isEmpty()) 0 else minOf(pos, entries.size - 1)
        }
        shuffle = mode
    }

    /** web `restart`: shuffled, a fresh order that does not open on the song that just played. */
    fun restartOrder(rng: Random) {
        if (shuffle != ShuffleMode.Off && entries.size > 1) {
            val last = current
            val base = original.ifEmpty { entries }.filter { !it.queued }
            val order = base.shuffled(rng).toMutableList()
            if (order.size > 1 && last != null && order[0].track.id == last.track.id) order.add(order.removeAt(0))
            entries = order
        }
        index = 0
    }

    /**
     * web `smartNext` / early extension: songs not in the queue yet appended (the seed too: it
     * is always in the queue). Shuffled only under smart shuffle. `fallbackAllowNonSeed`:
     * smartNext takes repeats rather than nothing (manual skip).
     */
    fun appendAutoplay(fresh: List<Track>, seedId: String?, fallbackAllowNonSeed: Boolean = false, rng: Random): Int {
        val have = entries.mapTo(HashSet()) { it.track.id }
        var pick = fresh.filter { it.id !in have && it.id != seedId }
        if (pick.isEmpty() && fallbackAllowNonSeed) pick = fresh.filter { it.id != seedId }
        if (pick.isEmpty()) return 0
        if (shuffle == ShuffleMode.Smart) pick = pick.shuffled(rng)
        entries = entries + pick.map { QueueEntry(it) }
        return pick.size
    }

    /** web `moreOfArtist`: appended to both the queue and the original order. */
    fun appendMore(list: List<Track>): Int {
        val have = entries.mapTo(HashSet()) { it.track.id }
        val rows = list.filter { it.id !in have }.map { QueueEntry(it) }
        entries = entries + rows; original = original + rows
        return rows.size
    }

    /** web `blendSmart`: one pick after every third upcoming song. */
    fun blendSmart(recs: List<Track>): Int {
        val have = entries.mapTo(HashSet()) { it.track.id }
        val picks = recs.filter { it.id !in have }
        if (picks.isEmpty() || entries.size - index < 4) return 0
        val out = entries.take(index + 1).toMutableList()
        var r = 0
        entries.drop(index + 1).forEachIndexed { k, e ->
            out.add(e)
            if ((k + 1) % 3 == 0 && r < picks.size) { out.add(QueueEntry(picks[r], rec = true)); r++ }
        }
        entries = out
        return r
    }

    /** How many smart picks to ask for (web `blendSmart`). */
    val smartWant: Int get() = minOf(40, ceil((entries.size - index - 1) / 3.0).toInt())

    /** web `advance`. */
    fun advance(auto: Boolean, sleepEndOfTrack: Boolean): Advance {
        val n = entries.size
        val i = index
        if (auto && sleepEndOfTrack) return Advance.SleepStop(if (i + 1 < n) i + 1 else if (repeatMode == RepeatMode.All) 0 else i)
        if (auto && repeatMode == RepeatMode.One) return Advance.Replay
        if (i + 1 < n) return Advance.Skip(i + 1)
        if (repeatMode == RepeatMode.All) return Advance.Restart
        if (repeatMode == RepeatMode.One) return Advance.Replay
        val ctx = context
        if (ctx != null && ctx.startsWith("artist:")) return Advance.MoreOfArtist(ctx.removePrefix("artist:"))
        return Advance.Autoplay(orRestart = ctx != null)
    }

    /** web `previous`: restart past 3 s, else the song before (the first one restarts). */
    fun previous(position: Double): Advance {
        if (position > 3) return Advance.Replay
        return if (index > 0) Advance.Skip(index - 1) else Advance.Replay
    }

    /** The song that plays after the current one ends on its own, if it is already known. */
    val upcomingIndex: Int?
        get() = when {
            repeatMode == RepeatMode.One -> if (entries.isEmpty()) null else index
            index + 1 < entries.size -> index + 1
            repeatMode == RepeatMode.All && shuffle == ShuffleMode.Off && entries.isNotEmpty() -> 0
            else -> null
        }

    val upcoming: QueueEntry?
        get() = when {
            repeatMode == RepeatMode.One -> null
            index + 1 < entries.size -> entries[index + 1]
            // Repeat all reshuffles on restart (web `restart`), so only a plain order wraps early.
            repeatMode == RepeatMode.All && shuffle == ShuffleMode.Off -> entries.firstOrNull()
            else -> null
        }

    /** The early queue extension (web effect "queue's end, two songs early"). */
    fun wantsEarlyExtension(remoteActive: Boolean): Boolean {
        if (entries.isEmpty() || entries.size - index > 2 || repeatMode != RepeatMode.Off || remoteActive) return false
        return context?.startsWith("artist:") != true
    }

    /** The transfer payload (API.md §20.6). */
    fun transfer(position: Double, playing: Boolean, deviceId: String) = Command.TransferPayload(
        trackIds = entries.map { it.track.id }, queued = entries.map { it.queued }, index = index,
        position = position, playing = playing, ctx = context,
        original = if (shuffle != ShuffleMode.Off && original.isNotEmpty()) original.map { it.track.id } else null,
        deviceId = deviceId,
    )

    companion object {
        /** web `markQueued`: carry handed-over flags onto fetched tracks (which may skip ids). */
        fun marked(tracks: List<Track>, ids: List<String>, flags: List<Boolean>?): List<QueueEntry> {
            if (flags == null) return tracks.map { QueueEntry(it) }
            var j = 0
            return tracks.map { t ->
                while (j < ids.size && ids[j] != t.id) j++
                val q = flags.getOrElse(j) { false }
                j++
                QueueEntry(t, queued = q)
            }
        }
    }
}
