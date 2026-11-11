package com.lukasbaxter.slopify.android.app

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import com.lukasbaxter.slopify.android.design.components.SwipeToQueue
import com.lukasbaxter.slopify.android.design.theme.Gestures
import kotlin.math.max
import kotlin.math.min

/** How a tab's stack changed between two navigator states. */
internal sealed interface StackChange {
    data object None : StackChange
    /** One page on top (also when several arrived at once: only the top animates). */
    data class Push(val entry: StackEntry) : StackChange
    /** The top page left; `leaving` animates out over the new top (or the root). */
    data class Pop(val leaving: StackEntry) : StackChange
    /** Anything else (reset, replaced): no animation. */
    data object Replace : StackChange

    companion object {
        fun of(old: List<StackEntry>, new: List<StackEntry>): StackChange {
            val o = old.map { it.id }
            val n = new.map { it.id }
            return when {
                o == n -> None
                n.size > o.size && n.subList(0, o.size) == o -> Push(new.last())
                n.size < o.size && o.subList(0, n.size) == n -> Pop(old.last())
                else -> Replace
            }
        }
    }
}

/**
 * The shell's gesture and transition maths (ios LibrarySwipeBack, HomeZoom, NowPlayingMath),
 * pure so tests run without a finger. Distances in dp unless named px.
 */
internal object ShellMotion {
    /** Scroll offset tolerance for "at the top". */
    const val TOP_EPSILON = 1f

    /** Library swipe-back commits past this share of the width, or on a rightward flick. */
    const val SWIPE_BACK_SHARE = 0.35f
    const val SWIPE_BACK_FLICK = 800f

    /** How far the page below sits to the left while the top page covers it (parallax). */
    const val BELOW_PARALLAX = 0.25f

    /** A dragged-down Home list shrinks to this scale at most. */
    const val PULL_MIN_SCALE = 0.6f
    /** Predictive back on a Home list shrinks it by up to this much. */
    const val BACK_SHRINK = 0.12f

    fun isAtTop(scrolled: Float): Boolean = scrolled <= TOP_EPSILON

    /**
     * Pages opened from Your Library pop with a left-to-right swipe in the top half of the screen
     * while scrolled to the top (owner 11-11, Spotify iOS). Not from the system edge; track rows
     * keep their swipe-to-queue (they take the touch first, so `consumedByChild` is true there).
     */
    fun swipeBackMayBegin(
        isLibraryTab: Boolean,
        stackCount: Int,
        startX: Float,
        startY: Float,
        screenHeight: Float,
        direction: Offset,
        scrollAtTop: Boolean,
        consumedByChild: Boolean,
    ): Boolean =
        isLibraryTab && stackCount > 0 && startX >= SwipeToQueue.EDGE_GUARD && startY < screenHeight / 2 &&
            SwipeToQueue.isRightward(direction) && scrollAtTop && !consumedByChild

    /** Let go of a library swipe-back at `dx` (px of `width`) with `velocityX` (dp/s). */
    fun swipeBackCommits(dx: Float, width: Float, velocityX: Float): Boolean =
        width > 0 && (dx > width * SWIPE_BACK_SHARE || (velocityX > SWIPE_BACK_FLICK && dx > 0))

    /** Now playing / queue / Home list swipe-down: dy > 140, or dy > 60 within 300 ms. */
    fun dismissCommits(dy: Float, elapsedMs: Long): Boolean =
        dy > Gestures.NOW_PLAYING_DISMISS_DISTANCE ||
            (elapsedMs < Gestures.SHEET_FLICK_MS && dy > Gestures.NOW_PLAYING_FLICK_DISTANCE)

    /** Top page offset for a slide at progress `p` (1 = in place). */
    fun slideX(p: Float, width: Float): Float = (1 - p.coerceIn(0f, 1f)) * width

    /** The page below, pushed a little to the left while the top page covers it. */
    fun belowX(p: Float, width: Float): Float = -p.coerceIn(0f, 1f) * width * BELOW_PARALLAX

    fun lerp(a: Rect, b: Rect, t: Float): Rect = Rect(
        a.left + (b.left - a.left) * t,
        a.top + (b.top - a.top) * t,
        a.right + (b.right - a.right) * t,
        a.bottom + (b.bottom - a.bottom) * t,
    )

    /** A Home list pulled down by `dyPx`: it follows the finger and shrinks (iOS zoom dismiss). */
    fun pulledRect(full: Rect, dyPx: Float): Rect {
        val h = max(1f, full.height)
        val s = max(PULL_MIN_SCALE, 1 - 0.5f * max(0f, dyPx) / h)
        val w = full.width * s
        val left = full.left + (full.width - w) / 2
        val top = full.top + max(0f, dyPx)
        return Rect(left, top, left + w, top + full.height * s)
    }

    /** A Home list during predictive back: shrinks about its centre by up to [BACK_SHRINK]. */
    fun backRect(full: Rect, progress: Float): Rect {
        val s = 1 - BACK_SHRINK * progress.coerceIn(0f, 1f)
        val w = full.width * s
        val h = full.height * s
        return Rect(full.center.x - w / 2, full.center.y - h / 2, full.center.x + w / 2, full.center.y + h / 2)
    }

    /** No tile to zoom from (scrolled away): a small rect in the middle. */
    fun fallbackSource(full: Rect): Rect {
        val w = full.width * 0.5f
        val h = min(full.height, w)
        return Rect(full.center.x - w / 2, full.center.y - h / 2, full.center.x + w / 2, full.center.y + h / 2)
    }

    /** Page opacity while zooming: fades only near the tile. */
    fun zoomAlpha(p: Float): Float = (p / 0.2f).coerceIn(0f, 1f)
}
