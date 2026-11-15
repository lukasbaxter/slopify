package com.lukasbaxter.slopify.android.core.stores

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.aiStatus
import com.lukasbaxter.slopify.android.core.api.generatePlaylist
import com.lukasbaxter.slopify.android.core.api.job
import com.lukasbaxter.slopify.android.core.model.GenerateInfo
import com.lukasbaxter.slopify.android.core.model.GenerateResult
import com.lukasbaxter.slopify.android.core.model.ServerJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/** Regenerate: fill this playlist again; `prompt` is what was asked last time. */
data class GenerateRegenerate(val playlistId: String, val prompt: String)

/** What `GET /api/ai/status` said; the dialog words it. */
sealed interface GenerateAvailability {
    /** Not answered yet: Generate stays disabled. */
    data object Loading : GenerateAvailability
    data object Ok : GenerateAvailability
    /** The server cannot generate; `reason` is its own text, null = the stock sentence. */
    data class Off(val reason: String?) : GenerateAvailability
    /** "Could not reach the server." */
    data object Unreachable : GenerateAvailability
}

/** A running job as the dialog shows it. `gotMs`: when this update arrived (our clock), for the countdown. */
data class GenerateBusy(val step: String? = null, val progress: Double? = null, val info: GenerateInfo? = null, val gotMs: Long = 0)

/** One opening of the Generate dialog (GeneratePlaylist.jsx's component state). */
class GenerateSession(val regenerate: GenerateRegenerate? = null) {
    val id: String = UUID.randomUUID().toString()
    val availability = MutableStateFlow<GenerateAvailability>(GenerateAvailability.Loading)
    /** Non-null while a job runs. */
    val busy = MutableStateFlow<GenerateBusy?>(null)
    val error = MutableStateFlow<String?>(null)
    /** False after Hide / Cancel: the job is still followed, its end is announced instead of shown. */
    @Volatile var open: Boolean = true
        internal set
}

/** What a followed job ended with (App.jsx `onDone`); the app refreshes, opens and toasts. */
sealed interface GenerateEvent {
    /** `hidden`: the dialog was closed before the job finished. */
    data class Done(val result: GenerateResult, val hidden: Boolean) : GenerateEvent
    /** Failed after Hide ("Could not generate the playlist: {error}"). */
    data class Failed(val error: String) : GenerateEvent
}

/**
 * "Generated playlist (AI)" (GeneratePlaylist.jsx, App.jsx:1785-1805): the dialog's state and
 * the server job behind it. The job is followed in the app's scope, so Hide leaves it running
 * and the playlist still arrives in Your Library.
 */
class GeneratePlaylistStore(
    private val scope: CoroutineScope,
    /** §18.4: poll every 1 s while queued or running. */
    var interval: Duration = 1.seconds,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val sessionFlow = MutableStateFlow<GenerateSession?>(null)
    /** The open dialog, or null. */
    val session: StateFlow<GenerateSession?> = sessionFlow.asStateFlow()

    private val eventFlow = MutableSharedFlow<GenerateEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<GenerateEvent> = eventFlow.asSharedFlow()

    /** Open the dialog (for `regenerate`: on that playlist, with its old request) and ask the server whether it can. */
    fun open(api: ApiClient, regenerate: GenerateRegenerate? = null): GenerateSession {
        sessionFlow.value?.open = false
        val s = GenerateSession(regenerate)
        sessionFlow.value = s
        scope.launch { s.availability.value = availability(api) }
        return s
    }

    /** Cancel, or Hide while a job runs: the dialog goes, the job is still followed. */
    fun close() {
        sessionFlow.value?.open = false
        sessionFlow.value = null
    }

    /** Signed out: nothing of the last account stays on screen. A job still running ends unannounced. */
    fun reset() {
        generation += 1
        close()
    }

    private var generation = 0

    /** Generate / Regenerate: start the job and follow it to its end. */
    fun submit(s: GenerateSession, prompt: String, api: ApiClient) {
        val p = prompt.trim()
        if (p.isEmpty() || s.busy.value != null) return
        s.error.value = null
        s.busy.value = GenerateBusy(gotMs = now())
        val at = generation
        scope.launch {
            try {
                val job = api.generatePlaylist(p, s.regenerate?.playlistId)
                val result = waitJob(api, job, interval) { j ->
                    if (s.open) s.busy.value = GenerateBusy(j.step, j.progress, GenerateInfo.read(j.info), now())
                }
                val r = GenerateResult.read(result) ?: throw IllegalStateException("failed")
                if (at != generation) return@launch
                val hidden = !s.open
                if (sessionFlow.value === s) close()
                eventFlow.tryEmit(GenerateEvent.Done(r, hidden))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (at != generation) return@launch
                val msg = e.message ?: e.toString()
                if (!s.open) { eventFlow.tryEmit(GenerateEvent.Failed(msg)); return@launch }
                s.error.value = msg
                s.busy.value = null
            }
        }
    }

    companion object {
        /** Any failure to ask is "could not reach the server" (GeneratePlaylist.jsx). */
        suspend fun availability(api: ApiClient): GenerateAvailability = try {
            val st = api.aiStatus()
            if (st.ok) GenerateAvailability.Ok else GenerateAvailability.Off(st.reason?.takeIf { it.isNotEmpty() })
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            GenerateAvailability.Unreachable
        }

        /**
         * Poll a job until it ends (web `waitJob`); `onStep` sees every state on the way, the
         * last one included. Returns its `result`; a job that ended in `error` throws its text.
         */
        suspend fun waitJob(api: ApiClient, job: ServerJob, interval: Duration, onStep: (ServerJob) -> Unit = {}): JsonElement? {
            var j = job
            while (j.active) {
                onStep(j)
                delay(interval)
                j = api.job(j.id)
            }
            onStep(j)
            if (j.state == "error") throw IllegalStateException(j.error?.takeIf { it.isNotEmpty() } ?: "failed")
            return j.result
        }
    }
}
