package com.lukasbaxter.slopify.android.app

import android.os.SystemClock
import androidx.compose.foundation.gestures.DraggableState
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Velocity
import kotlin.math.max

/**
 * Swipe down to close (now playing, the queue, a list opened from the Home root): the layer
 * follows the finger and closes past 140, or 60 within 300 ms (UI.md 2.8). Fed two ways: a
 * downward pull that the page's list cannot scroll (at its top: nested scroll), and drags on
 * parts that do not scroll (the header). A screen that handles the touch itself (its own
 * swipe, a reorder drag) consumes it first, so this stays out of its way.
 */
internal class ShellDragDismiss(
    private val density: Density,
    private val target: Target,
    private val now: () -> Long = { SystemClock.uptimeMillis() },
) {
    interface Target {
        /** A pull starts; false refuses it (the layer is already leaving). */
        fun begin(): Boolean
        /** Pulled `dyPx` down from where it rests. */
        fun moved(dyPx: Float)
        /** Let go: close, or back in place. */
        fun released(commit: Boolean)
    }

    private var active = false
    private var offset = 0f
    private var startedAt = 0L

    private fun start(): Boolean {
        if (active) return true
        if (!target.begin()) return false
        active = true
        offset = 0f
        startedAt = now()
        return true
    }

    private fun move(dy: Float) {
        offset = max(0f, offset + dy)
        target.moved(offset)
    }

    fun release() {
        if (!active) return
        active = false
        val commit = offset > 0 && ShellMotion.dismissCommits(offset / density.density, now() - startedAt)
        offset = 0f
        target.released(commit)
    }

    /** Pushing back up first takes back the pull, before the list scrolls. */
    fun preScroll(available: Offset, source: NestedScrollSource): Offset? {
        if (!active || offset <= 0f || available.y >= 0f || source != NestedScrollSource.UserInput) return null
        val take = max(available.y, -offset)
        move(take)
        return Offset(0f, take)
    }

    /** What the list could not scroll downwards (it is at its top) pulls the layer. */
    fun postScroll(available: Offset, source: NestedScrollSource): Offset? {
        if (source != NestedScrollSource.UserInput || available.y <= 0f) return null
        if (!start()) return null
        move(available.y)
        return Offset(0f, available.y)
    }

    /** The finger left while pulling: decide, and keep the list from flinging. */
    fun preFling(available: Velocity): Velocity? {
        if (!active) return null
        release()
        return available
    }

    /** For the parts of the layer that do not scroll. */
    fun dragModifier(): Modifier = Modifier.draggable(
        state = DraggableState { d -> if (active || (d > 0 && start())) move(d) },
        orientation = Orientation.Vertical,
        onDragStopped = { release() },
    )
}
