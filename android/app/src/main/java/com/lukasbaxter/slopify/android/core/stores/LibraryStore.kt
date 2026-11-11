package com.lukasbaxter.slopify.android.core.stores

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.addToPlaylist
import com.lukasbaxter.slopify.android.core.api.createFolder
import com.lukasbaxter.slopify.android.core.api.createPlaylist
import com.lukasbaxter.slopify.android.core.api.deleteFolder
import com.lukasbaxter.slopify.android.core.api.deletePlaylist
import com.lukasbaxter.slopify.android.core.api.followedArtists
import com.lukasbaxter.slopify.android.core.api.libraryLayout
import com.lukasbaxter.slopify.android.core.api.likes
import com.lukasbaxter.slopify.android.core.api.playlists
import com.lukasbaxter.slopify.android.core.api.putLibraryLayout
import com.lukasbaxter.slopify.android.core.api.renameFolder
import com.lukasbaxter.slopify.android.core.api.renamePlaylist
import com.lukasbaxter.slopify.android.core.api.savedAlbums
import com.lukasbaxter.slopify.android.core.api.setFolderCover
import com.lukasbaxter.slopify.android.core.api.setPlaylistCover
import com.lukasbaxter.slopify.android.core.api.tracks
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.Created
import com.lukasbaxter.slopify.android.core.model.LibraryLayout
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.PlaylistDetail
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.Track
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.io.File
import kotlin.coroutines.cancellation.CancellationException

/** What Your Library holds for the signed-in account. */
data class LibraryState(
    val playlists: List<Playlist> = emptyList(),
    val albums: List<Album> = emptyList(),
    val artists: List<Artist> = emptyList(),
    val layout: LibraryLayout? = null,
    /** True until the first fetch of playlists + albums + artists finished. */
    val loading: Boolean = true,
    /** Liked Songs rows by id and when each was liked (`GET /api/likes?full=1`). */
    val likedRows: Map<String, Track> = emptyMap(),
    val likedAt: Map<String, Double> = emptyMap(),
    val likedLoaded: Boolean = false,
    /** Playlist pages last seen, for an instant repaint. */
    val details: Map<String, PlaylistDetail> = emptyMap(),
    /** Bumped when a playlist's songs change elsewhere (Add to playlist): its open page reloads. */
    val revision: Map<String, Int> = emptyMap(),
)

/** Something the person should hear about; the app words it (core builds no UI text). */
sealed interface LibraryEvent {
    data class Added(val name: String) : LibraryEvent
    data class Created(val name: String) : LibraryEvent
    data class Deleted(val name: String) : LibraryEvent
    data object PlaylistUpdated : LibraryEvent
    data class Failed(val action: LibraryAction, val error: String) : LibraryEvent
}

enum class LibraryAction { SaveLibrary, CreatePlaylist, AddToPlaylist, DeletePlaylist, UpdatePlaylist }

/**
 * Your Library's data for every screen that needs it (library list, playlist pages, every
 * "Add to playlist" submenu; ios Features/Library/LibraryStore.swift): own playlists, saved
 * albums, followed artists and the server layout, painted from a local copy first and then
 * refreshed (UI.md 5.2.6, 6.0.15).
 *
 * Layout changes are optimistic (Sidebar.jsx `commit`): shown at once, sent with a fresh
 * `X-Slopify-Rev`, rolled back with a [LibraryEvent.Failed] if the server says no. The folder
 * calls take the next layout from the caller (the Library screen's arrangement maths).
 * AppModel owns the one store and points it at the signed-in account with [attach].
 */
class LibraryStore(
    private val scope: CoroutineScope,
    /** Where the per-user local copy lives; null keeps nothing on disk. */
    private val cacheDir: File? = null,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val mutable = MutableStateFlow(LibraryState())
    val state: StateFlow<LibraryState> = mutable.asStateFlow()

    private val eventFlow = MutableSharedFlow<LibraryEvent>(extraBufferCapacity = 16)
    val events: SharedFlow<LibraryEvent> = eventFlow.asSharedFlow()

    /** "Edit details" from Your Library: the playlist page opens its dialog once shown. */
    val pendingEditDetails = MutableStateFlow<String?>(null)

    /** Tell the account's other devices (App.jsx `sendPrefs({_libraryChanged})`). AppModel sets it. */
    var onLibraryChanged: (() -> Unit)? = null

    val playlists: List<Playlist> get() = mutable.value.playlists

    private var api: ApiClient? = null
    private var userId: String? = null
    /** Bumped per account switch: answers for the previous account are dropped. */
    private var generation = 0
    /** Bumped per layout change (iOS `seq`): stale layout answers are dropped. */
    private var seq = 0
    private var inflight = 0
    private val mine = mutableSetOf<String>()
    private var refreshing = false
    private var saveJob: Job? = null

    /** Point the store at the signed-in account (null = signed out). A different user starts from their own copy. */
    fun attach(api: ApiClient, userId: String?) {
        this.api = api
        if (userId == this.userId) return
        this.userId = userId
        generation += 1; seq += 1; mine.clear()
        saveJob?.cancel()
        mutable.value = LibraryState()
        if (userId != null) restore(userId)
    }

    // Loading

    suspend fun refresh() {
        val api = api ?: return
        if (refreshing) return
        refreshing = true
        try {
            val at = generation
            val (pl, al, ar) = coroutineScope {
                val p = async { attempt { api.playlists() } }
                val a = async { attempt { api.savedAlbums() } }
                val r = async { attempt { api.followedArtists() } }
                Triple(p.await(), a.await(), r.await())
            }
            if (at != generation) return
            mutable.update { it.copy(playlists = pl ?: it.playlists, albums = al ?: it.albums, artists = ar ?: it.artists, loading = false) }
            loadLayout()
            persist()
        } finally {
            refreshing = false
        }
    }

    suspend fun refreshPlaylists() {
        val api = api ?: return
        val at = generation
        val pl = attempt { api.playlists() } ?: return
        if (at != generation) return
        mutable.update { it.copy(playlists = pl) }
        persist()
    }

    suspend fun refreshAlbums() {
        val api = api ?: return
        val at = generation
        val al = attempt { api.savedAlbums() } ?: return
        if (at != generation) return
        mutable.update { it.copy(albums = al) }
        persist()
    }

    suspend fun refreshArtists() {
        val api = api ?: return
        val at = generation
        val ar = attempt { api.followedArtists() } ?: return
        if (at != generation) return
        mutable.update { it.copy(artists = ar) }
        persist()
    }

    /** Re-read the layout unless one of our own changes is on its way (it would undo it). */
    fun loadLayout() {
        val api = api ?: return
        val at = seq
        scope.launch {
            val l = attempt { api.libraryLayout() } ?: return@launch
            if (inflight == 0 && at == seq) setLayout(l)
        }
    }

    /**
     * Playlists / layout changed on another device (`AppModel.libraryChanged`). `rev` is the
     * patch's `_libraryLayout`: our own change coming back is skipped.
     */
    fun remoteChange(rev: String?) {
        if (rev != null && rev in mine) return
        scope.launch { refresh() }
    }

    private fun setLayout(l: LibraryLayout?) {
        mutable.update { it.copy(layout = l) }
        persist()
    }

    /** Show `next` now; `call(rev)` makes the server change and may answer with its layout. */
    fun commit(next: LibraryLayout, call: suspend (rev: String) -> LibraryLayout?) {
        val api = api ?: return
        val prev = mutable.value.layout
        seq += 1
        val my = seq
        val rev = newRev(now())
        mine += rev
        setLayout(next)
        inflight += 1
        scope.launch {
            try {
                val res = call(rev)
                if (my != seq) return@launch
                if (res != null) setLayout(res)
                else attempt { api.libraryLayout() }?.let { if (my == seq) setLayout(it) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (my == seq) setLayout(prev)
                eventFlow.tryEmit(LibraryEvent.Failed(LibraryAction.SaveLibrary, errorText(e)))
            } finally {
                inflight -= 1
            }
        }
    }

    // Arrangement (the next layout comes from the Library screen's maths)

    fun saveLayout(next: LibraryLayout, order: List<String>, folders: Map<String, List<String>>) {
        val api = api ?: return
        commit(next) { rev -> api.putLibraryLayout(order, folders, rev) }
    }

    fun createFolder(name: String, next: LibraryLayout) {
        val api = api ?: return
        commit(next) { rev -> api.createFolder(name, rev); null }
    }

    fun renameFolder(id: String, name: String, next: LibraryLayout) {
        val api = api ?: return
        commit(next) { rev -> api.renameFolder(id, name, rev); null }
    }

    fun deleteFolder(id: String, next: LibraryLayout) {
        val api = api ?: return
        commit(next) { rev -> api.deleteFolder(id, rev); null }
    }

    fun setFolderCover(id: String, jpeg: ByteArray) {
        val api = api ?: return
        val current = mutable.value.layout ?: return
        commit(current) { rev -> api.setFolderCover(id, jpeg, rev); null }
    }

    // Playlists

    /** New playlist, optionally with its first song. Null when the server said no. */
    suspend fun createPlaylist(name: String, with: Track? = null): Created? {
        val api = api ?: return null
        return try {
            val c = api.createPlaylist(name, with?.let { listOf(it.id) } ?: emptyList())
            refreshPlaylists()
            onLibraryChanged?.invoke()
            eventFlow.tryEmit(if (with != null) LibraryEvent.Added(name) else LibraryEvent.Created(name))
            c
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            eventFlow.tryEmit(LibraryEvent.Failed(LibraryAction.CreatePlaylist, errorText(e)))
            null
        }
    }

    /** Track menu "Add to playlist": one request, one event. */
    suspend fun add(trackIds: List<String>, to: Playlist) {
        val api = api ?: return
        if (trackIds.isEmpty()) return
        try {
            api.addToPlaylist(to.id, trackIds)
            eventFlow.tryEmit(LibraryEvent.Added(to.name))
            mutable.update { it.copy(revision = it.revision + (to.id to ((it.revision[to.id] ?: 0) + 1))) }
            refreshPlaylists()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            eventFlow.tryEmit(LibraryEvent.Failed(LibraryAction.AddToPlaylist, errorText(e)))
        }
    }

    /** True when deleted. */
    suspend fun deletePlaylist(p: Playlist): Boolean {
        val api = api ?: return false
        return try {
            api.deletePlaylist(p.id)
            mutable.update { it.copy(details = it.details - p.id) }
            refreshPlaylists()
            onLibraryChanged?.invoke()
            eventFlow.tryEmit(LibraryEvent.Deleted(p.name))
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            eventFlow.tryEmit(LibraryEvent.Failed(LibraryAction.DeletePlaylist, errorText(e)))
            false
        }
    }

    /** Edit details: rename and/or a new cover. True when saved. */
    suspend fun edit(p: Playlist, name: String, jpeg: ByteArray?): Boolean {
        val api = api ?: return false
        return try {
            if (name != p.name) api.renamePlaylist(p.id, name)
            if (jpeg != null) api.setPlaylistCover(p.id, jpeg)
            refreshPlaylists()
            eventFlow.tryEmit(LibraryEvent.PlaylistUpdated)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            eventFlow.tryEmit(LibraryEvent.Failed(LibraryAction.UpdatePlaylist, errorText(e)))
            false
        }
    }

    fun remember(d: PlaylistDetail) = mutable.update { it.copy(details = it.details + (d.playlist.id to d)) }

    // Liked Songs

    suspend fun loadLiked() {
        val api = api ?: return
        val at = generation
        val m = attempt { api.likes(full = true) } ?: return
        if (at != generation) return
        mutable.update { it.copy(likedRows = m.items.orEmpty().associateBy { t -> t.id }, likedAt = m.at, likedLoaded = true) }
        persist()
    }

    /** Liked ids the store has no row for yet (liked on another device): fetch them. */
    suspend fun fillLiked(ids: List<String>) {
        val api = api ?: return
        if (ids.isEmpty()) return
        val at = generation
        val more = attempt { api.tracks(ids) } ?: return
        if (at != generation) return
        mutable.update { it.copy(likedRows = it.likedRows + more.associateBy { t -> t.id }) }
        persist()
    }

    // Local copy

    @Serializable
    internal data class Snapshot(
        val playlists: List<Playlist> = emptyList(),
        val albums: List<Album> = emptyList(),
        val artists: List<Artist> = emptyList(),
        val layout: LibraryLayout? = null,
        val liked: List<Track> = emptyList(),
        val likedAt: Map<String, Double> = emptyMap(),
    )

    private fun file(userId: String): File? {
        val dir = cacheDir ?: return null
        val safe = userId.filter { it.isLetterOrDigit() || it == '-' || it == '_' }
        return File(dir, "library-$safe.json")
    }

    private fun restore(userId: String) {
        val f = file(userId) ?: return
        val at = generation
        scope.launch {
            val s = withContext(io) { attempt { SlopifyJson.decodeFromString(Snapshot.serializer(), f.readText()) } } ?: return@launch
            // Only into a store that has not been filled from the server meanwhile.
            if (at != generation) return@launch
            mutable.update {
                if (!it.loading) it else it.copy(
                    playlists = s.playlists, albums = s.albums, artists = s.artists, layout = it.layout ?: s.layout,
                    likedRows = if (it.likedLoaded) it.likedRows else s.liked.associateBy { t -> t.id },
                    likedAt = if (it.likedLoaded) it.likedAt else s.likedAt,
                    likedLoaded = it.likedLoaded || s.likedAt.isNotEmpty(),
                )
            }
        }
    }

    private fun persist() {
        val f = file(userId ?: return) ?: return
        saveJob?.cancel()
        val st = mutable.value
        val s = Snapshot(st.playlists, st.albums, st.artists, st.layout, st.likedRows.values.toList(), st.likedAt)
        saveJob = scope.launch {
            delay(SAVE_DELAY_MS)
            withContext(io) {
                attempt {
                    f.parentFile?.mkdirs()
                    val tmp = File(f.parentFile, f.name + ".tmp")
                    tmp.writeText(SlopifyJson.encodeToString(Snapshot.serializer(), s))
                    if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
                }
            }
        }
    }

    companion object {
        internal const val SAVE_DELAY_MS = 300L
        private const val REV_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"

        /** `r<time base36><random>`, like the web's `newRev`. */
        fun newRev(nowMs: Long = System.currentTimeMillis()): String =
            "r" + nowMs.toString(36) + (1..6).map { REV_CHARS.random() }.joinToString("")

        private fun errorText(e: Exception): String = e.message ?: e.toString()
    }
}
