package com.lukasbaxter.slopify.android.core.session

import com.lukasbaxter.slopify.android.core.model.Gain
import com.lukasbaxter.slopify.android.core.model.Track
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Socket shapes (ios/docs/API.md §20.5). Positions in SECONDS here. PascalCase on the wire
// where the server uses it (queue items, NameId), camelCase elsewhere.

@Serializable
data class NameId(
    @SerialName("Id") val id: String? = null,
    @SerialName("Name") val name: String,
)

@Serializable
data class OutputDevice(
    val id: String,
    val kind: String,
    val name: String,
    val members: List<String>? = null,
) {
    companion object {
        fun local(name: String) = OutputDevice(id = "local", kind = "local", name = name)
    }
}

@Serializable
data class NowPlaying(
    val itemId: String,
    val title: String,
    val artist: String,
    val album: String? = null,
    val artUrl: String? = null,
    val albumId: String? = null,
    val artistId: String? = null,
    val artists: List<NameId>? = null,
    val liked: Boolean? = null,
    val device: OutputDevice? = null,
    val queueIndex: Int? = null,
    val playing: Boolean,
    val held: Boolean? = null,
    val position: Double,
    val duration: Double? = null,
    val volume: Double? = null,
    val repeat: String? = null,
    val shuffle: String? = null,
    val at: Double? = null,
    /** Added by the server on relay. Use this for clock math. */
    val serverAt: Double? = null,
)

@Serializable
data class QueueItem(
    @SerialName("Id") val id: String,
    @SerialName("Name") val name: String? = null,
    @SerialName("Artists") val artists: List<String>? = null,
    @SerialName("AlbumArtist") val albumArtist: String? = null,
    @SerialName("Album") val album: String? = null,
    @SerialName("AlbumId") val albumId: String? = null,
    /** 100 ns ticks (Jellyfin heritage). */
    @SerialName("RunTimeTicks") val runTimeTicks: Long? = null,
    @SerialName("ArtistItems") val artistItems: List<NameId>? = null,
    @SerialName("AlbumArtists") val albumArtists: List<NameId>? = null,
    @SerialName("UserData") val userData: Favorite? = null,
    @SerialName("_queued") val queued: Boolean? = null,
    @SerialName("_gain") val gain: Gain? = null,
) {
    @Serializable
    data class Favorite(@SerialName("IsFavorite") val isFavorite: Boolean? = null)

    companion object {
        fun of(t: Track, queued: Boolean = false, liked: Boolean = false) = QueueItem(
            id = t.id, name = t.title, artists = t.artists, albumArtist = t.albumArtist, album = t.album,
            albumId = t.albumId, runTimeTicks = t.durationMs.toLong() * 10_000L,
            artistItems = t.artistCredits.map { NameId(it.id, it.name) },
            albumArtists = listOf(NameId(t.artistIds.firstOrNull(), t.albumArtist)),
            userData = Favorite(liked), queued = queued, gain = t.gain,
        )
    }
}

@Serializable
data class RosterPlayer(
    val id: String,
    val name: String,
    val kind: String? = null,
    val form: String? = null,
    val canPlay: Boolean? = null,
    val nowPlaying: NowPlaying? = null,
    val sameNetwork: Boolean? = null,
) {
    /** The virtual `server:<uid>` speaker client. */
    val isServer: Boolean get() = id.startsWith("server:")
}

@Serializable
data class LanDevice(
    val id: String,
    val kind: String,
    val name: String,
    val model: String? = null,
    val group: List<String>? = null,
    val state: State? = null,
    val viaClient: String? = null,
) {
    @Serializable
    data class State(
        val volume: Double? = null,
        val muted: Boolean? = null,
        val playing: Boolean? = null,
        val title: String? = null,
        val input: String? = null,
    )
}

/** Sleep timer state (`hello-ok.sleep`, `sleep` messages). `at` epoch ms. */
@Serializable
data class SleepState(val at: Double? = null, val endOfTrack: Boolean)

/** A playable Track from a socket queue item (mirrors, transfers). Cover and format come later (`api.tracks`). */
fun QueueItem.toTrack(): Track {
    val names = artists ?: artistItems?.map { it.name } ?: emptyList()
    return Track(
        id = id, title = name ?: "", artist = names.joinToString(", "), artists = names,
        artistIds = artistItems?.mapNotNull { it.id } ?: emptyList(),
        albumId = albumId ?: "", album = album ?: "", albumArtist = albumArtist ?: names.firstOrNull() ?: "",
        durationMs = ((runTimeTicks ?: 0L) / 10_000L).toInt(), gain = gain,
    )
}

/** The only thing a session snapshot may carry (web `applySession` fallback). */
fun NowPlaying.toTrack(): Track {
    val names = artists?.map { it.name } ?: if (artist.isEmpty()) emptyList() else listOf(artist)
    return Track(
        id = itemId, title = title, artist = artist, artists = names,
        artistIds = artists?.mapNotNull { it.id } ?: listOfNotNull(artistId),
        albumId = albumId ?: "", album = album ?: "", albumArtist = names.firstOrNull() ?: artist,
        durationMs = ((duration ?: 0.0) * 1000).toInt(),
    )
}
