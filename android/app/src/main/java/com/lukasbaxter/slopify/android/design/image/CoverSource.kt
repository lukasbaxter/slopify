package com.lukasbaxter.slopify.android.design.image

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Track

/**
 * What picture to show (ios Design/Image/CoverSource.swift). Builds the URL from the signed-in
 * [ApiClient] (API.md §11): art hashes go to the immutable `/api/art/:hash`, everything else to
 * `/api/image/:id`.
 */
@Immutable
sealed interface CoverSource {
    /** Album cover; `art` = `Album.cover` hash. */
    data class AlbumArt(val id: String, val art: String?) : CoverSource
    /** A track's album cover; `art` = `Track.cover`. */
    data class TrackArt(val id: String, val albumId: String?, val art: String?) : CoverSource
    /** Playlist cover; `cover` = `Playlist.cover`, used as cache-buster (it changes with the songs). */
    data class PlaylistArt(val id: String, val cover: String?) : CoverSource
    /** Artist portrait; `image` = `Artist.image` hash. */
    data class ArtistArt(val id: String, val image: String?) : CoverSource
    /** Artist wide banner. */
    data class Banner(val artistId: String) : CoverSource
    /** Library folder picture (`fd_`). */
    data class Folder(val id: String) : CoverSource
    data class User(val id: String) : CoverSource
    /** Any absolute URL (Lidarr release art, now-playing `artUrl`). */
    data class Url(val url: String?) : CoverSource

    /** `size` in pixels (callers pass dp x density). Null without an API client. */
    fun url(api: ApiClient?, size: Int): String? {
        if (this is Url) return url
        if (api == null) return null
        return when (this) {
            is AlbumArt -> if (art != null && size <= 640) api.artUrl(art, size).toString() else api.imageUrl(id, size).toString()
            is TrackArt -> if (art != null && size <= 640) api.artUrl(art, size).toString() else api.imageUrl(albumId?.takeIf { it.isNotEmpty() } ?: id, size).toString()
            is PlaylistArt -> api.imageUrl(id, size, bust = cover).toString()
            is ArtistArt -> if (image != null && size <= 640) api.artUrl(image, size).toString() else api.imageUrl(id, size).toString()
            is Banner -> api.imageUrl(artistId, size, banner = true).toString()
            is Folder -> api.imageUrl(id, size).toString()
            is User -> api.avatarUrl(id).toString()
            is Url -> url
        }
    }

    companion object {
        fun of(a: Album): CoverSource = AlbumArt(a.id, a.cover)
        fun of(t: Track): CoverSource = TrackArt(t.id, t.albumId, t.cover)
        fun of(p: Playlist): CoverSource = PlaylistArt(p.id, p.cover)
        fun of(a: Artist): CoverSource = ArtistArt(a.id, a.image)
    }
}

/** The signed-in API client, for image URLs. The design root provides `account.api`. */
val LocalApiClient = staticCompositionLocalOf<ApiClient?> { null }
