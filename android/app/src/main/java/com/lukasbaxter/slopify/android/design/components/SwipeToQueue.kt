package com.lukasbaxter.slopify.android.design.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.theme.Gestures
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Swipe right on a track row to add it to the queue (Spotify iOS, owner 11-11; ios
 * SwipeToQueue.swift). The pure maths and gating live here so they are tested without a
 * finger. Distances in dp.
 */
object SwipeToQueue {
    /** Commit distance: 80, or a quarter of the row on narrow rows. */
    const val MAX_THRESHOLD = 80f
    const val WIDTH_SHARE = 0.25f
    /** Touches that start this close to the left screen edge belong to the system back swipe. */
    const val EDGE_GUARD = 20f
    /** Movement after which a vertical or leftward drag gives up at once, so the list scroll never waits on it. */
    const val DECIDE_SLOP = 6f

    fun threshold(width: Float): Float = if (width > 0) min(MAX_THRESHOLD, width * WIDTH_SHARE) else MAX_THRESHOLD

    /** Where the row is drawn for a finger `dx` to the right: 1:1 up to the threshold, then a rubber band below twice it. */
    fun displayOffset(dx: Float, threshold: Float): Float {
        if (dx <= 0 || threshold <= 0) return 0f
        if (dx <= threshold) return dx
        val over = dx - threshold
        return threshold + (1 - 1 / (over * 0.55f / threshold + 1)) * threshold
    }

    /** 0..1, drives the glyph's size and brightness. */
    fun progress(dx: Float, threshold: Float): Float = if (threshold > 0) min(1f, max(0f, dx / threshold)) else 0f

    fun isArmed(dx: Float, threshold: Float): Boolean = dx >= threshold

    /** Rightward and more horizontal than vertical (45 degrees). */
    fun isRightward(d: Offset): Boolean = d.x > 0 && d.x > abs(d.y)

    /** The early-fail rule while the drag is still deciding: vertical or leftward movement. */
    fun shouldFailEarly(translation: Offset): Boolean {
        val dx = translation.x; val dy = translation.y
        if (dx < -DECIDE_SLOP) return true
        return abs(dy) > DECIDE_SLOP && abs(dy) >= abs(dx)
    }

    /**
     * The swipe may begin: a queueable row, not from the screen edge, before the 450 ms menu
     * press, moving right. `translation` decides; velocity only when the finger has not moved.
     */
    fun shouldBegin(startX: Float, translation: Offset, velocity: Offset, heldForMs: Long, queueable: Boolean): Boolean {
        if (!queueable || startX < EDGE_GUARD || heldForMs >= Gestures.LONG_PRESS_MS) return false
        return isRightward(if (translation == Offset.Zero) velocity else translation)
    }

    /** Offline only downloaded songs can be queued (the track menu keeps "Add to queue" offline only when downloaded). */
    fun canQueue(offline: Boolean, downloaded: Boolean): Boolean = !offline || downloaded
}

/**
 * The row content follows the finger; a queue glyph grows in the gap on the left and turns
 * accent at the threshold (haptic tick); letting go past it runs `onQueue`. Springs back.
 * `queueable` is asked when a swipe starts (offline rule).
 */
@Composable
fun SwipeToQueueBox(
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    queueable: () -> Boolean = { true },
    onQueue: () -> Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val dx = remember { Animatable(0f) }
    var armed by remember { mutableStateOf(false) }
    var widthDp by remember { mutableFloatStateOf(0f) }
    var windowX by remember { mutableFloatStateOf(0f) }
    val canQueue by rememberUpdatedState(queueable)
    val queue by rememberUpdatedState(onQueue)
    val t = SwipeToQueue.threshold(widthDp)
    val shown = SwipeToQueue.displayOffset(dx.value, t)
    Box(
        modifier
            .onGloballyPositioned { c ->
                windowX = c.positionInWindow().x
                widthDp = with(density) { c.size.width.toDp().value }
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val startX = (windowX + down.position.x) / density.density
                    if (startX < SwipeToQueue.EDGE_GUARD) return@awaitEachGesture
                    var began = false
                    while (true) {
                        val e = awaitPointerEvent()
                        val c = e.changes.firstOrNull { it.id == down.id } ?: break
                        if (!c.pressed) break
                        val tr = (c.position - down.position) / density.density
                        if (!began) {
                            if (c.isConsumed || SwipeToQueue.shouldFailEarly(tr)) return@awaitEachGesture
                            if (tr.x <= SwipeToQueue.DECIDE_SLOP) continue
                            if (!SwipeToQueue.shouldBegin(startX, tr, Offset.Zero, c.uptimeMillis - down.uptimeMillis, canQueue())) return@awaitEachGesture
                            began = true
                        }
                        c.consume()
                        val x = max(0f, tr.x)
                        val now = SwipeToQueue.isArmed(x, SwipeToQueue.threshold(widthDp))
                        if (now && !armed) Haptics.tick(haptics)
                        armed = now
                        scope.launch { dx.snapTo(x) }
                    }
                    if (began) {
                        if (armed) queue()
                        armed = false
                        scope.launch { dx.animateTo(0f, spring(dampingRatio = 0.82f, stiffness = 438f)) }
                    }
                }
            },
    ) {
        if (shown > 0) {
            val p = SwipeToQueue.progress(dx.value, t)
            val tint by animateColorAsState(if (armed) theme.accent else theme.fgSub, tween(120), label = "queue")
            Box(Modifier.matchParentSize().clearAndSetSemantics {}) {
                Box(Modifier.width(shown.dp).fillMaxHeight().clipToBounds(), contentAlignment = Alignment.Center) {
                    IconView(Icon.Queue, Modifier.graphicsLayer { scaleX = 0.6f + 0.4f * p; scaleY = scaleX; alpha = 0.3f + 0.7f * p }, size = 24.dp, tint = tint)
                }
            }
        }
        Box(Modifier.offset { IntOffset((shown * density.density).roundToInt(), 0) }, content = content)
    }
}
