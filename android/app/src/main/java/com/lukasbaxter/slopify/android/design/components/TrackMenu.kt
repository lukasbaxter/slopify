package com.lukasbaxter.slopify.android.design.components

import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.sheets.MenuHeader
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The one track menu (UI.md 5.4.5, TrackRow.jsx:210-236; ios TrackMenu.swift), built from state
 * + actions so it is testable. Every list uses it; [TrackMenuBuilder] wires the actions to the
 * app. "Download ▸" file export is left out (DECISIONS 5).
 */
object TrackMenu {
    enum class Style {
        /** A track row (TrackRow.jsx:210-236). */
        Row,
        /**
         * The now playing ⋯ sheet (FullScreen.jsx:221-240): no taste-profile row, a separator
         * before Sync Lyrics, artist falls back to the first artist id.
         */
        NowPlaying,
    }

    data class State(
        val track: Track,
        val liked: Boolean,
        val excluded: Boolean,
        val downloaded: Boolean = false,
        val syncing: Boolean = false,
        val offline: Boolean = false,
        /** The user's playlists for "Add to playlist". */
        val playlists: List<Playlist> = emptyList(),
        val style: Style = Style.Row,
        /** Context rows after Share (now playing: the sleep timer). */
        val trailing: List<MenuItem> = emptyList(),
    )

    data class Actions(
        val addToQueue: (Track) -> Unit = {},
        val newPlaylist: (Track) -> Unit = {},
        val addTo: (Playlist, Track) -> Unit = { _, _ -> },
        /** "Remove from this playlist": only a user playlist's own page passes it. */
        val remove: ((Track) -> Unit)? = null,
        val like: (Track, Boolean) -> Unit = { _, _ -> },
        val exclude: (Track, Boolean) -> Unit = { _, _ -> },
        val radio: (Track) -> Unit = {},
        val openArtist: (String) -> Unit = {},
        val openAlbum: (String) -> Unit = {},
        val syncLyrics: (Track) -> Unit = {},
        val share: (Track) -> Unit = {},
    )

    fun header(t: Track): MenuHeader = MenuHeader(MenuHeader.Art.Cover(CoverSource.of(t)), t.title, artistLine(t))

    fun items(s: State, a: Actions): List<MenuItem> {
        val t = s.track
        val sub = playlistSub(s.playlists, new = { a.newPlaylist(t) }, add = { p -> a.addTo(p, t) })
        var artists = t.artistCredits.mapNotNull { c -> c.id?.takeIf { it.isNotEmpty() }?.let { c.name to it } }
        // FullScreen.jsx:233: the session's artistId when no credit carries one.
        if (artists.isEmpty() && s.style == Style.NowPlaying) t.artistIds.firstOrNull()?.takeIf { it.isNotEmpty() }?.let { artists = listOf(t.artist to it) }

        val items = mutableListOf(
            MenuItem(L("Add to queue"), Icon.Queue, offline = s.downloaded) { a.addToQueue(t) },
            MenuItem(L("Add to playlist"), Icon.Plus, sub = sub),
        )
        a.remove?.let { remove -> items += MenuItem(L("Remove from this playlist"), Icon.Trash) { remove(t) } }
        items += MenuItem(if (s.liked) L("Remove from Liked Songs") else L("Add to Liked Songs"), if (s.liked) Icon.HeartFilled else Icon.Heart) { a.like(t, !s.liked) }
        if (s.style == Style.Row) {
            items += MenuItem(if (s.excluded) L("Include in your taste profile") else L("Exclude from your taste profile"), Icon.Ban) { a.exclude(t, !s.excluded) }
        }
        items += MenuItem.separator
        items += MenuItem(L("Go to song radio"), Icon.Radio) { a.radio(t) }
        if (artists.size == 1) {
            val id = artists[0].second
            items += MenuItem(L("Go to artist"), Icon.Artist, offline = true) { a.openArtist(id) }
        } else if (artists.size > 1) {
            items += MenuItem(L("Go to artist"), Icon.Artist, offline = true, sub = artists.map { (name, id) -> MenuItem(name, offline = true) { a.openArtist(id) } })
        }
        if (t.albumId.isNotEmpty()) items += MenuItem(L("Go to album"), Icon.Album, offline = true) { a.openAlbum(t.albumId) }
        if (s.style == Style.NowPlaying) items += MenuItem.separator
        items += MenuItem(if (s.syncing) L("Syncing Lyrics…") else L("Sync Lyrics"), Icon.Lyrics, disabled = s.syncing) { a.syncLyrics(t) }
        // FullScreen.jsx G16.share: now playing has its own share glyph.
        items += MenuItem(L("Share"), if (s.style == Style.NowPlaying) Icon.Share16 else Icon.Share) { a.share(t) }
        items += s.trailing
        return if (s.offline) MenuItem.offlineSubset(items) else MenuItem.tidy(items)
    }

    /** "Add to playlist ▸": New playlist, a separator when there are playlists, one row each. */
    fun playlistSub(playlists: List<Playlist>, new: () -> Unit, add: (Playlist) -> Unit): List<MenuItem> {
        val sub = mutableListOf(MenuItem(L("New playlist"), Icon.Plus, action = new))
        if (playlists.isNotEmpty()) sub += MenuItem.separator
        sub += playlists.map { p -> MenuItem(p.name) { add(p) } }
        return sub
    }

    /** The New playlist prompt's start text (App.jsx:1060): the album, else "My Playlist". */
    fun newPlaylistName(seed: Track?): String = seed?.album?.takeIf { it.isNotEmpty() } ?: L("My Playlist")

    // Share (TrackRow.jsx:38-57)

    enum class ShareKind(val wire: String) { Track("track"), Album("album"), Artist("artist") }

    /** `{main}/?{kind}={id}` on the server's main address. */
    fun shareUrl(main: String, kind: ShareKind, id: String): String? {
        val base = main.trimEnd('/')
        val u = "$base/".toHttpUrlOrNull() ?: return null
        return u.newBuilder().addQueryParameter(kind.wire, id).build().toString()
    }

    fun shareTitle(title: String, by: String?): String = if (by.isNullOrEmpty()) title else "$title — $by"

    /** `by` of a track share: the artist names (TrackRow.jsx:233, no album-artist fallback). */
    fun shareBy(t: Track): String = t.artists.filter { it.isNotEmpty() }.joinToString(", ")

    // Taste profile (prefs.dislikes = { trackId: ms })

    fun isExcluded(id: String, prefs: Prefs): Boolean = (prefs["dislikes"] as? JsonObject)?.get(id) != null

    fun dislikes(prefs: Prefs, setting: String, excluded: Boolean, now: Double): JsonObject {
        val cur = (prefs["dislikes"] as? JsonObject)?.toMutableMap() ?: mutableMapOf()
        if (excluded) cur[setting] = JsonPrimitive(now) else cur.remove(setting)
        return JsonObject(cur)
    }
}
