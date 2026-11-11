package com.lukasbaxter.slopify.android.core.stores

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.lyricJobs
import com.lukasbaxter.slopify.android.core.api.myLyricJobs
import com.lukasbaxter.slopify.android.core.api.requestLyricSync
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.auth.AccountState
import com.lukasbaxter.slopify.android.core.model.LyricJob
import com.lukasbaxter.slopify.android.core.model.Track
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/** What a job is doing (web `jobLabel`); the UI words it from the web locales. */
sealed interface LyricJobStage {
    /** "Waiting · {n} ahead". */
    data class Waiting(val ahead: Int) : LyricJobStage
    /** "Starting". */
    data object Starting : LyricJobStage
    /** The server's own step text. */
    data class Step(val text: String) : LyricJobStage
}

/** LyricSyncStatus.jsx: the running job, else the first; "· n more". `title` null = "This song". */
data class LyricSyncPill(val title: String?, val stage: LyricJobStage, val more: Int)

/** Toasts the store asks for. Titles null = "This song". */
sealed interface LyricJobEvent {
    /** "Already syncing \"{name}\"". */
    data class AlreadySyncing(val title: String) : LyricJobEvent
    /** "Couldn't sync lyrics: {error}". */
    data class StartFailed(val error: String) : LyricJobEvent
    /** "{title}: {result}"; `result` null = "Couldn't sync" when `failed`, else "Done". */
    data class Finished(val trackId: String, val title: String?, val result: String?, val failed: Boolean) : LyricJobEvent
}

/**
 * Lyric sync jobs (web api/lyricsync.js), one store for the whole app: the track menus'
 * "Syncing Lyrics..." row, the lyrics tab and the lyric-sync pill all read it. Start a job,
 * follow every unfinished one every 2 s, report the outcome on [events], bump
 * [revision] so an open lyrics view reloads, and pick up this account's unfinished jobs
 * after sign-in (`?mine=1`).
 */
class LyricJobStore(private val scope: CoroutineScope, var interval: Duration = 2.seconds) {
    private val jobsFlow = MutableStateFlow<Map<String, LyricJob>>(emptyMap())
    /** Insertion order (the web's Map order), for the pill. */
    private val orderFlow = MutableStateFlow<List<String>>(emptyList())
    private val revisionFlow = MutableStateFlow<Map<String, Int>>(emptyMap())
    private val pillFlow = MutableStateFlow<LyricSyncPill?>(null)
    private val eventsFlow = MutableSharedFlow<LyricJobEvent>(extraBufferCapacity = 32)

    val jobs: StateFlow<Map<String, LyricJob>> = jobsFlow.asStateFlow()
    val order: StateFlow<List<String>> = orderFlow.asStateFlow()
    /** Bumped when a job for that track finishes. */
    val revision: StateFlow<Map<String, Int>> = revisionFlow.asStateFlow()
    val pill: StateFlow<LyricSyncPill?> = pillFlow.asStateFlow()
    val events: SharedFlow<LyricJobEvent> = eventsFlow.asSharedFlow()

    private var api: ApiClient? = null
    private var poll: Job? = null
    private var follower: Job? = null

    fun job(trackId: String?): LyricJob? = trackId?.let { jobsFlow.value[it] }
    fun isSyncing(trackId: String?): Boolean = job(trackId) != null

    // Sign-in

    /** Follow the account: on sign-in resume its unfinished jobs, on sign-out forget them. */
    fun attach(account: Account) {
        follower?.cancel()
        follower = scope.launch {
            account.state.map { it == AccountState.SignedIn }.distinctUntilChanged().collect { signedIn ->
                if (signedIn) resume(account.api) else reset()
            }
        }
    }

    /** `resumeLyricJobs`: jobs this account started before a relaunch. */
    suspend fun resume(api: ApiClient) {
        this.api = api
        val list = attempt { api.myLyricJobs() } ?: return
        absorb(list)
        follow()
    }

    fun reset() {
        poll?.cancel(); poll = null; api = null
        jobsFlow.value = emptyMap(); orderFlow.value = emptyList()
        updatePill()
    }

    // Start

    suspend fun sync(track: Track, api: ApiClient) = sync(track.id, track.title, api)

    suspend fun sync(trackId: String, title: String, api: ApiClient) {
        this.api = api
        try {
            var j = api.requestLyricSync(trackId)
            val already = j.already == true
            if (j.title.isNullOrEmpty()) j = j.copy(title = title)
            put(j)
            if (already) eventsFlow.tryEmit(LyricJobEvent.AlreadySyncing(title))
            follow()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            eventsFlow.tryEmit(LyricJobEvent.StartFailed(e.message ?: e.toString()))
        }
    }

    // Follow

    /** Merge a poll result (`absorb`): active jobs update, finished ones report and leave. */
    fun absorb(list: List<LyricJob>) {
        for (j0 in list) {
            val before = jobsFlow.value[j0.trackId]
            val title = j0.title?.takeIf { it.isNotEmpty() } ?: before?.title
            val j = j0.copy(title = title)
            if (isActive(j)) { put(j); continue }
            if (before == null) continue
            jobsFlow.value = jobsFlow.value - j.trackId
            orderFlow.value = orderFlow.value - j.trackId
            eventsFlow.tryEmit(LyricJobEvent.Finished(j.trackId, title, j.result, failed = j.state == "failed"))
            revisionFlow.value = revisionFlow.value + (j.trackId to ((revisionFlow.value[j.trackId] ?: 0) + 1))
        }
        updatePill()
    }

    private fun put(j: LyricJob) {
        if (j.trackId !in jobsFlow.value) orderFlow.value = orderFlow.value + j.trackId
        jobsFlow.value = jobsFlow.value + (j.trackId to j)
        updatePill()
    }

    private fun updatePill() {
        val list = orderFlow.value.mapNotNull { jobsFlow.value[it] }
        val j = list.firstOrNull { it.state == "running" } ?: list.firstOrNull()
        pillFlow.value = j?.let { LyricSyncPill(it.title, stage(it), list.size - 1) }
    }

    private fun follow() {
        if (poll != null || orderFlow.value.isEmpty()) return
        poll = scope.launch {
            while (isActive) {
                delay(interval)
                val pending = orderFlow.value
                if (pending.isEmpty()) { poll = null; return@launch }
                val api = api ?: continue
                attempt { api.lyricJobs(pending) }?.let { absorb(it) }
            }
        }
    }

    companion object {
        fun isActive(j: LyricJob): Boolean = j.state == "queued" || j.state == "running"

        /** `jobLabel`. */
        fun stage(j: LyricJob): LyricJobStage {
            if (j.state == "queued") {
                val n = j.ahead
                return if (n != null && n > 0) LyricJobStage.Waiting(n) else LyricJobStage.Starting
            }
            return j.step?.let { LyricJobStage.Step(it) } ?: LyricJobStage.Starting
        }
    }
}
