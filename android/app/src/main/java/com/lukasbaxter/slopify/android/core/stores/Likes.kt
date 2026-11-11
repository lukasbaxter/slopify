package com.lukasbaxter.slopify.android.core.stores

import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.api.followedArtists
import com.lukasbaxter.slopify.android.core.api.like
import com.lukasbaxter.slopify.android.core.api.likes
import com.lukasbaxter.slopify.android.core.api.savedAlbums
import com.lukasbaxter.slopify.android.core.api.unlike
import com.lukasbaxter.slopify.android.core.model.ItemKind
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Liked tracks (id -> liked at, epoch ms), saved albums, followed artists. */
data class LikesState(
    val tracks: Map<String, Double> = emptyMap(),
    val albums: Set<String> = emptySet(),
    val artists: Set<String> = emptySet(),
    /**
     * True once the liked tracks came back from the server in this run (a heart showing
     * "not liked" before that may just be unknown).
     */
    val loaded: Boolean = false,
) {
    fun isLiked(id: String): Boolean = id in tracks || id in albums || id in artists
}

/** Liked tracks, saved albums, followed artists (API.md §9). Shared by every screen's hearts. */
class Likes(private val now: () -> Double = { System.currentTimeMillis().toDouble() }) {
    private val mutable = MutableStateFlow(LikesState())
    val state: StateFlow<LikesState> = mutable.asStateFlow()

    @Volatile private var api: ApiClient? = null

    fun attach(api: ApiClient) { this.api = api }

    fun isLiked(id: String): Boolean = mutable.value.isLiked(id)

    suspend fun refresh() {
        val api = api ?: return
        attempt { api.likes() }?.let { m -> mutable.update { it.copy(tracks = m.at, loaded = true) } }
        attempt { api.savedAlbums() }?.let { a -> mutable.update { it.copy(albums = a.map { x -> x.id }.toSet()) } }
        attempt { api.followedArtists() }?.let { a -> mutable.update { it.copy(artists = a.map { x -> x.id }.toSet()) } }
    }

    /** Signed out: the next account must not see these hearts. */
    fun reset() { mutable.value = LikesState() }

    /** Track like, album save or artist follow (the server decides by id). Errors are swallowed. */
    suspend fun toggle(id: String, kind: ItemKind = ItemKind.Track) {
        attempt { toggleThrowing(id, kind) }
    }

    /** Like [toggle], but the server's error comes back (after the heart flipped back). */
    suspend fun toggleThrowing(id: String, kind: ItemKind = ItemKind.Track) = set(id, kind, !isLiked(id))

    /** Optimistic: shown at once, rolled back and rethrown when the server says no. No-op when already so. */
    suspend fun set(id: String, kind: ItemKind = ItemKind.Track, liked: Boolean) {
        val api = api ?: throw ApiError.Offline()
        val was = isLiked(id)
        if (was == liked) return
        apply(id, kind, liked)
        try {
            if (liked) {
                val r = api.like(id)
                val at = r.at
                if (kind == ItemKind.Track && at != null) mutable.update { it.copy(tracks = it.tracks + (id to at)) }
            } else {
                api.unlike(id)
            }
        } catch (e: Throwable) {
            apply(id, kind, was)
            throw e
        }
    }

    /** From the socket `like` broadcast (tracks only). */
    fun remote(id: String, liked: Boolean, at: Double? = null) = apply(id, ItemKind.Track, liked, at)

    private fun apply(id: String, kind: ItemKind, liked: Boolean, at: Double? = null) = mutable.update {
        when (kind) {
            ItemKind.Track -> it.copy(tracks = if (liked) it.tracks + (id to (at ?: now())) else it.tracks - id)
            ItemKind.Album -> it.copy(albums = if (liked) it.albums + id else it.albums - id)
            ItemKind.Artist -> it.copy(artists = if (liked) it.artists + id else it.artists - id)
        }
    }
}
