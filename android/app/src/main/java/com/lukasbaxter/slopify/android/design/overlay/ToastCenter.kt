package com.lukasbaxter.slopify.android.design.overlay

import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.lukasbaxter.slopify.android.core.stores.Connectivity
import com.lukasbaxter.slopify.android.core.stores.LyricJobEvent
import com.lukasbaxter.slopify.android.core.stores.LyricJobStage
import com.lukasbaxter.slopify.android.core.stores.LyricJobStore
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.theme.Shell as ShellMetrics
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Toasts, the offline pill and the lyric-sync pill (UI.md 2.9; ios Design/Overlay/ToastCenter.swift),
 * drawn by the design root above everything: the tab bar, the mini player, now playing and sheets
 * (DECISIONS: above the mini player, and above now playing when it is open).
 *
 *     ToastCenter.shared.show(L("Added to {name}", "name" to p.name))
 *     ToastCenter.shared.layout.value = ToastLayout.Shell(miniPlayer = true) // the shell keeps it current
 */
class ToastCenter(private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)) {

    @Immutable
    data class Toast(val text: String, val id: String = UUID.randomUUID().toString())

    @Immutable
    data class LyricSync(val title: String, val stage: String, /** Further jobs waiting. */ val more: Int = 0)

    private val toastFlow = MutableStateFlow<Toast?>(null)
    val toast: StateFlow<Toast?> = toastFlow.asStateFlow()
    /** `Offline · downloaded music only` pill while offline. */
    val offline = MutableStateFlow(false)
    /** The lyric-sync pill while jobs run. */
    val lyricSync = MutableStateFlow<LyricSync?>(null)
    /** Where the stack sits. */
    val layout = MutableStateFlow<ToastLayout>(ToastLayout.Shell(miniPlayer = true))

    private var timer: Job? = null
    private var following: Job? = null

    /** Show `text` for 2.2 s (some messages use 5 s). A new toast replaces the old and restarts the timer. */
    fun show(text: String, seconds: Double = 2.2) {
        val t = Toast(text)
        toastFlow.value = t
        synchronized(this) {
            timer?.cancel()
            timer = scope.launch {
                delay((seconds * 1000).toLong())
                toastFlow.compareAndSet(t, null)
            }
        }
    }

    fun hide() {
        synchronized(this) { timer?.cancel() }
        toastFlow.value = null
    }

    /**
     * Mirror the app's offline state and lyric jobs: the two pills, and the jobs' toasts in the
     * web's words (api/lyricsync.js).
     */
    fun follow(connectivity: Connectivity, lyricJobs: LyricJobStore, scope: CoroutineScope) {
        following?.cancel()
        following = scope.launch {
            launch { connectivity.offline.collect { offline.value = it } }
            launch {
                lyricJobs.pill.collect { p ->
                    lyricSync.value = p?.let { LyricSync(it.title ?: L("This song"), stageText(it.stage), it.more) }
                }
            }
            launch { lyricJobs.events.collect { e -> eventText(e).let { (text, s) -> show(text, s) } } }
        }
    }

    companion object {
        @Volatile var shared: ToastCenter = ToastCenter()

        /** `jobLabel`. */
        fun stageText(s: LyricJobStage): String = when (s) {
            is LyricJobStage.Waiting -> L("Waiting · {n} ahead", "n" to s.ahead)
            LyricJobStage.Starting -> L("Starting")
            is LyricJobStage.Step -> s.text
        }

        /** The toast for a job event, and how long it shows. */
        fun eventText(e: LyricJobEvent): Pair<String, Double> = when (e) {
            is LyricJobEvent.AlreadySyncing -> L("Already syncing \"{name}\"", "name" to e.title) to 2.2
            is LyricJobEvent.StartFailed -> L("Couldn't sync lyrics: {error}", "error" to e.error) to 2.2
            is LyricJobEvent.Finished -> {
                val title = e.title ?: L("This song")
                val result = e.result?.takeIf { it.isNotEmpty() } ?: if (e.failed) L("Couldn't sync") else L("Done")
                "$title: $result" to 5.0
            }
        }
    }
}

/** Where the toast stack sits: above the mini player card, above the tab bar, or over now playing. */
@Immutable
sealed interface ToastLayout {
    data class Shell(val miniPlayer: Boolean) : ToastLayout
    data object NowPlaying : ToastLayout
    /** Distance above the bottom inset (sign-in screens etc.). */
    data class Bottom(val height: Dp) : ToastLayout

    /** Distance from the bottom inset edge to the stack's bottom. */
    val clearance: Dp
        get() = when (this) {
            is Shell -> ShellMetrics.tabBar + if (miniPlayer) ShellMetrics.miniPlayerGap + ShellMetrics.miniPlayer + 8.dp else 16.dp
            NowPlaying -> 112.dp // clears the now playing bottom row (device / lyrics / queue)
            is Bottom -> height
        }
}

