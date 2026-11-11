package com.lukasbaxter.slopify.android.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

// REST shapes (ios/docs/API.md §5). Durations in ms, timestamps epoch ms.

@Serializable
data class Format(
    val codec: String? = null,
    val lossless: Boolean? = null,
    val bitrate: Double? = null,
    val sampleRate: Double? = null,
    val bitDepth: Double? = null,
)

@Serializable
data class Gain(val track: Double? = null, val album: Double? = null)

@Serializable
data class Track(
    val id: String,
    val title: String,
    val artist: String,
    val artists: List<String>,
    val artistIds: List<String>,
    val albumId: String,
    val album: String,
    val albumArtist: String,
    val trackNo: Int? = null,
    val discNo: Int? = null,
    val year: Int? = null,
    val genres: List<String>? = null,
    val durationMs: Int,
    val codec: String? = null,
    val bitrate: Double? = null,
    val cover: String? = null,
    val format: Format? = null,
    val gain: Gain? = null,
    val addedAt: Double? = null,
    /** Only on /api/home topTracks. */
    val plays: Int? = null,
) {
    /** Seconds. */
    val duration: Double get() = durationMs / 1000.0

    /** (artist name, artist id) pairs; ids may be shorter than names on odd data. */
    val artistCredits: List<ArtistCredit>
        get() = artists.mapIndexed { i, n -> ArtistCredit(n, artistIds.getOrNull(i)) }

    /** Joined credit as the web reports it (`Artists.join(', ') || AlbumArtist`). */
    val creditLine: String
        get() = if (artists.isEmpty()) artist.ifEmpty { albumArtist } else artists.joinToString(", ")
}

data class ArtistCredit(val name: String, val id: String?)

@Serializable
data class Album(
    val id: String,
    val name: String,
    val artist: String,
    val artistId: String? = null,
    val year: Int? = null,
    val trackCount: Int? = null,
    val durationMs: Int? = null,
    val cover: String? = null,
    val addedAt: Double? = null,
    val likedAt: Double? = null,
)

/** The album's fields and `tracks` side by side in one object (API.md §7). */
@Serializable(with = AlbumDetailSerializer::class)
data class AlbumDetail(val album: Album, val tracks: List<Track>)

@Serializable
data class Artist(
    val id: String,
    val name: String,
    val trackCount: Int? = null,
    val albumCount: Int? = null,
    val image: String? = null,
    val banner: String? = null,
    val followedAt: Double? = null,
)

@Serializable(with = ArtistDetailSerializer::class)
data class ArtistDetail(
    val artist: Artist,
    val followed: Boolean = false,
    val albums: List<Album> = emptyList(),
    val appearsOn: List<Album> = emptyList(),
    val tracks: List<Track> = emptyList(),
)

@Serializable
data class Playlist(
    val id: String,
    val name: String,
    val userId: String? = null,
    val created: Double? = null,
    val updated: Double? = null,
    val trackCount: Int? = null,
    val cover: String? = null,
    val aiPrompt: String? = null,
)

@Serializable(with = PlaylistDetailSerializer::class)
data class PlaylistDetail(val playlist: Playlist, val tracks: List<Track> = emptyList())

@Serializable
data class Page<T>(val items: List<T>, val total: Int? = null, val offset: Int? = null, val limit: Int? = null)

@Serializable
data class Items<T>(val items: List<T>)

@Serializable
data class LibraryInfo(val version: String, val tracks: Int? = null, val albums: Int? = null, val artists: Int? = null)

@Serializable
data class HomeData(val recentAlbums: List<Album>, val topTracks: List<Track>, val newestAlbums: List<Album>)

@Serializable
data class BrowseTile(
    val id: String,
    val name: String,
    val count: Int? = null,
    val coverId: String? = null,
    val cover: String? = null,
    val covers: List<String>? = null,
    val kind: String? = null,
)

@Serializable
data class SearchResults(val tracks: List<Track>, val albums: List<Album>, val artists: List<Artist>)

/** What an id is: the server decides likes, saves and follows by it (API.md §9). */
@Serializable
enum class ItemKind {
    @SerialName("album") Album,
    @SerialName("artist") Artist,
    @SerialName("track") Track,
}

@Serializable
data class ItemLookup(val kind: ItemKind, val item: JsonElement)

@Serializable
data class GenreDetail(
    val name: String,
    val trackCount: Int? = null,
    val albumCount: Int? = null,
    val topArtists: List<TopArtist>,
    val albums: List<Album>,
    val recent: List<Album>,
) {
    @Serializable
    data class TopArtist(val id: String, val name: String, val plays: Int? = null, val albums: Int? = null)
}

/** Upstream (Lidarr) release; snake_case fields as the server sends them. */
@Serializable
data class Release(
    @SerialName("album_id") val albumId: String? = null,
    val title: String,
    val artist: String? = null,
    val rtype: String? = null,
    /** A string in the contract, but a radar list kept from an older build can carry a number. */
    @Serializable(with = StringOrNumberSerializer::class) val year: String? = null,
    val date: String? = null,
    val image: String? = null,
    @SerialName("total_tracks") val totalTracks: Int? = null,
    val inLibrary: String? = null,
    val localName: String? = null,
    val artistId: String? = null,
    /** Only on /api/radar. */
    val artistName: String? = null,
    val requestStatus: String? = null,
) {
    /** Two artists can share a release (splits, features): the key needs both ids. */
    val key: String get() = "${albumId ?: title}:${artistId ?: ""}"
}

@Serializable
data class Discography(val artist: Head? = null, val releases: List<Release>) {
    @Serializable
    data class Head(val name: String, val image: String? = null)
}

@Serializable
data class EverywhereResults(val albums: List<Release>, val artists: List<ArtistHit>) {
    @Serializable
    data class ArtistHit(val name: String, val id: String? = null)
}

@Serializable
data class Lyrics(val kind: String, val source: String? = null, val lines: List<Line>) {
    /** `kind`: synced | plain | instrumental. `start` in ms. */
    @Serializable
    data class Line(val start: Int? = null, val text: String)
}

@Serializable
data class LyricJob(
    val trackId: String,
    val title: String? = null,
    val state: String,
    val step: String? = null,
    val ahead: Int? = null,
    val result: String? = null,
    val requested: Double? = null,
    val finished: Double? = null,
    /** Only on POST /sync: a job for this song was already queued or running. */
    val already: Boolean? = null,
)

@Serializable
data class LyricJobs(val jobs: List<LyricJob>)

@Serializable
data class FolderCover(val ok: Boolean? = null, val cover: String? = null)

@Serializable
data class LibraryLayout(val order: List<String>, val folders: List<Folder>) {
    @Serializable
    data class Folder(val id: String, val name: String, val cover: String? = null, val items: List<String>)
}

@Serializable
data class HistoryPage(val items: List<Entry>) {
    @Serializable
    data class Entry(val at: Double, val client: String? = null, val track: Track)
}

@Serializable
data class TopSongYears(val years: List<Year>) {
    @Serializable
    data class Year(val year: Int, val songs: Int, val plays: Int, val top: Track? = null)
}

@Serializable
data class Mix(val items: List<Track>, val from: String? = null, val day: String? = null)

@Serializable
data class LikesMap(val at: Map<String, Double>, val items: List<Track>? = null)

@Serializable
data class LikeResult(val ok: Boolean, val at: Double? = null, val album: Boolean? = null, val artist: Boolean? = null)

@Serializable
data class Ok(val ok: Boolean? = null)

@Serializable
data class Created(val id: String, val name: String)

// Flattened details: the parent's fields and the lists in one JSON object.

private fun JsonDecoder.obj(): JsonObject = decodeJsonElement().jsonObject

private fun merge(base: JsonElement, vararg extra: Pair<String, JsonElement>): JsonObject =
    JsonObject(base.jsonObject + extra)

internal object AlbumDetailSerializer : KSerializer<AlbumDetail> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("AlbumDetail")
    override fun deserialize(decoder: Decoder): AlbumDetail {
        val d = decoder as JsonDecoder
        val o = d.obj()
        return AlbumDetail(d.json.decodeFromJsonElement(o), d.json.decodeFromJsonElement(o["tracks"] ?: error("tracks missing")))
    }
    override fun serialize(encoder: Encoder, value: AlbumDetail) {
        val e = encoder as JsonEncoder
        e.encodeJsonElement(merge(e.json.encodeToJsonElement(value.album), "tracks" to e.json.encodeToJsonElement(value.tracks)))
    }
}

internal object PlaylistDetailSerializer : KSerializer<PlaylistDetail> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("PlaylistDetail")
    override fun deserialize(decoder: Decoder): PlaylistDetail {
        val d = decoder as JsonDecoder
        val o = d.obj()
        val tracks: List<Track> = o["tracks"]?.takeIf { it is JsonArray }?.let { d.json.decodeFromJsonElement(it) } ?: emptyList()
        return PlaylistDetail(d.json.decodeFromJsonElement(o), tracks)
    }
    override fun serialize(encoder: Encoder, value: PlaylistDetail) {
        val e = encoder as JsonEncoder
        e.encodeJsonElement(merge(e.json.encodeToJsonElement(value.playlist), "tracks" to e.json.encodeToJsonElement(value.tracks)))
    }
}

internal object ArtistDetailSerializer : KSerializer<ArtistDetail> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("ArtistDetail")
    override fun deserialize(decoder: Decoder): ArtistDetail {
        val d = decoder as JsonDecoder
        val o = d.obj()
        fun albums(k: String): List<Album> = o[k]?.takeIf { it is JsonArray }?.let { d.json.decodeFromJsonElement(it) } ?: emptyList()
        return ArtistDetail(
            artist = d.json.decodeFromJsonElement(o),
            followed = o["followed"].asBool() ?: false,
            albums = albums("albums"),
            appearsOn = albums("appearsOn"),
            tracks = o["tracks"]?.takeIf { it is JsonArray }?.let { d.json.decodeFromJsonElement(it) } ?: emptyList(),
        )
    }
    override fun serialize(encoder: Encoder, value: ArtistDetail) {
        val e = encoder as JsonEncoder
        e.encodeJsonElement(
            merge(
                e.json.encodeToJsonElement(value.artist),
                "followed" to JsonPrimitive(value.followed),
                "albums" to e.json.encodeToJsonElement(value.albums),
                "appearsOn" to e.json.encodeToJsonElement(value.appearsOn),
                "tracks" to e.json.encodeToJsonElement(value.tracks),
            ),
        )
    }
}

/** A string field that older servers sometimes send as a number. */
internal object StringOrNumberSerializer : KSerializer<String?> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("StringOrNumber", PrimitiveKind.STRING).nullable
    override fun deserialize(decoder: Decoder): String? = (decoder as JsonDecoder).decodeJsonElement().asStringOrNumber()
    override fun serialize(encoder: Encoder, value: String?) {
        (encoder as JsonEncoder).encodeJsonElement(if (value == null) JsonNull else JsonPrimitive(value))
    }
}
