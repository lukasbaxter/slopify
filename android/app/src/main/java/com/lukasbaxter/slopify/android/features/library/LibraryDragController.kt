package com.lukasbaxter.slopify.android.features.library

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import com.lukasbaxter.slopify.android.design.components.Haptics
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.hypot

/**
 * The live drag of a list row (Your Library tree mode, playlist songs), libraryDrag.js on the
 * phone (ios LibraryDragController.swift): one pointer handler on the list itself, not one per
 * row, so the gesture survives rows leaving the list while it auto-scrolls.
 *
 * - A finger that moves more than 8 dp before 380 ms (or that the list starts scrolling) gives
 *   the touch back untouched: a swipe on a row scrolls.
 * - Held still for 380 ms over a drag row it lifts (haptic). From then every event is consumed
 *   before the list and the rows see it, the row follows the finger, the others slide aside,
 *   the list auto-scrolls near its edges.
 * - Let go within 8 dp of the lift point: a hold (the row's menu). Otherwise a drop.
 *
 * All points are dp in the list's content coordinates: viewport y minus [origin], the viewport
 * y of the rows' content top.
 */
@Stable
class LibraryDragController {
    data class Lift(
        val id: String,
        val rows: List<LibraryDrag.Row>,
        val from: Int,
        val target: LibraryDrag.Target,
        val start: Offset,
        val finger: Offset,
        /** Still within 8 dp of the lift point: letting go opens the menu instead. */
        val held: Boolean = true,
    )

    sealed interface Outcome {
        data class Hold(val id: String) : Outcome
        data class Drop(val id: String, val to: Int, val into: String?, val rows: List<String>) : Outcome
    }

    var lift by mutableStateOf<Lift?>(null)
        private set
    val isLifted: Boolean get() = lift != null

    /** From the lift until the finger is up: a row's own long-press menu must not open. */
    var holding by mutableStateOf(false)
        internal set

    /** Viewport y (dp) of the content top while lifted: places the ghost and the drop line. */
    var liveOrigin by mutableFloatStateOf(0f)
        internal set

    /** The drag rows now, in content coordinates (empty: nothing can be dragged, e.g. flat mode). */
    var rows: () -> List<LibraryDrag.Row> = { emptyList() }
    var canEnter: (String) -> Boolean = { false }
    /**
     * Before measuring: return true when the lift changes the layout (a folder drag shuts the
     * folders), so the rows are measured a moment later.
     */
    var willLift: (String) -> Boolean = { false }
    var onFinish: (Outcome?) -> Unit = {}
    /** Viewport y (dp) of the rows' content top now; null when it cannot be known (rows not shown). */
    var origin: () -> Float? = { 0f }
    /** Scroll the list by `px`; returns what it moved. */
    var scrollBy: (Float) -> Float = { 0f }
    /** Parts of the list covered by chrome (top bar; mini player and tab bar), dp. */
    var coveredTop = 0f
    var coveredBottom = 0f

    fun rowId(p: Offset): String? = rows().firstOrNull { it.rect.contains(p) }?.id

    // The state machine (gesture-free, tested)

    fun begin(id: String, rows: List<LibraryDrag.Row>, at: Offset) {
        if (lift != null) return
        val from = rows.indexOfFirst { it.id == id }
        if (from < 0) return
        lift = Lift(id, rows, from, LibraryDrag.Target(from), at, at)
    }

    fun move(p: Offset) {
        val l = lift ?: return
        val held = l.held && hypot(p.x - l.start.x, p.y - l.start.y) <= LibraryDrag.TOUCH_SLOP
        val next = l.copy(finger = p, held = held, target = LibraryDrag.target(l.rows, l.from, l.target, p, canEnter(l.id)))
        if (next != l) lift = next
    }

    /** Let go. Null = put back (no move, or moved back to its own slot). */
    fun end(): Outcome? {
        val l = lift ?: return null
        lift = null
        if (l.held) return Outcome.Hold(l.id)
        if (l.target.into != null || l.target.to != l.from) return Outcome.Drop(l.id, l.target.to, l.target.into, l.rows.map { it.id })
        return null
    }

    /** The touch was taken away: everything goes back. */
    fun cancel() { lift = null }

    /** How far a row is drawn from its own place. */
    fun offset(id: String): Offset {
        val l = lift ?: return Offset.Zero
        val j = l.rows.indexOfFirst { it.id == id }
        if (j < 0) return Offset.Zero
        if (j == l.from) return l.finger - l.start
        return LibraryDrag.shift(l.rows, l.from, l.target.to, j)
    }

    /** The lifted row where it is drawn now (content coordinates). */
    val ghost: Rect?
        get() = lift?.let { l -> l.rows[l.from].rect.translate(l.finger - l.start) }

    val dropLine: Rect? get() = lift?.let { LibraryDrag.dropLine(it.rows, it.from, it.target) }
    val targetFolder: String? get() = lift?.target?.into

    // The gesture

    internal fun finish(outcome: Outcome?) {
        holding = false
        onFinish(outcome)
    }
}

/**
 * Put on the list's own modifier (the viewport): the hold-to-drag gesture of [drag]. The list
 * keeps scrolling and the rows keep their taps unless a still hold lifts a row.
 */
@Composable
internal fun Modifier.libraryDragHost(drag: LibraryDragController): Modifier {
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    return pointerInput(drag) {
        val slopPx = LibraryDrag.TOUCH_SLOP * density
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val viewH = size.height / density
            if (down.position.y / density < drag.coveredTop) return@awaitEachGesture
            val origin0 = drag.origin() ?: return@awaitEachGesture
            fun content(px: Offset, origin: Float) = Offset(px.x / density, px.y / density - origin)
            val start = content(down.position, origin0)
            val id = drag.rowId(start) ?: return@awaitEachGesture
            var last = down.position
            // Still for 380 ms, or give the touch back (null = held long enough).
            val gaveUp = withTimeoutOrNull(LibraryDrag.LIFT_DELAY_MS) { waitStill(down.id, down.position, slopPx) { last = it } }
            if (gaveUp != null) return@awaitEachGesture
            Haptics.tick(haptics)
            drag.holding = true
            var ticker: Job? = null
            var finished = false
            try {
                if (drag.willLift(id)) {
                    // The layout changes first (folders shut): measure a moment later.
                    val up = withTimeoutOrNull(50L) { follow(down.id) { last = it } }
                    if (up != null) { finished = true; drag.finish(null); return@awaitEachGesture }
                }
                val origin = drag.origin() ?: origin0
                drag.liveOrigin = origin
                drag.begin(id, drag.rows(), start)
                if (!drag.isLifted) { finished = true; drag.finish(null); return@awaitEachGesture }
                drag.move(content(last, drag.liveOrigin))
                ticker = scope.launch {
                    // Near the visible edges the list scrolls; the finger's content point moves with it.
                    while (isActive) {
                        withFrameNanos { }
                        if (!drag.isLifted) continue
                        val top = drag.coveredTop
                        val v = LibraryDrag.autoScroll(last.y / density - top, viewH - top - drag.coveredBottom)
                        if (v == 0f) continue
                        val moved = drag.scrollBy(v * density)
                        if (moved == 0f) continue
                        drag.liveOrigin -= moved / density
                        drag.move(content(last, drag.liveOrigin))
                    }
                }
                follow(down.id) { p -> last = p; drag.move(content(p, drag.liveOrigin)) }
                ticker.cancel()
                finished = true
                drag.finish(drag.end())
            } finally {
                ticker?.cancel()
                if (!finished) {
                    drag.cancel()
                    drag.finish(null)
                }
            }
        }
    }
}

/**
 * Watches pointer `id` without touching its events; returns true (give up) when it lifts,
 * moves past `slop`, or the list or a row takes it (scroll, swipe to queue).
 */
private suspend fun AwaitPointerEventScope.waitStill(id: PointerId, start: Offset, slop: Float, onMove: (Offset) -> Unit): Boolean {
    while (true) {
        val e = awaitPointerEvent(PointerEventPass.Initial)
        val c = e.changes.firstOrNull { it.id == id } ?: return true
        if (!c.pressed || e.changes.size > 1) return true
        onMove(c.position)
        if ((c.position - start).getDistance() > slop) return true
        val f = awaitPointerEvent(PointerEventPass.Final).changes.firstOrNull { it.id == id } ?: return true
        if (f.isConsumed || !f.pressed) return true
    }
}

/** Consumes every event of pointer `id` (nothing under it sees them) until it is up; returns true then. */
private suspend fun AwaitPointerEventScope.follow(id: PointerId, onMove: (Offset) -> Unit): Boolean {
    while (true) {
        val e = awaitPointerEvent(PointerEventPass.Initial)
        val c = e.changes.firstOrNull { it.id == id }
        e.changes.forEach { it.consume() }
        if (c == null || !c.pressed) return true
        onMove(c.position)
    }
}
