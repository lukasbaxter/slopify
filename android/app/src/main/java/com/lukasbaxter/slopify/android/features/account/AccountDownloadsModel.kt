package com.lukasbaxter.slopify.android.features.account

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.album
import com.lukasbaxter.slopify.android.core.api.downloads
import com.lukasbaxter.slopify.android.core.api.retryDownload
import com.lukasbaxter.slopify.android.core.model.DownloadScope
import com.lukasbaxter.slopify.android.core.model.DownloadsPage
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Where the Downloads page gets its data. The app uses the server; tests use a fake. */
internal interface AccountDownloadsSource {
    suspend fun downloads(scope: DownloadScope): DownloadsPage
    suspend fun retry(id: Int)
    /** The tracks of a library album (the Play button). */
    suspend fun albumTracks(albumId: String): List<Track>
}

internal class AccountServerDownloadsSource(private val api: ApiClient) : AccountDownloadsSource {
    override suspend fun downloads(scope: DownloadScope) = api.downloads(scope)
    override suspend fun retry(id: Int) = api.retryDownload(id)
    override suspend fun albumTracks(albumId: String) = api.album(albumId).tracks
}

/**
 * State of the Downloads page: one scope at a time, the last answer per scope kept and shown at
 * once, a slow answer never stacked behind the next poll, and answers for a scope you left dropped.
 * Runs on the caller's (main) thread.
 */
internal class AccountDownloadsModel(val source: AccountDownloadsSource) {
    data class State(
        val scope: DownloadScope = DownloadScope.Mine,
        val data: DownloadsPage? = null,
        val error: String? = null,
        val retrying: Int? = null,
    )

    private val mutable = MutableStateFlow(State(data = kept[DownloadScope.Mine]))
    val state: StateFlow<State> = mutable.asStateFlow()

    private var busy = false
    private var generation = 0

    fun setScope(s: DownloadScope) {
        if (s == mutable.value.scope) return
        generation++
        busy = false
        mutable.update { it.copy(scope = s, data = kept[s], error = null) }
    }

    suspend fun load() {
        if (busy) return
        busy = true
        val gen = generation
        val s = mutable.value.scope
        try {
            val r = source.downloads(s)
            if (gen != generation) return
            kept[s] = r
            mutable.update { it.copy(data = r, error = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (gen != generation) return
            mutable.update { it.copy(error = AccountDownloadsLogic.cleanError(e.message ?: e.toString())) }
        } finally {
            if (gen == generation) busy = false
        }
    }

    /** Returns the toast to show. */
    suspend fun retry(d: DownloadsPage.Item): String {
        mutable.update { it.copy(retrying = d.id) }
        try {
            source.retry(d.id)
            val msg = L("{title} is back in line", "title" to d.title)
            busy = false
            load()
            return msg
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return L("Could not retry: {error}", "error" to AccountDownloadsLogic.cleanError(e.message ?: e.toString()))
        } finally {
            mutable.update { it.copy(retrying = null) }
        }
    }

    companion object {
        /** Last answer per scope for this run of the app (the web keeps it in localStorage). */
        private val kept = HashMap<DownloadScope, DownloadsPage>()

        fun resetKept() = kept.clear()
    }
}
