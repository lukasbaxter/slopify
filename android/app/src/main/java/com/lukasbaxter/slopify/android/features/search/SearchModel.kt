package com.lukasbaxter.slopify.android.features.search

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.api.playlists
import com.lukasbaxter.slopify.android.core.api.requestAlbum
import com.lukasbaxter.slopify.android.core.api.search
import com.lukasbaxter.slopify.android.core.api.searchEverywhere
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.EverywhereResults
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.SearchResults
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.stores.Connectivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/** The network behind [SearchModel], so tests can drive it. */
class SearchBackend(
    val search: suspend (String) -> SearchResults,
    val playlists: suspend () -> List<Playlist>,
    val everywhere: suspend (String) -> EverywhereResults,
    /** POST /api/requests; returns the server's `status`. */
    val request: suspend (String) -> String?,
    /** The app is offline: search the downloaded songs instead (`searchOffline`). */
    val offline: () -> Boolean = { false },
    val searchOffline: (String) -> List<Track> = { emptyList() },
) {
    fun copy(request: suspend (String) -> String?) = SearchBackend(search, playlists, everywhere, request, offline, searchOffline)

    companion object {
        fun live(api: ApiClient, connectivity: Connectivity) = SearchBackend(
            search = { api.search(it, limit = 10) },
            playlists = { api.playlists() },
            everywhere = { api.searchEverywhere(it) },
            request = { api.requestAlbum(it) },
            offline = { connectivity.offline.value },
            // TODO(lead): the offline store's `search(q)` over downloaded songs once it is ported.
            searchOffline = { emptyList() },
        )
    }
}

sealed interface SearchEverywhere {
    data object Waiting : SearchEverywhere
    data object Failed : SearchEverywhere
    data class Loaded(val results: EverywhereResults) : SearchEverywhere
}

data class SearchState(
    val query: String = "",
    /** The field was tapped; only Cancel or leaving the tab clears it (blur does not). */
    val focused: Boolean = false,
    val type: SearchType = SearchType.All,
    val page: SearchPage? = null,
    val error: String? = null,
    val everywhere: SearchEverywhere? = null,
    /** This client's own request states by release id (`queued`, `exists`, `error`). */
    val requesting: Map<String, String> = emptyMap(),
) {
    val trimmed: String get() = query.trim()
    val focusMode: Boolean get() = focused || trimmed.isNotEmpty()
    /** Chips show once a result object exists, or in Everywhere mode with a query. */
    val showsChips: Boolean get() = page != null || (type == SearchType.Everywhere && trimmed.isNotEmpty())
    /** The flat phone list; null before the first result and in Everywhere mode. */
    val rows: List<SearchItem>? get() = page?.takeIf { type != SearchType.Everywhere }?.let { SearchLogic.phoneRows(it, type) }

    fun stateOf(r: Release): String? = SearchRequestState.state(r.requestStatus, r.albumId?.let { requesting[it] })

    /** Anything not in the library still on its way (`gPending`). */
    val hasPending: Boolean
        get() {
            val loaded = everywhere as? SearchEverywhere.Loaded ?: return false
            return loaded.results.albums.any { it.inLibrary == null && stateOf(it)?.let { s -> s in SearchRequestState.pending } == true }
        }
}

/**
 * State of the Search tab (UI.md 6.2.1-6.2.8): the query with its 60 ms debounce, the type
 * chip, focus mode, the result page, the error banner and the "Everywhere" catalogue search
 * with its request polling. Runs on the caller's scope; `now` is the clock (virtual in tests).
 */
class SearchModel(
    private val scope: CoroutineScope,
    var backend: SearchBackend,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val mutable = MutableStateFlow(SearchState())
    val state: StateFlow<SearchState> = mutable.asStateFlow()
    private val s: SearchState get() = mutable.value

    /** App in the background: polls skip their turn. */
    var hidden = false

    var searchDelayMs = 60L
    var everywhereDelayMs = 300L
    var pollIntervalMs = 4_000L
    var pollLimitMs = 30 * 60_000L

    private var searchJob: Job? = null
    private var everywhereJob: Job? = null
    private var pollJob: Job? = null
    private var pollToken = Any()

    // input

    fun setQuery(q: String) {
        if (q == s.query) return
        mutable.update { it.copy(query = q) }
        runSearch()
        runEverywhere()
    }

    fun setType(t: SearchType) {
        if (t == s.type) return
        mutable.update { it.copy(type = t) }
        runEverywhere()
    }

    fun setFocused(f: Boolean) = mutable.update { it.copy(focused = f) }

    /** Cancel: clear the query and leave focus mode. */
    fun cancel() {
        setFocused(false)
        setQuery("")
    }

    /** Leaving the tab ends focus mode (the query stays). */
    fun leftTab() = mutable.update { it.copy(focused = false, error = null) }

    fun clearError() = mutable.update { it.copy(error = null) }

    // library search

    private fun runSearch() {
        searchJob?.cancel()
        val q = s.trimmed
        if (q.isEmpty()) { mutable.update { it.copy(page = null) }; return }
        val b = backend
        searchJob = scope.launch {
            delay(searchDelayMs)
            if (b.offline()) { showOffline(q); return@launch }
            try {
                val r = b.search(q)
                // The web filters the playlists list client-side; a failure there is not an error.
                val pls = attempt { b.playlists() } ?: emptyList()
                ensureActive()
                if (s.trimmed != q) return@launch
                mutable.update { it.copy(page = SearchPage(q, r, pls), error = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (s.trimmed != q) return@launch
                if (e is ApiError.Offline) { showOffline(q); return@launch }
                if (reportable(e)) mutable.update { it.copy(error = message(e)) }
            }
        }
    }

    /** Songs only, from what is downloaded (UI.md 5.8). */
    private fun showOffline(q: String) {
        if (s.trimmed != q) return
        val page = SearchPage(q, SearchResults(backend.searchOffline(q), emptyList(), emptyList()), emptyList())
        mutable.update { it.copy(page = page, error = null) }
    }

    // everywhere

    private fun runEverywhere() {
        everywhereJob?.cancel()
        pollJob?.cancel(); pollJob = null
        val q = s.trimmed
        if (s.type != SearchType.Everywhere || q.isEmpty()) { mutable.update { it.copy(everywhere = null) }; return }
        if (s.everywhere == null) mutable.update { it.copy(everywhere = SearchEverywhere.Waiting) }
        val b = backend
        everywhereJob = scope.launch {
            delay(everywhereDelayMs)
            try {
                val r = b.everywhere(q)
                ensureActive()
                if (s.trimmed != q) return@launch
                mutable.update { it.copy(everywhere = SearchEverywhere.Loaded(r)) }
                pollIfPending()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (s.trimmed != q) return@launch
                // Any failure (a timeout too) ends the wait with the quiet line; the banner is for real errors.
                mutable.update { it.copy(everywhere = SearchEverywhere.Failed, error = if (reportable(e)) message(e) else it.error) }
            }
        }
    }

    fun stateOf(r: Release): String? = s.stateOf(r)

    val hasPending: Boolean get() = s.hasPending

    suspend fun request(r: Release) {
        val id = r.albumId ?: return
        mutable.update { it.copy(requesting = it.requesting + (id to "queued")) }
        pollIfPending()
        try {
            val st = backend.request(id)
            mutable.update { it.copy(requesting = it.requesting + (id to (st ?: "queued"))) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mutable.update { it.copy(requesting = it.requesting + (id to "error"), error = if (reportable(e)) message(e) else it.error) }
        }
    }

    /** The UI's tap: runs on the model's scope so leaving the page does not drop the request. */
    fun requestLater(r: Release) { scope.launch { request(r) } }

    /**
     * While a requested release is on its way, search again every 4 s so it turns playable when
     * the library has it. Skips while hidden, stops after 30 min or when nothing is pending.
     */
    private fun pollIfPending() {
        if (pollJob != null || !s.hasPending) return
        val q = s.trimmed
        val b = backend
        val started = now()
        val token = Any()
        pollToken = token
        pollJob = scope.launch {
            try {
                while (isActive) {
                    delay(pollIntervalMs)
                    if (!s.hasPending || s.trimmed != q) break
                    if (now() - started > pollLimitMs) break
                    if (hidden) continue
                    val r = attempt { b.everywhere(q) }
                    if (r != null && s.trimmed == q && s.type == SearchType.Everywhere) {
                        mutable.update { it.copy(everywhere = SearchEverywhere.Loaded(r)) }
                    }
                }
            } finally {
                if (pollToken === token) pollJob = null
            }
        }
    }

    companion object {
        /** Aborts and the offline state never show the banner. */
        fun reportable(e: Throwable): Boolean = e !is CancellationException && e !is ApiError.Offline

        fun message(e: Throwable): String = e.message ?: e.toString()
    }
}
