package com.lukasbaxter.slopify.android.features.home

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.api.albums
import com.lukasbaxter.slopify.android.core.api.artists
import com.lukasbaxter.slopify.android.core.api.home
import com.lukasbaxter.slopify.android.core.api.playlists
import com.lukasbaxter.slopify.android.core.api.radar
import com.lukasbaxter.slopify.android.core.api.topSongYears
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.TopSongYears
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.io.File
import kotlin.coroutines.cancellation.CancellationException

/** Home's kept data (one file per account). */
@Serializable
data class HomeSnapshot(
    val recent: List<Album> = emptyList(),
    val topArtists: List<HomeLogic.RankedArtist> = emptyList(),
    val recentArtists: List<HomeLogic.RankedArtist> = emptyList(),
    val topYears: List<TopSongYears.Year> = emptyList(),
    /** The full radar list (Home shows the first 16, the Radar page all of them). */
    val radar: List<Release> = emptyList(),
    val playlists: List<Playlist> = emptyList(),
    val albums: List<Album> = emptyList(),
    val artists: List<Artist> = emptyList(),
) {
    val shortcuts: List<HomeLogic.Shortcut> get() = HomeLogic.shortcuts(recent, playlists, albums)
    val mixSeeds: List<HomeLogic.RankedArtist> get() = HomeLogic.mixSeeds(topArtists, artists)
    val radarShelf: List<Release> get() = radar.take(16)

    fun sections(filter: HomeLogic.Filter): List<HomeLogic.Section> = HomeLogic.sections(
        filter,
        HomeLogic.Counts(
            mixes = mixSeeds.size, years = topYears.size, recent = recent.size,
            recentArtists = recentArtists.size, radar = radar.size, topArtists = topArtists.size,
        ),
    )
}

data class HomeStoreState(
    val data: HomeSnapshot = HomeSnapshot(),
    /** True once the radar has answered (or failed) in this run; the Radar page shows "Checking…" before. */
    val radarLoaded: Boolean = false,
    val radarError: String? = null,
)

/**
 * Home's data (UI.md 6.1.3, 6.0.15; ios HomeStore.swift): every list paints from its kept copy
 * first, all sources refresh in parallel, failures are silent (the section keeps its old data or
 * stays hidden). One per signed-in account; switching accounts clears it.
 * TODO(lead): a shared library store (albums, artists, playlists) so Home, Library and Search do
 * not each fetch the full lists.
 */
class HomeStore(
    /** Runs the fetches, so leaving a screen does not cancel a refresh half way. */
    private val scope: CoroutineScope,
    /** Where kept copies live; null keeps nothing (tests). */
    var cacheDir: File? = null,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val mutable = MutableStateFlow(HomeStoreState())
    val state: StateFlow<HomeStoreState> = mutable.asStateFlow()
    val data: HomeSnapshot get() = mutable.value.data

    private var key: String? = null
    private var inflight: Job? = null
    private var loadedAt: Long? = null

    /** Switch to this account's kept copy (no-op when already on it). */
    fun use(key: String?) {
        if (key == this.key) return
        inflight?.cancel(); inflight = null
        this.key = key
        loadedAt = null
        val kept = key?.let { k -> file(k)?.takeIf { it.exists() } }?.let { f ->
            attempt { SlopifyJson.decodeFromString(HomeSnapshot.serializer(), f.readText()) }
        }
        mutable.value = HomeStoreState(data = kept ?: HomeSnapshot())
    }

    /** Refresh every source. `maxAgeMs`: skip when the last load is newer than this. */
    suspend fun load(api: ApiClient, maxAgeMs: Long = 0) {
        loadedAt?.let { if (now() - it < maxAgeMs) return }
        inflight?.let { if (it.isActive) { it.join(); return } }
        val forKey = key
        val job = scope.launch {
            launch { loadHome(api) }
            launch { loadYears(api) }
            launch { loadRadar(api) }
            launch { loadPlaylists(api) }
            launch { loadAlbums(api) }
            launch { loadArtists(api) }
        }
        inflight = job
        job.join()
        if (inflight === job) inflight = null
        if (job.isCancelled || forKey != key) return
        loadedAt = now()
        persist()
    }

    private suspend fun loadHome(api: ApiClient) {
        val h = attempt { api.home() } ?: return
        currentCoroutineContext().ensureActive()
        mutable.update {
            it.copy(
                data = it.data.copy(
                    recent = h.recentAlbums.take(16),
                    topArtists = HomeLogic.rankTopArtists(h.topTracks),
                    // /api/home has no last-played date per track, so this stays empty exactly as on the web.
                    recentArtists = HomeLogic.recentArtists(h.topTracks) { null },
                ),
            )
        }
    }

    private suspend fun loadYears(api: ApiClient) {
        val y = attempt { api.topSongYears() } ?: return
        currentCoroutineContext().ensureActive()
        mutable.update { it.copy(data = it.data.copy(topYears = y.years)) }
    }

    private suspend fun loadRadar(api: ApiClient) {
        try {
            val r = api.radar()
            currentCoroutineContext().ensureActive()
            mutable.update { it.copy(data = it.data.copy(radar = r), radarError = null, radarLoaded = true) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mutable.update { it.copy(radarError = message(e), radarLoaded = true) }
        }
    }

    /** Radar page: fetch again (the web refetches when the page opens). */
    suspend fun reloadRadar(api: ApiClient) {
        val forKey = key
        mutable.update { it.copy(radarLoaded = false) }
        val job = scope.launch { loadRadar(api) }
        job.join()
        if (!job.isCancelled && forKey == key) persist()
    }

    private suspend fun loadPlaylists(api: ApiClient) {
        val p = attempt { api.playlists() } ?: return
        currentCoroutineContext().ensureActive()
        mutable.update { it.copy(data = it.data.copy(playlists = p)) }
    }

    private suspend fun loadAlbums(api: ApiClient) {
        val a = attempt { api.albums() } ?: return
        currentCoroutineContext().ensureActive()
        mutable.update { it.copy(data = it.data.copy(albums = a)) }
    }

    private suspend fun loadArtists(api: ApiClient) {
        val a = attempt { api.artists() } ?: return
        currentCoroutineContext().ensureActive()
        mutable.update { it.copy(data = it.data.copy(artists = a)) }
    }

    /** Local patch after a request: the release shows its new state at once. */
    fun setRequestStatus(albumId: String, status: String) = mutable.update { s ->
        s.copy(data = s.data.copy(radar = s.data.radar.map { if (it.albumId == albumId) it.copy(requestStatus = status) else it }))
    }

    // Keeping

    private fun file(key: String): File? {
        val safe = key.map { if (it.isLetterOrDigit()) it else '_' }.joinToString("")
        return cacheDir?.let { File(it, "$safe.json") }
    }

    private suspend fun persist() {
        val f = key?.let { file(it) } ?: return
        val text = SlopifyJson.encodeToString(HomeSnapshot.serializer(), data)
        withContext(Dispatchers.IO) {
            attempt {
                f.parentFile?.mkdirs()
                val tmp = File(f.parentFile, f.name + ".tmp")
                tmp.writeText(text)
                if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
            }
        }
    }

    companion object {
        /** The app's one store; the Home screen points [cacheDir] at the app cache. */
        val shared: HomeStore by lazy { HomeStore(MainScope()) }

        fun message(e: Throwable): String = when (e) {
            is ApiError.Http -> e.error
            else -> e.message ?: e.toString()
        }

        /** The kept-copy key of the signed-in account: server + user (never a hard-coded name). */
        fun key(account: Account): String? = key(account.saved.value?.main, account.user.value?.id)

        fun key(main: String?, userId: String?): String? = if (main == null || userId == null) null else "$main|$userId"
    }
}
