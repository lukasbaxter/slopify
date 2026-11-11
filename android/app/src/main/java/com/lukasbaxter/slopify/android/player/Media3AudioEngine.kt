package com.lukasbaxter.slopify.android.player

import android.content.Context
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * [AudioEngine] on Media3. Two ExoPlayers, like the two AVQueuePlayers on iOS: the active
 * one, and an idle one that buffers the next song (crossfade, or gapless off) or fades out
 * during a crossfade.
 *
 * Gapless: the next song is a second item in the active ExoPlayer's playlist; ExoPlayer moves
 * to it without a gap (it trims encoder delay / padding itself) and reports an automatic
 * media item transition. Crossfade needs two decoders running at once, which one ExoPlayer
 * cannot do, so it uses the idle player and equal-power volume ramps.
 *
 * Audio focus and becoming-noisy are handled by [AndroidAudioFocus] (two players asking for
 * focus would take it from each other). Main thread only.
 */
@OptIn(UnstableApi::class)
class Media3AudioEngine(context: Context, private val scope: CoroutineScope) : AudioEngine {
    private val app: Context = context.applicationContext
    override var events: AudioEngineEvents? = null

    private inner class Slot {
        val player: ExoPlayer = build(app)
        var item: AudioItem? = null
        /** Gapless follower: the second item of [player]'s playlist. */
        var next: AudioItem? = null
        /** Played at least once since the last load (a later buffering is a stall). */
        var played = false

        init { player.addListener(SlotListener(this)) }
    }

    private class Fade(val from: Slot, val to: Slot, val startMs: Long, val length: Double, val job: Job)

    private var active: Slot
    private var idle: Slot
    private var transition: AudioTransition = AudioTransition.None
    private var userVolume = 1f
    private var wantPlaying = false
    private var fade: Fade? = null
    /** setNext while a crossfade still uses the idle player: applied when it ends. */
    private var deferredNext: Pair<AudioItem?, AudioTransition>? = null
    private var retries = 0
    private var retryJob: Job? = null
    private var watchdog: Job? = null
    private var ticker: Job? = null
    private var lastTime = 0.0

    init {
        active = Slot()
        idle = Slot()
    }

    // AudioEngine

    override val currentId: String? get() = active.item?.id

    override val currentTime: Double
        get() {
            val p = active.player
            if (active.item == null) return lastTime
            return maxOf(0.0, p.currentPosition / 1000.0)
        }

    override fun load(item: AudioItem, at: Double, play: Boolean) {
        finishFade()
        retryJob?.cancel(); retryJob = null
        if (active.item?.id != item.id) retries = 0
        wantPlaying = play
        val spare = idle.item
        val follower = active.next
        if (spare != null && spare.id == item.id && spare.url == item.url && idle.player.playerError == null) {
            // The spare already buffers it: swap roles, no new request.
            val old = active; active = idle; idle = old
            active.item = item
            clear(idle)
            if (at > 0.05) active.player.seekTo((at * 1000).toLong())
        } else if (follower != null && follower.id == item.id && follower.url == item.url && active.player.mediaItemCount > 1) {
            active.player.seekTo(1, (at * 1000).toLong())
            active.player.removeMediaItem(0)
            active.item = item; active.next = null
        } else {
            clear(active)
            active.item = item
            active.player.setMediaItem(mediaItem(item), (at * 1000).toLong())
            active.player.prepare()
        }
        active.played = false
        lastTime = at
        applyVolume()
        active.player.playWhenReady = play
        updateTicker()
    }

    override fun setNext(item: AudioItem?, transition: AudioTransition) {
        if (fade != null) { deferredNext = item to transition; return }
        this.transition = transition
        if (item == null) { removeNext(active); clear(idle); return }
        if (transition == AudioTransition.Gapless) {
            clear(idle)
            val n = active.next
            if (n != null && n.id == item.id && n.url == item.url) return
            removeNext(active)
            if (active.item == null) return
            active.player.addMediaItem(mediaItem(item))
            active.next = item
        } else {
            removeNext(active)
            val spare = idle.item
            if (spare != null && spare.id == item.id && spare.url == item.url && idle.player.playerError == null) return
            clear(idle)
            idle.item = item
            idle.player.volume = 0f
            idle.player.setMediaItem(mediaItem(item))
            idle.player.playWhenReady = false
            idle.player.prepare()
        }
    }

    override fun play() {
        wantPlaying = true
        if (active.item == null) return
        if (active.player.playbackState == Player.STATE_IDLE) active.player.prepare()
        active.player.playWhenReady = true
        updateTicker()
    }

    override fun pause() {
        wantPlaying = false
        finishFade()
        active.player.playWhenReady = false
        watchdog?.cancel(); watchdog = null
        updateTicker()
    }

    override fun seek(seconds: Double) {
        finishFade()
        lastTime = seconds
        active.player.seekTo((seconds * 1000).toLong())
    }

    override fun setVolume(v: Float) {
        userVolume = v.coerceIn(0f, 1f)
        if (fade == null) applyVolume()
    }

    override fun unload() {
        wantPlaying = false
        finishFade()
        retryJob?.cancel(); retryJob = null
        watchdog?.cancel(); watchdog = null
        clear(active); clear(idle)
        transition = AudioTransition.None
        updateTicker()
    }

    override fun release() {
        unload()
        active.player.release()
        idle.player.release()
    }

    // Internals

    private fun build(context: Context): ExoPlayer {
        // Segments may block up to 30 s server-side while they transcode (API.md §12): that
        // is waiting, not failure, so the read timeout is well past it.
        val http = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(45_000)
        val sources = DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http))
        return ExoPlayer.Builder(context)
            .setMediaSourceFactory(sources)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), false)
            .setHandleAudioBecomingNoisy(false)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
    }

    private fun mediaItem(item: AudioItem): MediaItem {
        val b = MediaItem.Builder().setMediaId(item.id).setUri(item.url)
        if (item.url.startsWith("http")) b.setMimeType(MimeTypes.APPLICATION_M3U8)
        return b.build()
    }

    private fun clear(s: Slot) {
        s.player.playWhenReady = false
        s.player.stop()
        s.player.clearMediaItems()
        s.item = null; s.next = null; s.played = false
    }

    private fun removeNext(s: Slot) {
        if (s.next == null) return
        val n = s.player.mediaItemCount
        if (n > 1) s.player.removeMediaItems(1, n)
        s.next = null
    }

    private fun applyVolume() {
        active.player.volume = userVolume * (active.item?.gain ?: 1f)
    }

    private fun durationOf(s: Slot): Double {
        val d = s.player.duration
        return if (d != C.TIME_UNSET && d > 0) d / 1000.0 else s.item?.duration ?: 0.0
    }

    /** Runs while something should sound: playhead memo and the crossfade trigger. */
    private fun updateTicker() {
        if (wantPlaying || fade != null) {
            if (ticker != null) return
            ticker = scope.launch {
                while (isActive) {
                    delay(TICK_MS)
                    tick()
                }
            }
        } else {
            ticker?.cancel(); ticker = null
        }
    }

    private fun tick() {
        val s = active
        if (s.item != null) lastTime = s.player.currentPosition / 1000.0
        val t = transition
        if (t !is AudioTransition.Crossfade || fade != null || !wantPlaying || idle.item == null || !s.player.isPlaying) return
        val dur = durationOf(s)
        val left = dur - lastTime
        if (dur > 0 && left <= t.seconds && left > 0.1) beginFade(left)
    }

    private fun beginFade(length: Double) {
        val from = active
        val to = idle
        active = to; idle = from
        to.player.volume = 0f
        to.player.playWhenReady = true
        val job = scope.launch {
            while (isActive) {
                delay(FADE_STEP_MS)
                fadeStep()
            }
        }
        fade = Fade(from, to, SystemClock.elapsedRealtime(), length, job)
        retries = 0
        lastTime = 0.0
        to.played = false
        to.item?.id?.let { events?.audioAdvanced(it) }
    }

    private fun fadeStep() {
        val f = fade ?: return
        val x = min(1.0, (SystemClock.elapsedRealtime() - f.startMs) / 1000.0 / maxOf(0.05, f.length))
        f.from.player.volume = (cos(x * PI / 2) * userVolume * (f.from.item?.gain ?: 1f)).toFloat()
        f.to.player.volume = (sin(x * PI / 2) * userVolume * (f.to.item?.gain ?: 1f)).toFloat()
        if (x >= 1) finishFade()
    }

    /** Ends a crossfade now: the outgoing song stops, the incoming one at full level. */
    private fun finishFade() {
        val f = fade ?: return
        f.job.cancel()
        fade = null
        clear(f.from)
        applyVolume()
        deferredNext?.let { (item, t) -> deferredNext = null; setNext(item, t) }
    }

    /** Segments may block a while; past [STUCK_AFTER_MS] with nothing playing, reload at the playhead. */
    private fun armWatchdog(id: String) {
        if (watchdog != null) return
        val at = currentTime
        watchdog = scope.launch {
            delay(STUCK_AFTER_MS)
            watchdog = null
            if (!wantPlaying || active.item?.id != id || active.player.isPlaying) return@launch
            events?.audioStarved(id)
            reload(maxOf(at, currentTime))
        }
    }

    private fun reload(at: Double) {
        val item = active.item ?: return
        val keep = retries
        val play = wantPlaying
        val next = active.next
        val t = transition
        clear(active)
        active.item = item
        active.player.setMediaItem(mediaItem(item), (at * 1000).toLong())
        active.player.prepare()
        retries = keep
        wantPlaying = play
        applyVolume()
        active.player.playWhenReady = play
        if (t == AudioTransition.Gapless && next != null) setNext(next, t)
    }

    /** 503 busy, a slow transcode, a dropped link: retry with backoff before giving up. */
    private fun failed(s: Slot, e: PlaybackException) {
        if (s !== active) {
            // A preload failed: drop it; a real start makes a fresh request.
            if (s === idle) clear(idle)
            return
        }
        // The gapless follower broke while taking over: book the hand-over, then retry it.
        val n = s.next
        if (n != null && s.player.currentMediaItemIndex == 1) {
            s.item = n; s.next = null
            lastTime = 0.0
            events?.audioAdvanced(n.id)
        }
        val id = s.item?.id ?: return
        if (retries >= MAX_RETRIES) {
            events?.audioFailed(id, e.message ?: e.errorCodeName)
            return
        }
        retries++
        val delayS = min(8.0, 2.0.pow(retries - 1))
        events?.audioWaiting(id)
        retryJob?.cancel()
        retryJob = scope.launch {
            delay((delayS * 1000).toLong())
            if (active.item?.id == id) reload(lastTime)
        }
    }

    private inner class SlotListener(private val s: Slot) : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (s !== active || !isPlaying) return
            val id = s.item?.id ?: return
            watchdog?.cancel(); watchdog = null
            if (retries > 0 && s.player.currentPosition / 1000.0 > lastTime + 1) retries = 0
            s.played = true
            events?.audioHeard(id)
        }

        override fun onPlaybackStateChanged(state: Int) {
            if (s !== active) return
            val id = s.item?.id ?: return
            when (state) {
                Player.STATE_BUFFERING -> if (s.player.playWhenReady) {
                    if (s.played) events?.audioStarved(id)
                    events?.audioWaiting(id)
                    armWatchdog(id)
                }
                Player.STATE_READY -> reportDuration()
                Player.STATE_ENDED -> {
                    if (s.next != null || fade != null) return
                    watchdog?.cancel(); watchdog = null
                    wantPlaying = false
                    updateTicker()
                    events?.audioEnded(id)
                }
                else -> Unit
            }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            if (s !== active || reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) return
            val n = s.next ?: return
            if (s.player.currentMediaItemIndex != 1) return
            s.player.removeMediaItem(0)
            s.item = n; s.next = null
            retries = 0
            lastTime = 0.0
            applyVolume()
            events?.audioAdvanced(n.id)
        }

        override fun onTimelineChanged(timeline: Timeline, reason: Int) {
            if (s === active) reportDuration()
        }

        override fun onPlayerError(error: PlaybackException) = failed(s, error)

        private fun reportDuration() {
            val id = s.item?.id ?: return
            val d = s.player.duration
            if (d != C.TIME_UNSET && d > 0) events?.audioDuration(id, d / 1000.0)
        }
    }

    companion object {
        /** A song stuck with nothing coming for this long is reloaded (web STUCK_NO_DATA_MS). */
        const val STUCK_AFTER_MS = 30_000L
        const val MAX_RETRIES = 5
        private const val TICK_MS = 250L
        private const val FADE_STEP_MS = 50L
    }
}
