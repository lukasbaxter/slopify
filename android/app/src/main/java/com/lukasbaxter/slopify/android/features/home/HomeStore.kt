package com.lukasbaxter.slopify.android.features.home

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.api.albums
import com.lukasbaxter.slopify.android.core.api.artists
import com.lukasbaxter.slopify.android.core.api.dailyMixes
import com.lukasbaxter.slopify.android.core.api.home
import com.lukasbaxter.slopify.android.core.api.homeMixes
import com.lukasbaxter.slopify.android.core.api.homeStations
import com.lukasbaxter.slopify.android.core.api.playlists
import com.lukasbaxter.slopify.android.core.api.radar
import com.lukasbaxter.slopify.android.core.api.topSongYears
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.HomePick
import com.lukasbaxter.slopify.android.core.model.HomeStation
import com.lukasbaxter.slopify.android.core.model.MixArtist
import com.lukasbaxter.slopify.android.core.model.MixCover
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.TopMix
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
    /** Home's shortcuts, as the server lists them. Empty in older kept copies. */
    val picks: List<HomePick> = emptyList(),
    val topArtists: List<HomeLogic.RankedArtist> = emptyList(),
    val recentArtists: List<HomeLogic.RankedArtist> = emptyList(),
    val topYears: List<TopSongYears.Year> = emptyList(),
    /** The full radar list (Home shows the first 16, the Radar page all of them). */
    val radar: List<Release> = emptyList(),
    val playlists: List<Playlist> = emptyList(),
    val albums: List<Album> = emptyList(),
    val artists: List<Artist> = emptyList(),
    /** Who is in each Daily Mix today, by seed artist (API.md §14.3): the tiles' and pages' subtitles. */
    val mixArtists: Map<String, List<MixArtist>> = emptyMap(),
    /** Today's cover of each seed's Daily Mix, by seed artist id. */
    val mixCovers: Map<String, MixCover> = emptyMap(),
    /** Today's Daily Mix tile as the server drew it (`art_…` image id), by seed artist id. Empty on older servers. */
    val mixArt: Map<String, String> = emptyMap(),
    /** Recommended Stations: artists' radios, after the Daily Mix seeds. */
    val stations: List<HomeStation> = emptyList(),
    /** Your top mixes: a mix of each genre the listener plays most. */
    val topMixes: List<TopMix> = emptyList(),
) {
    val shortcuts: List<HomeLogic.Shortcut> get() = HomeLogic.shortcuts(picks, playlists, albums)
    val mixSeeds: List<HomeLogic.RankedArtist> get() = HomeLogic.mixSeeds(topArtists, artists)
    /** Home shows only what is in the library (the server fetches the rest and it shows once it lands). */
    val radarShelf: List<Release> get() = radar.filter { it.inLibrary != null }.take(16)

    fun sections(filter: HomeLogic.Filter): List<HomeLogic.Section> = HomeLogic.sections(
        filter,
        HomeLogic.Counts(
            mixes = mixSeeds.size, stations = stations.size, topMixes = topMixes.size, years = topYears.size,
            recentArtists = recentArtists.size, radar = radarShelf.size, topArtists = topArtists.size,
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
    /** The song [reloadHome] last ran for. */
    private var reloadedFor: String? = null

    /** Switch to this account's kept copy (no-op when already on it). */
    fun use(key: String?) {
        if (key == this.key) return
        inflight?.cancel(); inflight = null
        this.key = key
        loadedAt = null
        reloadedFor = null
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
            launch { loadTopMixes(api) }
            launch { loadYears(api) }
            launch { loadRadar(api) }
            launch { loadPlaylists(api) }
            launch { loadAlbums(api) }
            launch { loadArtists(api) }
        }
        inflight = job
        job.join()
        // Today's Daily Mixes and the stations after them, once the seeds are known (they come from the lists above).
        val mixes = scope.launch {
            launch { loadMixes(api) }
            launch { loadStations(api) }
        }
        mixes.join()
        if (inflight === job) inflight = null
        if (job.isCancelled || mixes.isCancelled || forKey != key) return
        loadedAt = now()
        persist()
    }

    /**
     * After a play is logged: the shortcuts (what was picked last) and the play-ranked lists
     * again. One request, at most once per song: asking again for the same `trackId` does nothing.
     */
    suspend fun reloadHome(api: ApiClient, trackId: String) {
        if (trackId == reloadedFor) return
        reloadedFor = trackId
        val forKey = key
        val job = scope.launch { loadHome(api) }
        job.join()
        if (!job.isCancelled && forKey == key) persist()
    }

    private suspend fun loadHome(api: ApiClient) {
        val h = attempt { api.home() } ?: return
        currentCoroutineContext().ensureActive()
        mutable.update {
            it.copy(
                data = it.data.copy(
                    picks = h.recents.orEmpty(),
                    topArtists = HomeLogic.rankTopArtists(h.topTracks),
                    // /api/home has no last-played date per track, so this stays empty exactly as on the web.
                    recentArtists = HomeLogic.recentArtists(h.topTracks) { null },
                ),
            )
        }
    }

    /** The fresh answer replaces the kept one, so a new day's tiles never show yesterday's mix. */
    private suspend fun loadMixes(api: ApiClient) {
        val ids = data.mixSeeds.map { it.id }
        if (ids.isEmpty()) return
        val got = attempt { api.dailyMixes(ids) } ?: return
        currentCoroutineContext().ensureActive()
        mutable.update {
            it.copy(
                data = it.data.copy(
                    mixArtists = got.associate { m -> m.artistId to m.artists },
                    mixCovers = got.mapNotNull { m -> m.cover?.let { m.artistId to it } }.toMap(),
                    mixArt = got.mapNotNull { m -> m.art?.takeIf { a -> a.isNotEmpty() }?.let { m.artistId to it } }.toMap(),
                ),
            )
        }
    }

    /** Recommended Stations: the artists already seeding a Daily Mix are skipped. */
    private suspend fun loadStations(api: ApiClient) {
        val ids = data.mixSeeds.map { it.id }
        if (ids.isEmpty()) return
        val got = attempt { api.homeStations(ids) } ?: return
        currentCoroutineContext().ensureActive()
        mutable.update { it.copy(data = it.data.copy(stations = got)) }
    }

    private suspend fun loadTopMixes(api: ApiClient) {
        val got = attempt { api.homeMixes() } ?: return
        currentCoroutineContext().ensureActive()
        mutable.update { it.copy(data = it.data.copy(topMixes = got)) }
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
