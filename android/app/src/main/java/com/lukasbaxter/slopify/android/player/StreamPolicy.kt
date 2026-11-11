package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.model.asBool
import com.lukasbaxter.slopify.android.core.model.asDouble
import com.lukasbaxter.slopify.android.core.model.asObject
import com.lukasbaxter.slopify.android.core.model.asString
import kotlin.math.pow
import kotlin.math.sign

/** Which stream to ask for and how loud to play it (API.md §12.3, §12.7). Pure. */
object StreamPolicy {
    /** Web quality id -> HLS `max` profile (API.md §12.7). */
    fun profile(quality: String?): String = when (quality) {
        "original" -> "alac"
        "normal" -> "aac-160"
        "low" -> "aac-96"
        else -> "aac-320" // "high" and unknown
    }

    /** Phones read `phoneQuality` (default high), tablets `quality` (default original). */
    fun quality(prefs: Prefs, tablet: Boolean): String =
        if (tablet) prefs["quality"].asString() ?: "original" else prefs["phoneQuality"].asString() ?: "high"

    fun normalize(prefs: Prefs): Boolean = prefs["normalize"].asBool() != false

    /** web `normModeFor`: album gain when the queue was played from this track's album. */
    fun normMode(track: Track, context: String?, normalize: Boolean): String? {
        if (!normalize) return null
        return if (context != null && context == track.albumId) "album" else "track"
    }

    /** web `gainDbFor`: album falls back to track; unmeasured = 0 dB. */
    fun gainDb(track: Track, mode: String?): Double {
        val g = track.gain
        if (mode == null || g == null) return 0.0
        return (if (mode == "album") g.album ?: g.track else g.track) ?: 0.0
    }

    /**
     * Linear factor the player itself applies. Only where the server did not bake the gain
     * in: lossless HLS and downloaded originals. Capped at 1 like iOS (ExoPlayer volume does
     * not amplify): positive gains play at 0 dB.
     */
    fun clientGain(track: Track, context: String?, normalize: Boolean, profile: String): Float {
        if (profile != "alac") return 1f
        val db = gainDb(track, normMode(track, context, normalize))
        return minOf(1.0, 10.0.pow(db / 20)).toFloat()
    }

    /** Mobile-data stall cap (web linkWatch.js): one rung lower for a while. */
    fun capped(profile: String): String = mapOf("alac" to "aac-320", "aac-320" to "aac-160", "aac-160" to "aac-96")[profile] ?: profile

    fun crossfadeSetting(prefs: Prefs): Double = (prefs["crossfade"].asDouble() ?: 0.0).coerceIn(0.0, 12.0)
    fun gapless(prefs: Prefs): Boolean = prefs["gapless"].asBool() != false

    /**
     * web `transitionPlan`: how the current song hands over to the next when it ends by
     * itself. An album in order is always gapless; fades are at most a third of either song.
     */
    fun transition(
        current: Track, next: Track, context: String?, crossfade: Double, gapless: Boolean,
        repeatOne: Boolean, sleepEndOfTrack: Boolean,
    ): AudioTransition {
        if (repeatOne || sleepEndOfTrack) return AudioTransition.None
        val inAlbum = context != null && current.albumId == context && next.albumId == current.albumId
        var fade = if (inAlbum) 0.0 else crossfade
        if (fade > 0) fade = minOf(fade, current.duration / 3, next.duration / 3)
        if (fade > 0) return AudioTransition.Crossfade(fade)
        return if (gapless) AudioTransition.Gapless else AudioTransition.None
    }

    /** Ids to warm (web `preloadRef`): the next three, or the first one under repeat all. */
    fun warmIds(entries: List<QueueEntry>, index: Int, repeatAll: Boolean): List<String> {
        var ids = entries.drop(index + 1).take(3).map { it.track.id }
        if (ids.isEmpty() && repeatAll) entries.firstOrNull()?.let { ids = listOf(it.track.id) }
        return ids
    }

    /** Prefs `dislikes` (`{ trackId: ms }`): dropped from every mix (web `instantMix`). */
    fun dropDisliked(tracks: List<Track>, prefs: Prefs): List<Track> {
        val d = prefs["dislikes"].asObject()
        if (d.isNullOrEmpty()) return tracks
        return tracks.filter { it.id !in d }
    }
}

/**
 * Hardware volume steps (web `makeVolumeStepper`): one step per 300 ms, 5 per step, a run goes
 * at most 20 above where it began until the buttons rest for 3 s.
 */
class VolumeStepper {
    private var last = 0.0
    private var runFrom: Double? = null

    fun step(from: Double, step: Int, now: Double): Double? {
        if (step == 0 || now - last < 300) return null
        if (runFrom == null || now - last > 3000) runFrom = from
        last = now
        val want = (from + step.sign * 5).coerceIn(0.0, 100.0)
        val next = minOf(want, maxOf(from, (runFrom ?: from) + 20))
        return if (next == from) null else next
    }
}

/**
 * Localization keys (web locales, English key = text). TODO(lead): route through L() once
 * the design task's locale loader exists; the keys below are the web's.
 */
internal object PlayerText {
    fun format(key: String, args: Map<String, String> = emptyMap()): String =
        args.entries.fold(key) { s, (k, v) -> s.replace("{$k}", v) }
}
