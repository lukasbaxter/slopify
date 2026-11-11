package com.lukasbaxter.slopify.android.player

/** One song as the audio layer sees it. `url` is http(s) for HLS or `file://` for a download. */
data class AudioItem(
    val id: String,
    val url: String,
    /** Linear gain the player applies itself (<= 1), on top of the user volume. */
    val gain: Float = 1f,
    /** Library length, used until the stream reports its own. */
    val duration: Double = 0.0,
)

/** How the current song hands over to the preloaded next one when it ends by itself. */
sealed interface AudioTransition {
    /** Next is only buffered; the Player starts it after `ended` (sleep timer, gapless off). */
    data object None : AudioTransition
    /** Next starts the moment this one ends (ExoPlayer playlist). */
    data object Gapless : AudioTransition
    /** Next starts this many seconds before the end, equal-power fade. */
    data class Crossfade(val seconds: Double) : AudioTransition
}

/**
 * What the Player needs from Media3. Behind an interface so queue / session logic is testable
 * on the JVM with a fake (ios AudioEngine.swift). Main thread only.
 */
interface AudioEngine {
    var events: AudioEngineEvents?
    val currentId: String?
    /** Seconds into the current song. */
    val currentTime: Double
    /** Replace everything and start `item` at `seconds` (uses a preloaded copy when it has one). */
    fun load(item: AudioItem, at: Double, play: Boolean)
    /** What comes after the current song, and how it takes over. null clears. */
    fun setNext(item: AudioItem?, transition: AudioTransition)
    fun play()
    fun pause()
    fun seek(seconds: Double)
    /** User volume 0..1. */
    fun setVolume(v: Float)
    /** Stop and drop all media (yield, hand-off, end of queue). */
    fun unload()
    /** Process teardown. */
    fun release() = unload()
}

interface AudioEngineEvents {
    /** Sound is coming out (after a load, seek or rebuffer). */
    fun audioHeard(id: String)
    /** Playing but waiting for data. */
    fun audioWaiting(id: String)
    /** Ended with nothing taking over: the Player decides what is next. */
    fun audioEnded(id: String)
    /** The preloaded next song took over by itself (gapless / crossfade). */
    fun audioAdvanced(id: String)
    /** Gave up after retries. */
    fun audioFailed(id: String, message: String)
    /** The stream's own length is known. */
    fun audioDuration(id: String, seconds: Double)
    /** A stall worth noting for the mobile-data quality cap. */
    fun audioStarved(id: String)
}
