package com.lukasbaxter.slopify.android.features.nowplaying

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.offset
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max

/**
 * SwiftUI's negative padding: the content is offered `start + end` / `top + bottom` more room and
 * spills past these sides, while the layout reports the smaller size.
 */
internal fun Modifier.npOutset(start: Dp = 0.dp, top: Dp = 0.dp, end: Dp = 0.dp, bottom: Dp = 0.dp): Modifier = layout { m, c ->
    val s = start.roundToPx()
    val t = top.roundToPx()
    val h = s + end.roundToPx()
    val v = t + bottom.roundToPx()
    val p = m.measure(c.offset(h, v))
    layout(max(0, p.width - h), max(0, p.height - v)) { p.place(-s, -t) }
}

/** Grows the content by `by` on both sides beyond the width offered (a lifted queue row). */
internal fun Modifier.npBleed(by: Dp): Modifier = layout { m, c ->
    val e = by.roundToPx()
    val maxW = if (c.hasBoundedWidth) c.maxWidth + 2 * e else c.maxWidth
    val p = m.measure(c.copy(minWidth = (c.minWidth + 2 * e).coerceAtMost(maxW), maxWidth = maxW))
    layout(max(0, p.width - 2 * e), p.height) { p.place(-e, 0) }
}

/** A 44 dp (or `size`) tap target with the fade press look. */
@Composable
internal fun NowPlayingTapTarget(
    label: String,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    enabled: Boolean = true,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Box(
        modifier.size(size)
            .pressable(PressFeedback.Fade, enabled = enabled, onTap = onClick)
            .semantics { contentDescription = label; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) { content() }
}

/**
 * Swipe down to close (App.jsx:1451-1480). Watches in the Initial pass, so once the drag is
 * judged a close (10 dp, downward, more vertical than horizontal, `allowed(startY)`) it takes the
 * touch from children (buttons, scroll views). `allowed` is asked once per gesture, after the
 * slop, with the touch-down y in this element's pixels. `onEnd` gets dy (px) and the seconds
 * since the drag began.
 */
@Composable
internal fun Modifier.npSwipeDown(
    allowed: (startY: Float) -> Boolean,
    onDrag: (dy: Float) -> Unit,
    onEnd: (dy: Float, elapsed: Double) -> Unit,
): Modifier {
    val allow by rememberUpdatedState(allowed)
    val drag by rememberUpdatedState(onDrag)
    val end by rememberUpdatedState(onEnd)
    return pointerInput(Unit) {
        val slop = 10.dp.toPx()
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            var dragging = false
            var t0 = 0L
            var last = 0f
            while (true) {
                val e = awaitPointerEvent(PointerEventPass.Initial)
                val c = e.changes.firstOrNull { it.id == down.id }
                if (c == null) {
                    if (dragging) end(last, Double.MAX_VALUE)
                    break
                }
                val dx = c.position.x - down.position.x
                val dy = c.position.y - down.position.y
                if (!c.pressed) {
                    if (dragging) end(dy, (c.uptimeMillis - t0) / 1000.0)
                    break
                }
                if (!dragging) {
                    if (c.isConsumed) break
                    if (hypot(dx, dy) < slop) continue
                    if (dy > 0 && abs(dx) < dy && allow(down.position.y)) {
                        dragging = true
                        t0 = c.uptimeMillis
                    } else {
                        break
                    }
                }
                c.consume()
                last = max(0f, dy)
                drag(last)
            }
        }
    }
}

/** The live playhead (seconds), re-read every `intervalMs` while playing; the reported position when paused. */
@Composable
internal fun rememberNowPlayingPosition(intervalMs: Long = 250): Double {
    val player = LocalAppModel.current.player
    val state by player.state.collectAsStateWithLifecycle()
    val progress by player.progress.collectAsStateWithLifecycle()
    var now by remember { mutableDoubleStateOf(player.positionNow()) }
    LaunchedEffect(state.isPlaying, progress.tick, intervalMs) {
        now = player.positionNow()
        if (!state.isPlaying) return@LaunchedEffect
        while (true) {
            delay(intervalMs)
            now = player.positionNow()
        }
    }
    return if (state.isPlaying) now else progress.position
}
