package com.lukasbaxter.slopify.android.features.search

import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.SearchResults
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.Normalizer

// Pure rules of the search page (UI.md 6.2, web Library.jsx / api/search.js). No UI, no I/O.

enum class SearchKind(val raw: String) {
    Artist("Artist"), Album("Album"), Song("Song"), Playlist("Playlist");

    val label: String get() = L(raw)

    companion object {
        fun of(raw: String?): SearchKind? = entries.firstOrNull { it.raw == raw }
    }
}

/** The chips (`SEARCH_TYPES`). `key` is the i18n key. */
enum class SearchType(val key: String) {
    All("All"), Songs("Songs"), Artists("Artists"), Albums("Albums"), Playlists("Playlists"), Everywhere("Everywhere");

    fun shows(kind: SearchKind): Boolean = when (this) {
        All -> true
        Songs -> kind == SearchKind.Song
        Artists -> kind == SearchKind.Artist
        Albums -> kind == SearchKind.Album
        Playlists -> kind == SearchKind.Playlist
        Everywhere -> false
    }
}

/** One row of the phone result list. */
sealed interface SearchItem {
    data class Song(val track: Track) : SearchItem
    data class ArtistHit(val artist: Artist) : SearchItem
    data class AlbumHit(val album: Album) : SearchItem
    data class PlaylistHit(val playlist: Playlist) : SearchItem

    val kind: SearchKind
        get() = when (this) {
            is Song -> SearchKind.Song
            is ArtistHit -> SearchKind.Artist
            is AlbumHit -> SearchKind.Album
            is PlaylistHit -> SearchKind.Playlist
        }

    val id: String
        get() = when (this) {
            is Song -> track.id
            is ArtistHit -> artist.id
            is AlbumHit -> album.id
            is PlaylistHit -> playlist.id
        }

    val name: String
        get() = when (this) {
            is Song -> track.title
            is ArtistHit -> artist.name
            is AlbumHit -> album.name
            is PlaylistHit -> playlist.name
        }

    /** `kind:id`, the de-duplication key of `phoneRows` and the recents. */
    val key: String get() = "${kind.raw}:$id"

    /**
     * `subOf` (Library.jsx:1653-1656): "Kind • detail", empty parts dropped. Localised, including
     * the "Song" prefix the web leaves in English (DECISIONS).
     */
    val subtitle: String
        get() = when (this) {
            is ArtistHit -> L("Artist")
            is PlaylistHit -> L("Playlist")
            is AlbumHit -> listOf(L("Album"), album.year?.toString() ?: "", album.artist).filter { it.isNotEmpty() }.joinToString(" • ")
            is Song -> songSubtitle(track)
        }

    companion object {
        fun songSubtitle(t: Track): String {
            val names = t.artists.filter { it.isNotEmpty() }.joinToString(", ")
            return listOf(L("Song"), names.ifEmpty { t.albumArtist }).filter { it.isNotEmpty() }.joinToString(" • ")
        }
    }
}

/** A finished search: the server lists, the matching playlists and the client-picked top result. */
data class SearchPage(
    val query: String,
    val tracks: List<Track>,
    val albums: List<Album>,
    val artists: List<Artist>,
    val playlists: List<Playlist>,
    val top: SearchItem?,
) {
    companion object {
        operator fun invoke(query: String, results: SearchResults, playlists: List<Playlist>): SearchPage {
            val q = query.lowercase()
            return SearchPage(
                query, results.tracks, results.albums, results.artists,
                playlists.filter { it.name.lowercase().contains(q) },
                SearchLogic.topResult(query, results),
            )
        }
    }
}

object SearchLogic {
    /** NFKC + lowercase (api/search.js `norm`). */
    fun norm(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFKC).lowercase()

    /** api/search.js: artist that starts with the query, else album, else song, else the first artist / album / song. */
    fun topResult(query: String, results: SearchResults): SearchItem? {
        val q = norm(query.trim())
        val a = results.artists.firstOrNull()
        val al = results.albums.firstOrNull()
        val t = results.tracks.firstOrNull()
        if (a != null && norm(a.name).startsWith(q)) return SearchItem.ArtistHit(a)
        if (al != null && norm(al.name).startsWith(q)) return SearchItem.AlbumHit(al)
        if (t != null && norm(t.title).startsWith(q)) return SearchItem.Song(t)
        return a?.let { SearchItem.ArtistHit(it) } ?: al?.let { SearchItem.AlbumHit(it) } ?: t?.let { SearchItem.Song(it) }
    }

    /**
     * `phoneRows` (Library.jsx:1687-1706): top result, 4 songs, 2 artists, 2 albums, 1 playlist,
     * then the rest of each list; duplicates by `kind:id` skipped.
     */
    fun phoneRows(p: SearchPage, type: SearchType): List<SearchItem> {
        if (type == SearchType.Everywhere) return emptyList()
        val rows = mutableListOf<SearchItem>()
        val seen = HashSet<String>()
        fun push(it: SearchItem) { if (seen.add(it.key)) rows.add(it) }
        val songs = if (type.shows(SearchKind.Song)) p.tracks.map { SearchItem.Song(it) } else emptyList()
        val artists = if (type.shows(SearchKind.Artist)) p.artists.map { SearchItem.ArtistHit(it) } else emptyList()
        val albums = if (type.shows(SearchKind.Album)) p.albums.map { SearchItem.AlbumHit(it) } else emptyList()
        val playlists = if (type.shows(SearchKind.Playlist)) p.playlists.map { SearchItem.PlaylistHit(it) } else emptyList()
        p.top?.let { if (type.shows(it.kind)) push(it) }
        songs.take(4).forEach(::push); artists.take(2).forEach(::push)
        albums.take(2).forEach(::push); playlists.take(1).forEach(::push)
        (songs + artists + albums + playlists).forEach(::push)
        return rows
    }

    /** Browse tile colour when the server sends none (`TILE_COLORS[i % 16]`). */
    fun tileColor(index: Int): RGB = Theme.Fixed.browseTiles[index % Theme.Fixed.browseTiles.size]

    /** Home's `rankTopArtists`: 1 + plays per credited artist, highest first; ties keep first-seen order. */
    fun topArtistIds(tracks: List<Track>): List<String> {
        val score = LinkedHashMap<String, Int>()
        for (t in tracks) for (id in t.artistIds) if (id.isNotEmpty()) score[id] = (score[id] ?: 0) + 1 + (t.plays ?: 0)
        // sortedByDescending is stable: ties stay in insertion order.
        return score.entries.sortedByDescending { it.value }.map { it.key }
    }
}

// Recent searches (prefs `recentSearches`, UI.md 6.2.6)

data class SearchRecent(
    val q: String,
    val kind: SearchKind,
    val id: String,
    /** Album id for songs, else the item id. */
    val art: String?,
    val name: String,
    val sub: String,
) {
    val key: String get() = "${kind.raw}:$id"
    /** The stored line, else the kind label. */
    val subtitle: String get() = sub.ifEmpty { kind.label }

    val json: JsonElement
        get() = JsonObject(
            mapOf(
                "q" to JsonPrimitive(q), "kind" to JsonPrimitive(kind.raw), "id" to JsonPrimitive(id),
                "art" to (art?.let { JsonPrimitive(it) } ?: JsonNull), "name" to JsonPrimitive(name), "sub" to JsonPrimitive(sub),
            ),
        )

    companion object {
        /** `remember(q, hit)`: what was opened from a result. */
        fun from(query: String, item: SearchItem): SearchRecent {
            val art = if (item is SearchItem.Song) item.track.albumId.ifEmpty { item.track.id } else item.id
            return SearchRecent(query.trim(), item.kind, item.id, art, item.name, item.subtitle)
        }

        fun parse(v: JsonElement): SearchRecent? {
            val o = v as? JsonObject ?: return null
            fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val id = str("id")?.takeIf { it.isNotEmpty() } ?: return null
            val kind = SearchKind.of(str("kind")) ?: return null
            return SearchRecent(str("q") ?: "", kind, id, str("art"), str("name") ?: "", str("sub") ?: "")
        }

        /** Entries from prefs; old string entries and junk are ignored (Library.jsx:220-223). */
        fun list(v: JsonElement?): List<SearchRecent> = (v as? JsonArray)?.mapNotNull(::parse) ?: emptyList()

        /** Newest first, unique by `kind:id`, at most 10. */
        fun adding(e: SearchRecent, list: List<SearchRecent>): List<SearchRecent> = (listOf(e) + list.filter { it.key != e.key }).take(10)

        fun removing(e: SearchRecent, list: List<SearchRecent>): List<SearchRecent> = list.filter { it.key != e.key }

        fun json(list: List<SearchRecent>): JsonElement = JsonArray(list.map { it.json })
    }
}

// Release requests (UI.md 6.0.7)

object SearchRequestState {
    val pending: Set<String> = setOf("queued", "exists", "downloading")

    /** `stateOf`: the server's state wins once it reports progress; until then the tap's own. */
    fun state(server: String?, mine: String?): String? {
        if (mine != null && (server == null || server == "failed")) return mine
        return server ?: mine
    }

    data class Ui(val label: String, val busy: Boolean)

    /** `requestUi`: label and busy flag. */
    fun ui(st: String?): Ui {
        val label = when (st) {
            "queued", "exists" -> L("Requested")
            "downloading" -> L("Downloading…")
            "failed" -> L("Retry")
            "error" -> L("Failed")
            else -> L("Request")
        }
        return Ui(label, st != null && st in pending)
    }
}
