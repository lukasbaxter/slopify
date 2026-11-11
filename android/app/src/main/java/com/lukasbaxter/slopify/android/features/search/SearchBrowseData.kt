package com.lukasbaxter.slopify.android.features.search

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.albums
import com.lukasbaxter.slopify.android.core.api.artists
import com.lukasbaxter.slopify.android.core.api.browse
import com.lukasbaxter.slopify.android.core.api.home
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.BrowseTile
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.storage.KeyValueStore
import com.lukasbaxter.slopify.android.design.theme.RGB
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/**
 * What the Browse state paints (UI.md 6.2.5): the genre tiles from `GET /api/browse` and the
 * covers of the four "Start browsing" tiles. Painted from the local copy first, then refreshed
 * (UI.md 6.0.15). Keyed per server and user so two accounts never share tiles.
 */
class SearchBrowseData(private val store: KeyValueStore) {
    @Serializable
    data class Saved(
        val tiles: List<BrowseTile>? = null,
        /** Daily Mix 1's seed: the top artist from Home, else the first library artist. */
        val topArtist: String? = null,
        val firstArtist: String? = null,
        /** Album of the most played track (`browse.chartsTop`). */
        val chartsTop: String? = null,
        val recentAlbum: String? = null,
        /** First two library albums (A-Z), the fallbacks of New Releases and Charts. */
        val firstAlbums: List<String> = emptyList(),
    ) {
        val madeForYouCover: String? get() = topArtist ?: firstArtist
        /** Home never writes `home.added`, so this is the first library album (UI.md 6.2.5 note). */
        val newReleasesCover: String? get() = firstAlbums.firstOrNull()
        val chartsCover: String? get() = chartsTop ?: recentAlbum ?: firstAlbums.getOrNull(1)
    }

    private val mutable = MutableStateFlow(Saved())
    val saved: StateFlow<Saved> = mutable.asStateFlow()
    private var key: String? = null

    fun use(key: String?) {
        if (key == this.key) return
        this.key = key
        mutable.value = key?.let { load(store, it) } ?: Saved()
    }

    suspend fun refresh(api: ApiClient) {
        val k = key
        val next = coroutineScope {
            val tiles = async { attempt { api.browse() } }
            val home = async { attempt { api.home() } }
            val albums = async { attempt { api.albums(limit = 2) } }
            val artists = async { attempt { api.artists(limit = 1) } }
            var s = mutable.value
            tiles.await()?.let { s = s.copy(tiles = it) }
            home.await()?.let { h ->
                s = s.copy(topArtist = SearchLogic.topArtistIds(h.topTracks).firstOrNull(), chartsTop = h.topTracks.firstOrNull()?.albumId, recentAlbum = h.recentAlbums.firstOrNull()?.id)
            }
            albums.await()?.let { s = s.copy(firstAlbums = it.map { a -> a.id }) }
            artists.await()?.let { s = s.copy(firstArtist = it.firstOrNull()?.id) }
            s
        }
        // Another account signed in meanwhile: its copy is not ours to overwrite.
        if (k != key || k == null) return
        mutable.value = next
        store.putString(k, SlopifyJson.encodeToString(Saved.serializer(), next))
    }

    companion object {
        fun storageKey(main: String?, userId: String?): String? =
            if (main == null || userId == null) null else "slopify.browse.$main.$userId"

        fun load(store: KeyValueStore, key: String): Saved? =
            store.getString(key)?.let { attempt { SlopifyJson.decodeFromString(Saved.serializer(), it) } }

        /** The colour a genre's tile had (DECISIONS: genre pages take their tile colour). */
        fun tileColor(genre: String, tiles: List<BrowseTile>?): RGB? {
            val i = tiles?.indexOfFirst { it.name == genre } ?: return null
            return if (i < 0) null else SearchLogic.tileColor(i)
        }
    }
}
