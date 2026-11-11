package com.lukasbaxter.slopify.android.features.detail

import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import java.text.NumberFormat
import java.util.Locale

/** Pure rules behind the album and artist pages (Library.jsx; ios DetailLogic.swift), kept apart so they are tested. */
object DetailLogic {
    // Release type (Library.jsx:181-191)

    private val epName = Regex("""\b(EP)\b\s*$|\s[-–]\s*EP\s*$""", RegexOption.IGNORE_CASE)
    private val singleName = Regex("""\s[-–]\s*Single\s*$|\(single\)$""", RegexOption.IGNORE_CASE)

    /** The i18n key: "Album", "EP", "Single" or "Compilation". */
    fun releaseType(name: String, albumArtist: String, count: Int?, durationMs: Int?): String {
        val n = count ?: 0
        val mins = (durationMs ?: 0) / 60_000.0
        val short = mins == 0.0 || mins < 30
        if (albumArtist.contains("various artists", ignoreCase = true)) return "Compilation"
        if (epName.containsMatchIn(name)) return "EP"
        if (singleName.containsMatchIn(name)) return "Single"
        if (n in 1..3 && short) return "Single"
        if (n in 1..6 && short) return "EP"
        return "Album"
    }

    fun releaseType(a: Album, tracks: List<Track> = emptyList()): String {
        val total = tracks.sumOf { it.durationMs }
        val dur = if ((a.durationMs ?: 0) > 0) a.durationMs else total
        return releaseType(a.name, a.artist, a.trackCount ?: (if (tracks.isEmpty()) null else tracks.size), dur)
    }

    /** Album hero stats: "Album • 2013" (the year left out when unknown). */
    fun albumStats(a: Album, tracks: List<Track>): String =
        listOfNotNull(L(releaseType(a, tracks)), a.year?.toString()).filter { it.isNotEmpty() }.joinToString(" • ")

    // Artist page

    /** Popular order (App.jsx:885-895): tracks the popular list names first, in its order; the rest keep their order after them. */
    fun popularOrder(tracks: List<Track>, ids: List<String>): List<Track> {
        if (ids.isEmpty()) return tracks
        val pos = HashMap<String, Int>()
        ids.forEachIndexed { i, id -> pos.putIfAbsent(id, i) }
        val known = tracks.filter { it.id in pos }.sortedBy { pos.getValue(it.id) }
        val seen = known.map { it.id }.toSet()
        return known + tracks.filter { it.id !in seen }
    }

    /** Popular row subtitle: play count when known, else the album name. */
    fun playsSubtitle(t: Track, locale: Locale = Locale.getDefault()): String? {
        val p = t.plays
        if (p != null && p > 0) {
            if (p == 1) return L("1 play")
            return L("{n} plays", "n" to NumberFormat.getIntegerInstance(locale).format(p))
        }
        return t.album.ifEmpty { null }
    }

    // Offline play rules (ios OfflineRules.playable / playablePage).

    /** A row tap: offline only downloaded songs play, starting at the tapped one. Null = cannot play. */
    fun playable(tracks: List<Track>, index: Int, offline: Boolean, has: (String) -> Boolean): Pair<List<Track>, Int>? {
        if (index !in tracks.indices) return null
        if (!offline) return tracks to index
        if (!has(tracks[index].id)) return null
        val before = tracks.subList(0, index).count { has(it.id) }
        return tracks.filter { has(it.id) } to before
    }

    /** A page's play button: offline it starts at the first downloaded song. */
    fun playablePage(tracks: List<Track>, offline: Boolean, has: (String) -> Boolean): List<Track>? {
        val list = if (offline) tracks.filter { has(it.id) } else tracks
        return list.ifEmpty { null }
    }

    // Discography (Library.jsx:1401-1430)

    data class Entry(
        val id: String,
        val title: String,
        /** i18n key of the release type. */
        val type: String,
        val year: String,
        val date: String,
        /** Library album id when owned. */
        val inLib: String? = null,
        /** Upstream id (MusicBrainz) for requests; null for library-only albums. */
        val mbid: String? = null,
        val image: String? = null,
        val requestStatus: String? = null,
    ) {
        val subtitle: String get() = if (year.isEmpty()) L(type) else "$year • ${L(type)}"
        val sortYear: Int get() = (date.ifEmpty { year }).take(4).toIntOrNull() ?: 0
    }

    /** Discography releases plus the library albums the catalogue does not list. */
    fun entries(releases: List<Release>, albums: List<Album>): List<Entry> {
        val out = releases.mapIndexed { i, r ->
            Entry(
                id = "${r.inLibrary ?: r.albumId ?: r.title}-$i", title = r.localName ?: r.title,
                type = r.rtype?.takeIf { it.isNotEmpty() } ?: "Album", year = r.year ?: "", date = r.date ?: "",
                inLib = r.inLibrary, mbid = r.albumId, image = r.image?.takeIf { it.isNotEmpty() }, requestStatus = r.requestStatus,
            )
        }
        val listed = releases.mapNotNull { it.inLibrary }.toSet()
        return out + albums.filter { it.id !in listed }.map { a ->
            Entry(id = a.id, title = a.name, type = releaseType(a), year = a.year?.toString() ?: "", date = "", inLib = a.id)
        }
    }

    /** Newest first: by year, then the date string descending; stable otherwise. */
    fun newestFirst(e: List<Entry>): List<Entry> =
        e.sortedWith(compareByDescending<Entry> { it.sortYear }.thenByDescending { it.date })

    enum class TypeFilter(val key: String, val type: String?) {
        All("All", null), Album("Albums", "Album"), Single("Singles", "Single"), EP("EPs", "EP"), Compilation("Compilations", "Compilation"),
    }

    enum class LibFilter(val key: String) { All("Everything"), Have("In your library"), Missing("Not in library") }

    /** "All" plus the types that exist, in the web's order. */
    fun typeFilters(e: List<Entry>): List<TypeFilter> {
        val types = e.map { it.type }.toSet()
        return TypeFilter.entries.filter { it == TypeFilter.All || it.type in types }
    }

    fun filtered(e: List<Entry>, type: TypeFilter, lib: LibFilter): List<Entry> = newestFirst(
        e.filter { x ->
            (type.type == null || x.type == type.type) &&
                when (lib) {
                    LibFilter.All -> true
                    LibFilter.Have -> x.inLib != null
                    LibFilter.Missing -> x.inLib == null
                }
        },
    )

    // Request pill (Library.jsx:428-438)

    val pending: Set<String> = setOf("queued", "exists", "downloading")

    /** The server's state wins once it reports progress; until then the tap's own. */
    fun requestState(mine: String?, server: String?): String? {
        if (mine != null && (server == null || server == "failed")) return mine
        return server ?: mine
    }

    data class RequestLabel(val key: String, val busy: Boolean)

    fun requestLabel(st: String?): RequestLabel {
        val key = when (st) {
            "queued", "exists" -> "Requested"
            "downloading" -> "Downloading…"
            "failed" -> "Retry"
            "error" -> "Failed"
            else -> "Request"
        }
        return RequestLabel(key, st != null && st in pending)
    }
}
