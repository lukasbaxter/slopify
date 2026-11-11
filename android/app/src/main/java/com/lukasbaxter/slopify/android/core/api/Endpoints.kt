package com.lukasbaxter.slopify.android.core.api

import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.AlbumDetail
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.ArtistDetail
import com.lukasbaxter.slopify.android.core.model.BrowseTile
import com.lukasbaxter.slopify.android.core.model.Created
import com.lukasbaxter.slopify.android.core.model.DeviceToken
import com.lukasbaxter.slopify.android.core.model.Discography
import com.lukasbaxter.slopify.android.core.model.DownloadScope
import com.lukasbaxter.slopify.android.core.model.DownloadsPage
import com.lukasbaxter.slopify.android.core.model.EverywhereResults
import com.lukasbaxter.slopify.android.core.model.FolderCover
import com.lukasbaxter.slopify.android.core.model.GenreDetail
import com.lukasbaxter.slopify.android.core.model.HistoryPage
import com.lukasbaxter.slopify.android.core.model.HistoryStats
import com.lukasbaxter.slopify.android.core.model.HomeData
import com.lukasbaxter.slopify.android.core.model.ItemLookup
import com.lukasbaxter.slopify.android.core.model.Items
import com.lukasbaxter.slopify.android.core.model.LibraryInfo
import com.lukasbaxter.slopify.android.core.model.LibraryLayout
import com.lukasbaxter.slopify.android.core.model.LikeResult
import com.lukasbaxter.slopify.android.core.model.LikesMap
import com.lukasbaxter.slopify.android.core.model.LoginResponse
import com.lukasbaxter.slopify.android.core.model.LyricJob
import com.lukasbaxter.slopify.android.core.model.LyricJobs
import com.lukasbaxter.slopify.android.core.model.Lyrics
import com.lukasbaxter.slopify.android.core.model.Mix
import com.lukasbaxter.slopify.android.core.model.Ok
import com.lukasbaxter.slopify.android.core.model.Page
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.PlaylistDetail
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.SearchResults
import com.lukasbaxter.slopify.android.core.model.ServerAddresses
import com.lukasbaxter.slopify.android.core.model.ServerInfo
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.model.TopSongYears
import com.lukasbaxter.slopify.android.core.model.User
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.add
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.TimeZone

// Typed wrappers for every endpoint the app uses (ios/docs/API.md section in each comment).

/** Minutes west of UTC, as the web sends `tzo` (`Date.getTimezoneOffset()`). */
fun timezoneOffsetMinutes(now: Long = System.currentTimeMillis()): Int = -TimeZone.getDefault().getOffset(now) / 60_000

private fun tzo() = timezoneOffsetMinutes().toString()

@Serializable private data class DevicesR(val devices: List<DeviceToken>)
@Serializable private data class HealthR(val ok: Boolean)
@Serializable private data class TilesR(val tiles: List<BrowseTile>)
@Serializable private data class IdsR(val ids: List<String>)
@Serializable private data class SimilarR(val artists: List<EverywhereResults.ArtistHit>)
@Serializable private data class RadarR(val releases: List<Release>? = null)
@Serializable private data class StatusR(val status: String? = null)

// §3 auth

suspend fun ApiClient.login(username: String, password: String, device: String): LoginResponse =
    call("POST", "api/auth/login", buildJsonObject { put("username", username); put("password", password); put("device", device); put("kind", "phone") })

/** null on a normal server (204), a guest session on a demo server. */
suspend fun ApiClient.demoSignIn(device: String): LoginResponse? {
    val req = Request.Builder().url(url("api/auth/demo"))
        .post(buildJsonObject { put("device", device) }.toString().toRequestBody("application/json".toMediaType()))
        .build()
    val body = attempt { http.newCall(req).await().use { r -> if (r.code == 200) r.body?.string() else null } }
    if (body.isNullOrEmpty()) return null
    return SlopifyJson.decodeFromString(LoginResponse.serializer(), body)
}

suspend fun ApiClient.register(invite: String, username: String, password: String): LoginResponse =
    call("POST", "api/auth/register", buildJsonObject { put("invite", invite); put("username", username); put("password", password) })

suspend fun ApiClient.me(): User = get("api/auth/me")

suspend fun ApiClient.logout() = send("POST", "api/auth/logout")

suspend fun ApiClient.changePassword(current: String?, new: String) =
    send("POST", "api/auth/password", buildJsonObject { current?.let { put("current", it) }; put("password", new) })

suspend fun ApiClient.devices(): List<DeviceToken> = get<DevicesR>("api/auth/devices").devices

suspend fun ApiClient.revokeDevice(id: String) = send("DELETE", "api/auth/devices/$id")

suspend fun ApiClient.healthz(): Boolean = get<HealthR>("api/healthz", timeout = 8.0).ok

/** healthz with its own timeout (seconds); any failure is false. */
suspend fun ApiClient.healthzOK(timeout: Double): Boolean =
    attempt { get<HealthR>("api/healthz", timeout = timeout).ok } ?: false

suspend fun ApiClient.serverInfo(): ServerInfo = get("api/server")

suspend fun ApiClient.serverAddresses(): ServerAddresses = get("api/server/addresses")

// §6 library, home, search

suspend fun ApiClient.library(): LibraryInfo = get("api/library")

suspend fun ApiClient.home(): HomeData = get("api/home")

/** 8 s: the Search page paints its kept tiles meanwhile. */
suspend fun ApiClient.browse(): List<BrowseTile> = get<TilesR>("api/browse", timeout = 8.0).tiles

suspend fun ApiClient.search(q: String, limit: Int = 20): SearchResults = get("api/search", mapOf("q" to q, "limit" to limit.toString()))

suspend fun ApiClient.searchEverywhere(q: String): EverywhereResults = get("api/gsearch", mapOf("q" to q), timeout = 35.0)

// §7 albums, artists, tracks, genres

suspend fun ApiClient.albums(sortAdded: Boolean = false, limit: Int = 20000): List<Album> =
    get<Page<Album>>("api/albums", mapOf("limit" to limit.toString(), "sort" to if (sortAdded) "added" else null)).items

suspend fun ApiClient.album(id: String): AlbumDetail = get("api/albums/$id")

suspend fun ApiClient.artists(limit: Int = 20000): List<Artist> = get<Page<Artist>>("api/artists", mapOf("limit" to limit.toString())).items

suspend fun ApiClient.artist(id: String): ArtistDetail = get("api/artists/$id")

suspend fun ApiClient.artistPopular(id: String): List<String> = get<IdsR>("api/artists/$id/popular", timeout = 15.0).ids

suspend fun ApiClient.lookup(id: String): ItemLookup = get("api/items/$id")

suspend fun ApiClient.track(id: String): Track = get("api/tracks/$id")

/** Batches of 100 (URL length); unknown ids are skipped, order kept. */
suspend fun ApiClient.tracks(ids: List<String>): List<Track> =
    ids.chunked(100).flatMap { get<Items<Track>>("api/tracks", mapOf("ids" to it.joinToString(","))).items }

/** Genre names may hold "/" ("R&B/Soul"): one path segment, escaped. */
suspend fun ApiClient.genre(name: String): GenreDetail = get("api/genres/${ApiClient.segment(name)}")

suspend fun ApiClient.genreTracks(name: String): List<Track> = get<Items<Track>>("api/genres/${ApiClient.segment(name)}/tracks").items

suspend fun ApiClient.genreMix(name: String): List<Track> = get<Items<Track>>("api/genres/${ApiClient.segment(name)}/mix").items

suspend fun ApiClient.discography(artistId: String): Discography = get("api/discography/$artistId")

suspend fun ApiClient.similar(artistId: String): List<EverywhereResults.ArtistHit> = get<SimilarR>("api/similar/$artistId").artists

// §8 playlists + layout

suspend fun ApiClient.playlists(): List<Playlist> = get<Items<Playlist>>("api/playlists").items

suspend fun ApiClient.playlist(id: String): PlaylistDetail = get("api/playlists/$id")

suspend fun ApiClient.createPlaylist(name: String, trackIds: List<String> = emptyList()): Created =
    call("POST", "api/playlists", buildJsonObject { put("name", name); putJsonArray("trackIds") { trackIds.forEach { add(it) } } })

suspend fun ApiClient.renamePlaylist(id: String, name: String) = send("PATCH", "api/playlists/$id", buildJsonObject { put("name", name) })

suspend fun ApiClient.deletePlaylist(id: String) = send("DELETE", "api/playlists/$id")

suspend fun ApiClient.addToPlaylist(id: String, trackIds: List<String>) =
    send("POST", "api/playlists/$id/tracks", buildJsonObject { putJsonArray("trackIds") { trackIds.forEach { add(it) } } })

/** Remove positions; sends highest first because positions renumber (§8). */
suspend fun ApiClient.removeFromPlaylist(id: String, positions: List<Int>) {
    for (p in positions.sortedDescending()) send("DELETE", "api/playlists/$id/tracks/$p")
}

suspend fun ApiClient.movePlaylistTrack(id: String, from: Int, to: Int) =
    send("POST", "api/playlists/$id/move", buildJsonObject { put("from", from); put("to", to) })

suspend fun ApiClient.setPlaylistCover(id: String, jpeg: ByteArray) {
    upload("api/playlists/$id/cover", jpeg, "image/jpeg", Ok.serializer())
}

suspend fun ApiClient.playlistRecommended(id: String, limit: Int = 10, seed: Int = 0): List<Track> =
    get<Items<Track>>("api/playlists/$id/recommended", mapOf("limit" to limit.toString(), "seed" to seed.toString())).items

suspend fun ApiClient.libraryLayout(): LibraryLayout = get("api/library/layout")

suspend fun ApiClient.putLibraryLayout(order: List<String>, folders: Map<String, List<String>>, rev: String): LibraryLayout =
    call(
        "PUT", "api/library/layout",
        buildJsonObject {
            putJsonArray("order") { order.forEach { add(it) } }
            putJsonObject("folders") { folders.forEach { (k, v) -> putJsonArray(k) { v.forEach { add(it) } } } }
        },
        headers = mapOf(REV to rev),
    )

suspend fun ApiClient.createFolder(name: String, rev: String): Created =
    call("POST", "api/library/folders", buildJsonObject { put("name", name) }, headers = mapOf(REV to rev))

suspend fun ApiClient.renameFolder(id: String, name: String, rev: String) =
    send("PATCH", "api/library/folders/$id", buildJsonObject { put("name", name) }, mapOf(REV to rev))

/** A folder's own picture; the answer carries its new cover hash. */
suspend fun ApiClient.setFolderCover(id: String, jpeg: ByteArray, rev: String): FolderCover =
    upload("api/library/folders/$id/cover", jpeg, "image/jpeg", FolderCover.serializer(), mapOf(REV to rev))

suspend fun ApiClient.deleteFolder(id: String, rev: String) = send("DELETE", "api/library/folders/$id", null, mapOf(REV to rev))

private const val REV = "X-Slopify-Rev"

// §9 likes

suspend fun ApiClient.likes(full: Boolean = false): LikesMap = get("api/likes", mapOf("full" to if (full) "1" else null))

suspend fun ApiClient.like(id: String): LikeResult = call("PUT", "api/likes/$id", JsonObject(emptyMap()))

suspend fun ApiClient.unlike(id: String) = send("DELETE", "api/likes/$id")

suspend fun ApiClient.savedAlbums(): List<Album> = get<Items<Album>>("api/likes/albums").items

suspend fun ApiClient.followedArtists(): List<Artist> = get<Items<Artist>>("api/likes/artists").items

// §10 lyrics

/** null when the server knows none (404). */
suspend fun ApiClient.lyrics(trackId: String): Lyrics? = try {
    get("api/lyrics/$trackId")
} catch (e: ApiError.Http) {
    if (e.status == 404) null else throw e
}

suspend fun ApiClient.requestLyricSync(trackId: String): LyricJob = call("POST", "api/lyrics/$trackId/sync", JsonObject(emptyMap()))

/** The jobs for these songs (the server reads the first 100 ids). */
suspend fun ApiClient.lyricJobs(ids: List<String>): List<LyricJob> {
    if (ids.isEmpty()) return emptyList()
    return get<LyricJobs>("api/lyrics/sync", mapOf("ids" to ids.take(100).joinToString(","))).jobs
}

/** This account's unfinished jobs, running first (picked back up after sign-in). */
suspend fun ApiClient.myLyricJobs(): List<LyricJob> = get<LyricJobs>("api/lyrics/sync", mapOf("mine" to "1")).jobs

// §14 recommendations

suspend fun ApiClient.mix(id: String, limit: Int? = null, mode: String? = null): Mix =
    get("api/tracks/$id/mix", mapOf("limit" to limit?.toString(), "mode" to mode, "tzo" to tzo()))

/** Release Radar (§14.2). Slow the first time the server asks upstream: the web waits 120 s. */
suspend fun ApiClient.radar(): List<Release> = get<RadarR>("api/radar", timeout = 120.0).releases ?: emptyList()

// §15 history

suspend fun ApiClient.history(limit: Int = 100, before: Double? = null): HistoryPage =
    get("api/history", mapOf("limit" to limit.toString(), "before" to before?.toLong()?.toString()))

/** Stats mode (§15.2) for `today | week | 4w | 6m | year`. */
suspend fun ApiClient.historyStats(range: String): HistoryStats =
    get("api/history", mapOf("range" to range, "tzo" to tzo()), HistoryStats.reader, timeout = 60.0)

suspend fun ApiClient.topSongYears(): TopSongYears = get("api/top-songs", mapOf("tzo" to tzo()))

suspend fun ApiClient.topSongs(year: Int): List<Track> = get<Items<Track>>("api/top-songs/$year", mapOf("tzo" to tzo())).items

/** Only when the socket is down or for offline plays (§15.1). */
suspend fun ApiClient.postPlay(trackId: String, at: Double? = null, client: String) =
    send("POST", "api/plays", buildJsonObject { put("trackId", trackId); at?.let { put("at", it) }; put("client", client) })

// §16 prefs

suspend fun ApiClient.prefs(): Prefs = get<JsonObject>("api/prefs")

suspend fun ApiClient.patchPrefs(patch: Prefs): Prefs = call<JsonObject>("PATCH", "api/prefs", JsonObject(patch))

// §12.4 warming

suspend fun ApiClient.warm(ids: List<String>, profile: String, norm: String?) =
    send(
        "POST", "api/stream/warm",
        buildJsonObject { putJsonArray("ids") { ids.take(10).forEach { add(it) } }; put("profile", profile); norm?.let { put("norm", it) } },
    )

// §18 requests and downloads

/**
 * Request an upstream album (`album_id` = MusicBrainz id). Returns the server's `status`
 * (`queued`, `exists`, ...). Lidarr can be slow: 40 s.
 */
suspend fun ApiClient.requestAlbum(mbid: String): String? =
    call<StatusR>("POST", "api/requests", buildJsonObject { put("album_id", mbid) }, timeout = 40.0).status

/** 35 s: the server answers from its kept copy after a few seconds when Lidarr is slow. */
suspend fun ApiClient.downloads(scope: DownloadScope): DownloadsPage =
    get("api/downloads", mapOf("scope" to scope.wire), DownloadsPage.reader, timeout = 35.0)

suspend fun ApiClient.retryDownload(id: Int) = send("POST", "api/downloads/$id/retry")

// §17 speakers

suspend fun ApiClient.speakerVolume(id: String, level: Int) = send("POST", "api/speakers/$id/volume", buildJsonObject { put("level", level) })

