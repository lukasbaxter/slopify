package com.lukasbaxter.slopify.android.features.nowplaying

import com.lukasbaxter.slopify.android.core.model.Lyrics
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** One shown lyric line. `start` in seconds; `gap` = an inserted "♪". */
data class NowPlayingLyricLine(val text: String, val start: Double?, val gap: Boolean = false)

/** Lyric rules (RightPanel.jsx:264-330; UI.md 3.4; ios NowPlayingLyrics.swift). */
object NowPlayingLyrics {
    const val GAP_SECONDS = 5.0
    /** Lyrics appear slightly early (`LEAD_SECONDS`). */
    const val LEAD = 0.25

    /** Server lines (`start` in ms, API.md §10) to seconds. */
    fun lines(l: Lyrics): List<NowPlayingLyricLine> = l.lines.map { NowPlayingLyricLine(it.text, it.start?.let { s -> s / 1000.0 }) }

    /** `phoneLines`: blanks dropped; synced gaps longer than `max(5, 2.5 x median spacing)` get a "♪". */
    fun phoneLines(lines: List<NowPlayingLyricLine>): List<NowPlayingLyricLine> {
        val kept = lines.filter { it.text.isNotBlank() }
        if (kept.none { it.start != null }) return kept
        val spacings = mutableListOf<Double>()
        for (i in 1 until kept.size) {
            val a = kept[i - 1].start
            val b = kept[i].start
            if (a != null && b != null && b - a > 0) spacings += b - a
        }
        spacings.sort()
        val median = if (spacings.isEmpty()) GAP_SECONDS else spacings[spacings.size / 2]
        val threshold = max(GAP_SECONDS, 2.5 * median)
        val out = mutableListOf<NowPlayingLyricLine>()
        val first = kept.firstOrNull()?.start
        if (first != null && first > threshold) out += NowPlayingLyricLine("♪", 0.0, gap = true)
        kept.forEachIndexed { i, l ->
            out += l
            val a = l.start
            val b = kept.getOrNull(i + 1)?.start
            if (a != null && b != null && b - a > threshold) out += NowPlayingLyricLine("♪", a + min(5.0, (b - a) / 2), gap = true)
        }
        return out
    }

    /** Top edge fade only when scrolled down (> 1 dp) or past the first line (owner rule, web too). */
    fun showsTopFade(scrollOffset: Float, activeIndex: Int): Boolean = scrollOffset > 1 || activeIndex > 0

    fun isSynced(lines: List<NowPlayingLyricLine>): Boolean = lines.any { it.start != null }

    /** The time used to pick the line: `playhead - speakerDelay + 0.25`. */
    fun lookupTime(playhead: Double, speakerDelay: Double): Double = playhead - speakerDelay + LEAD

    /** The last line with `start <= at`; -1 before the first. */
    fun activeIndex(lines: List<NowPlayingLyricLine>, at: Double): Int {
        var idx = -1
        lines.forEachIndexed { i, l -> val s = l.start; if (s != null && at >= s) idx = i }
        return idx
    }

    /** Retry delays after a failed fetch: 2, 4, 8 s, then none. */
    fun retryDelay(attempt: Int): Double? = if (attempt < 3) 2 * 2.0.pow(attempt) else null
}

/**
 * A new song's lyrics start at the top (web v0.1.177), or at the active line when joining
 * mid-song. Once per song: a reload of the same song (sync finished, retry) never moves a list
 * the user has scrolled.
 */
class NowPlayingLyricsReset {
    sealed interface Target {
        data object Top : Target
        data class Line(val index: Int) : Target
    }

    var lastTrackId: String? = null
        private set

    /** Call when a song's lyrics have loaded. Null when this song was already reset. */
    fun loaded(trackId: String, activeIndex: Int): Target? {
        if (trackId == lastTrackId) return null
        lastTrackId = trackId
        return if (activeIndex >= 0) Target.Line(activeIndex) else Target.Top
    }
}
