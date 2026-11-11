package com.lukasbaxter.slopify.android.features.home

import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import kotlinx.serialization.Serializable

/** Pure Home rules, ported from web/src/components/Home.jsx and Library.jsx (UI.md 6.1, 6.3; ios HomeLogic.swift). */
object HomeLogic {
    /** An artist as Home ranks it (from the user's top tracks) or as the library lists it. */
    @Serializable
    data class RankedArtist(
        val id: String,
        val name: String,
        /** `Artist.image` hash when it came from the library list. */
        val image: String? = null,
        /** Ranking score (`1 + plays` per track); unused for recentArtists. */
        val score: Int = 0,
    )

    enum class Filter { All, Music, Artists }

    enum class Section { Shortcuts, MadeForYou, TopSongs, Recent, JumpBackIn, Radar, TopArtists }

    sealed interface Shortcut {
        val id: String

        data object Liked : Shortcut { override val id = "__liked__" }
        data class AlbumTile(val album: Album) : Shortcut { override val id get() = "al:" + album.id }
        data class PlaylistTile(val playlist: Playlist) : Shortcut { override val id get() = "pl:" + playlist.id }
    }

    /** Home.jsx `rankTopArtists`: every artist on every track scores `1 + plays`; most first. Ties keep first-seen order. */
    fun rankTopArtists(tracks: List<Track>): List<RankedArtist> {
        val map = LinkedHashMap<String, RankedArtist>()
        for (t in tracks) {
            for (c in t.artistCredits) {
                val id = c.id?.takeIf { it.isNotEmpty() } ?: continue
                val a = map[id] ?: RankedArtist(id, c.name)
                map[id] = a.copy(score = a.score + 1 + (t.plays ?: 0))
            }
        }
        // sortedByDescending is stable: ties keep insertion order, like the JS sort.
        return map.values.sortedByDescending { it.score }
    }

    /**
     * Home.jsx `recentArtists`: latest last-played date per artist, newest first, 16. An artist
     * only counts once a track has a date (`'' > ''` is false in the web).
     */
    fun recentArtists(tracks: List<Track>, lastPlayed: (Track) -> String?): List<RankedArtist> {
        val map = LinkedHashMap<String, Pair<RankedArtist, String>>()
        for (t in tracks) {
            val lp = lastPlayed(t) ?: ""
            for (c in t.artistCredits) {
                val id = c.id?.takeIf { it.isNotEmpty() } ?: continue
                if (lp > (map[id]?.second ?: "")) map[id] = RankedArtist(id, c.name) to lp
            }
        }
        return map.values.sortedWith { x, y -> y.second.compareTo(x.second) }.take(16).map { it.first }
    }

    private val tileInner = Regex(
        """\s*[(\[](?:feat|ft|with|featuring|radio edit|remaster|remastered|deluxe|version|edit|mix|live|bonus)[^)\]]*[)\]]""",
        RegexOption.IGNORE_CASE,
    )
    private val tileTail = Regex(
        """\s+[-–]\s+(?:\d{4}\s+)?(?:remaster|remastered|radio edit|single version|deluxe|live|edit|version|mix).*$""",
        RegexOption.IGNORE_CASE,
    )

    /** Home.jsx `tileTitle`: shortcut labels drop "(feat. …)", "- Remaster" style suffixes. */
    fun tileTitle(name: String): String {
        val s = tileTail.replaceFirst(tileInner.replace(name, ""), "")
        val out = s.trim()
        return out.ifEmpty { name }
    }

    /** Liked Songs first, then recent albums, playlists, then library albums not yet there; 8 max. */
    fun shortcuts(recent: List<Album>, playlists: List<Playlist>, albums: List<Album>): List<Shortcut> {
        val out = mutableListOf<Shortcut>(Shortcut.Liked)
        for (a in recent) { if (out.size >= 8) break; out += Shortcut.AlbumTile(a) }
        for (p in playlists) { if (out.size >= 8) break; out += Shortcut.PlaylistTile(p) }
        for (a in albums) {
            if (out.size >= 8) break
            // The web compares bare ids across kinds (`o.item?.Id === a.Id`).
            val taken = out.any {
                when (it) {
                    is Shortcut.AlbumTile -> it.album.id == a.id
                    is Shortcut.PlaylistTile -> it.playlist.id == a.id
                    Shortcut.Liked -> false
                }
            }
            if (!taken) out += Shortcut.AlbumTile(a)
        }
        return out
    }

    /** Daily Mix seeds: the first 6 top artists, or the first 6 library artists without plays. */
    fun mixSeeds(topArtists: List<RankedArtist>, libraryArtists: List<Artist>): List<RankedArtist> {
        if (topArtists.isNotEmpty()) return topArtists.take(6)
        return libraryArtists.take(6).map { RankedArtist(it.id, it.name, it.image) }
    }

    data class Counts(
        val mixes: Int = 0, val years: Int = 0, val recent: Int = 0,
        val recentArtists: Int = 0, val radar: Int = 0, val topArtists: Int = 0,
    )

    /** Which sections show, in the web's order (UI.md 6.1.3). Made For You hides without mixes (DECISIONS: web bug fixed). */
    fun sections(filter: Filter, counts: Counts): List<Section> {
        val music = filter != Filter.Artists
        val artists = filter != Filter.Music
        val out = mutableListOf<Section>()
        if (music) out += Section.Shortcuts
        if (music && counts.mixes > 0) out += Section.MadeForYou
        if (music && counts.years > 0) out += Section.TopSongs
        if (music && counts.recent > 0) out += Section.Recent
        if (artists && counts.recentArtists > 0) out += Section.JumpBackIn
        if (music && counts.radar > 0) out += Section.Radar
        if (artists && counts.topArtists > 0) out += Section.TopArtists
        return out
    }

    /** `MIX_COLORS[i % 8]`. */
    fun mixColorIndex(i: Int): Int = ((i % 8) + 8) % 8

    /** Home.jsx `topSongsSub`. */
    fun topSongsSub(year: Int, currentYear: Int): String =
        if (year == currentYear) L("Your most played songs of {year} so far", "year" to year)
        else L("The songs you played most in {year}", "year" to year)

    /** Library.jsx `fmtTotalShort`: "3h 7min", "9min 39sec". */
    fun totalShort(ms: Int): String {
        val s = Math.round(ms / 1000.0).toInt()
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h > 0) L("{h}h {m}min", "h" to h, "m" to m) else L("{m}min {sec}sec", "m" to m, "sec" to sec)
    }

    /** Mix hero stats: "{sub} • {duration}", the duration only once there is one. */
    fun mixStats(sub: String?, totalMs: Int): String =
        listOfNotNull(sub, if (totalMs > 0) totalShort(totalMs) else null).filter { it.isNotEmpty() }.joinToString(" • ")

    // Release Radar

    /** Home shelf subtitle: "{artistName} • {t(rtype) or t('Album')}". */
    fun radarShelfSub(r: Release): String = "${r.artistName ?: ""} • ${r.rtype?.let { L(it) } ?: L("Album")}"

    /** Radar page, owned card: "{artistName} • {date}". */
    fun radarOwnedSub(r: Release): String = listOfNotNull(r.artistName, r.date).filter { it.isNotEmpty() }.joinToString(" • ")

    /**
     * Radar page, missing card, after the artist link: " • {t(rtype)} • {date}". Empty parts are
     * skipped (the web prints a double bullet when rtype is missing).
     */
    fun radarMissingTail(r: Release): String =
        listOfNotNull(r.rtype?.let { L(it) }, r.date).filter { it.isNotEmpty() }.joinToString("") { " • $it" }

    /** Library.jsx `stateOf`: the server state wins once it reports progress; until then the tap's own. */
    fun requestState(server: String?, mine: String?): String? {
        if (mine != null && (server == null || server == "failed")) return mine
        return server ?: mine
    }

    data class RequestUi(val label: String, val busy: Boolean)

    /** Library.jsx `requestUi`. */
    fun requestUi(state: String?): RequestUi = when (state) {
        "queued", "exists" -> RequestUi(L("Requested"), true)
        "downloading" -> RequestUi(L("Downloading…"), true)
        "failed" -> RequestUi(L("Retry"), false)
        "error" -> RequestUi(L("Failed"), false)
        else -> RequestUi(L("Request"), false)
    }
}
