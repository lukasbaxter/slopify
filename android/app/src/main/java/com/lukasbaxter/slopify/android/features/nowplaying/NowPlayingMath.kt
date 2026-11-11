package com.lukasbaxter.slopify.android.features.nowplaying

import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.theme.Gestures
import com.lukasbaxter.slopify.android.design.theme.RGB
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Pure rules behind the player screens (UI.md 3.1-3.3; ios NowPlayingMath.swift). Distances in dp. */
object NowPlayingMath {
    /** `fmt` (FullScreen.jsx:18): `m:ss`, minutes unbounded, bad input = 0:00. */
    fun time(seconds: Double): String {
        if (!seconds.isFinite() || seconds < 0) return "0:00"
        val m = (seconds / 60).toInt()
        val s = (seconds % 60).toInt()
        return "$m:" + if (s < 10) "0$s" else "$s"
    }

    /** The right-hand label: `-(duration - shown)` clamped at 0. */
    fun remaining(shown: Double, duration: Double): String = "-" + time(max(0.0, duration - shown))

    /** Played fraction 0..1. */
    fun fraction(position: Double, duration: Double): Double {
        if (duration <= 0 || !position.isFinite()) return 0.0
        return min(1.0, max(0.0, position / duration))
    }

    /** Seek bar: the finger x drives the value over `0..max(1, duration)`. */
    fun scrubValue(x: Float, width: Float, duration: Double): Double {
        val d = max(1.0, duration)
        if (width <= 0) return 0.0
        return min(d, max(0.0, (x / width).toDouble() * d))
    }

    /** How long the scrubbed value is held after release so the thumb does not snap back. */
    fun scrubHold(mirroring: Boolean): Double = if (mirroring) 1.5 else 0.25

    // Mini player swipe to skip (App.jsx:1434-1450, Player.jsx:223-245)

    enum class Skip { Next, Previous }

    /** `|dx| > 60 && |dy| < 40 && < 600 ms`; left = next. */
    fun skip(dx: Float, dy: Float, elapsed: Double): Skip? {
        if (abs(dx) <= Gestures.SKIP_DISTANCE || abs(dy) >= Gestures.SKIP_MAX_VERTICAL || elapsed >= Gestures.SKIP_MS / 1000.0) return null
        return if (dx < 0) Skip.Next else Skip.Previous
    }

    /** The row follows the finger once `|dx| > 6`: offset clamp(dx, -80, 80), opacity `1 - min(80,|dx|)/200`. */
    fun skipFollow(dx: Float): Pair<Float, Double> {
        if (abs(dx) <= 6) return 0f to 1.0
        return min(80f, max(-80f, dx)) to 1 - min(80f, abs(dx)).toDouble() / 200
    }

    /** Abandon the swipe when vertical movement wins before 6 dp of horizontal travel. */
    fun abandonsSwipe(dx: Float, dy: Float): Boolean = abs(dx) <= 6 && abs(dy) > abs(dx)

    // Now playing swipe down (App.jsx:1451-1480)

    /** Close if `dy > 140`, or `dy > 60` in under 300 ms. */
    fun dismissesNowPlaying(dy: Float, elapsed: Double): Boolean =
        dy > Gestures.NOW_PLAYING_DISMISS_DISTANCE || (elapsed < 0.3 && dy > Gestures.NOW_PLAYING_FLICK_DISTANCE)

    /**
     * Swipe down closes from anywhere on the Album tab. On the Lyrics tab only a swipe that starts
     * on the header closes it; one on the lyric lines never does (owner's rule).
     */
    fun swipeDismissAllowed(lyricsShowing: Boolean, startY: Float, headerBottom: Float): Boolean =
        !lyricsShowing || startY <= headerBottom

    /**
     * Queue swipe-down (web v0.1.177): from the header, or the list while it is at its top
     * (offset <= 1). A swipe that starts on a drag handle is a reorder and never closes it.
     */
    fun queueSwipeDismissAllowed(startY: Float, headerBottom: Float, listOffset: Float, onHandle: Boolean): Boolean {
        if (onHandle) return false
        return startY <= headerBottom || listOffset <= 1
    }

    // Lyrics backdrop. The web uses blur(60px) brightness(.32) saturate(1.3); native is brighter on
    // purpose so more of the cover shows, and a scrim then caps light covers.

    const val LYRICS_BACKDROP_BRIGHTNESS = 0.42
    const val LYRICS_BACKDROP_SATURATION = 1.4
    /** Highest backdrop luminance: white text keeps >= 7:1 and the 50 % lines stay readable. */
    const val LYRICS_BACKDROP_MAX_LUMINANCE = 0.09

    /** Black scrim opacity that keeps this average cover colour under the luminance cap. 0 for dark covers. */
    fun lyricsScrimOpacity(average: RGB): Double {
        fun lum(a: Double): Double {
            val k = LYRICS_BACKDROP_BRIGHTNESS * (1 - a)
            return RGB(average.r * k, average.g * k, average.b * k).luminance
        }
        if (lum(0.0) <= LYRICS_BACKDROP_MAX_LUMINANCE) return 0.0
        var lo = 0.0
        var hi = 1.0
        repeat(30) {
            val m = (lo + hi) / 2
            if (lum(m) > LYRICS_BACKDROP_MAX_LUMINANCE) lo = m else hi = m
        }
        return hi
    }

    /** Mean colour of premultiplied RGBA values (alpha-weighted, transparent pixels count as nothing). */
    fun averageColor(px: IntArray): RGB? {
        var r = 0.0
        var g = 0.0
        var b = 0.0
        var n = 0.0
        var i = 0
        while (i + 3 < px.size) {
            val a = px[i + 3] / 255.0
            if (a > 0) {
                r += px[i] / a; g += px[i + 1] / a; b += px[i + 2] / a; n += 1
            }
            i += 4
        }
        if (n <= 0) return null
        return RGB(min(255.0, r / n), min(255.0, g / n), min(255.0, b / n))
    }

    // Queue reorder (RightPanel.jsx:170-207)

    /** Target slot `pos + round(dy / rowHeight)`, clamped to the upcoming rows `[current+1, count-1]`. */
    fun reorderTarget(from: Int, dy: Float, rowHeight: Float, current: Int, count: Int): Int {
        val h = if (rowHeight > 0) rowHeight else 64f
        val raw = from + jsRound(dy / h)
        val lo = current + 1
        val hi = count - 1
        if (hi < lo) return from
        return min(hi, max(lo, raw))
    }

    /** Shift of row `row` while `from` is dragged to `to`: rows in between move by one row. */
    fun reorderShift(row: Int, from: Int, to: Int, rowHeight: Float): Float {
        if (to > from && row > from && row <= to) return -rowHeight
        if (to < from && row >= to && row < from) return rowHeight
        return 0f
    }

    // Sleep timer label (FullScreen.jsx:44-60)

    /** `at` and `now` in ms. */
    fun sleepLabel(at: Double?, endOfTrack: Boolean, now: Double): String {
        if (endOfTrack) return L("Sleep timer: end of track")
        if (at == null) return L("Sleep timer")
        val left = max(1, ceil((at - now) / 60000).toInt())
        if (left < 60) return L("Sleep timer: {m} min left", "m" to left)
        val h = left / 60
        val m = left % 60
        return if (m == 0) L("Sleep timer: {h} h left", "h" to h) else L("Sleep timer: {h} h {m} min left", "h" to h, "m" to m)
    }

    // Speaker volume (DevicePicker.jsx:64-108)

    /** `round(clamp01(x / width) * 100)`. */
    fun volumeValue(x: Float, width: Float): Double {
        if (width <= 0) return 0.0
        return (min(1.0, max(0.0, (x / width).toDouble())) * 100).roundToInt().toDouble()
    }

    /** Swift `.rounded()` (half away from zero). */
    private fun jsRound(v: Float): Int = if (v >= 0) (v + 0.5f).toInt() else -((-v + 0.5f).toInt())
}

/** One send per `interval` seconds, keeping the latest value for a trailing send (`useThrottledVolume`). */
class NowPlayingThrottle(private val interval: Double) {
    sealed interface Decision {
        data class Send(val value: Double) : Decision
        /** Arm one timer for `delay` s, then call [flush]. */
        data class Wait(val delay: Double) : Decision
    }

    private var lastSent = Double.NEGATIVE_INFINITY
    private var pending: Double? = null

    /** `now` in seconds. */
    fun offer(v: Double, now: Double): Decision {
        if (now - lastSent >= interval) {
            lastSent = now
            pending = null
            return Decision.Send(v)
        }
        pending = v
        return Decision.Wait(interval - (now - lastSent))
    }

    /** The pending value, if any (timer fired or release). */
    fun flush(now: Double): Double? {
        val p = pending ?: return null
        pending = null
        lastSent = now
        return p
    }
}
