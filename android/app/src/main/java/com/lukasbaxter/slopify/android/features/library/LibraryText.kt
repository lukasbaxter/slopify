package com.lukasbaxter.slopify.android.features.library

import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import java.text.Collator
import java.text.Normalizer
import kotlin.math.roundToLong

/** Text and list maths for the library screens (Sidebar.jsx, Library.jsx), kept pure for tests. */
object LibraryText {
    /** ` • ` (U+2022 with spaces). */
    const val DOT = " • "

    /** Library row subtitle without the pin / download mark (UI.md 5.2.8). */
    fun subtitle(e: LibraryEntry, folderCount: Int): String = when (e.kind) {
        LibraryEntry.Kind.Album -> L("Album") + DOT + (e.album?.artist ?: "")
        LibraryEntry.Kind.Artist -> L("Artist")
        LibraryEntry.Kind.Folder -> L("Folder") + DOT + L("{n} items", "n" to folderCount)
        LibraryEntry.Kind.Playlist -> {
            val n = e.playlist?.trackCount ?: 0
            L("Playlist") + if (n > 0) DOT + L("{n} songs", "n" to n) else ""
        }
    }

    fun likedSubtitle(count: Int?): String = L("Playlist") + (count?.let { DOT + L("{n} songs", "n" to it) } ?: "")

    /** `fmtTotalShort`: "3h 7min", "9min 39sec". */
    fun totalShort(ms: Long): String {
        val s = (ms / 1000.0).roundToLong()
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h > 0) L("{h}h {m}min", "h" to h, "m" to m) else L("{m}min {sec}sec", "m" to m, "sec" to sec)
    }

    /** Playlist hero stats: `Playlist • 3h 7min`, or the song count when there is no duration. */
    fun playlistStats(tracks: List<Track>): String {
        val total = tracks.sumOf { it.durationMs.toLong() }
        return L("Playlist") + DOT + if (total > 0) totalShort(total) else L("{n} songs", "n" to tracks.size)
    }

    fun likedStats(count: Int): String = if (count == 1) L("Playlist • 1 song") else L("Playlist • {n} songs", "n" to count)

    /**
     * Scoped "find": every query word is a substring of title + artists + album + album artist,
     * NFKC-lowercased (API.md §6).
     */
    fun matches(t: Track, query: String): Boolean {
        val words = fold(query).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return true
        val hay = fold(listOf(t.title, t.artists.joinToString(" "), t.artist, t.album, t.albumArtist).joinToString(" "))
        return words.all { hay.contains(it) }
    }

    fun fold(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFKC).lowercase()

    /** Liked Songs sort sheet options (Library.jsx SORTS). */
    enum class LikedSort {
        Recent, Title, Artist, Album;

        val label: String
            get() = when (this) {
                Recent -> L("Recently added")
                Title -> L("Title")
                Artist -> L("Artist")
                Album -> L("Album")
            }
    }

    /** Newest liked first (ties by id so the order is stable), then the phone sort. */
    fun likedOrder(at: Map<String, Double>, rows: Map<String, Track>, sort: LikedSort): List<Track> {
        val ids = at.entries.sortedWith(compareByDescending<Map.Entry<String, Double>> { it.value }.thenBy { it.key }).map { it.key }
        val list = ids.mapNotNull { rows[it] }
        if (sort == LikedSort.Recent) return list
        fun key(t: Track): String = when (sort) {
            LikedSort.Title -> t.title
            LikedSort.Artist -> t.artists.firstOrNull() ?: t.albumArtist
            LikedSort.Album -> t.album
            LikedSort.Recent -> ""
        }
        // localeCompare(..., {sensitivity: 'base'}); sortedWith is stable for equal keys.
        val collator = Collator.getInstance(Localizer.shared.locale).apply { strength = Collator.PRIMARY }
        return list.sortedWith { a, b -> collator.compare(key(a), key(b)) }
    }

    fun <T> moved(list: List<T>, from: Int, to: Int): List<T> {
        if (from !in list.indices || to < 0 || to >= list.size) return list
        val l = list.toMutableList()
        val x = l.removeAt(from)
        l.add(to, x)
        return l
    }
}
