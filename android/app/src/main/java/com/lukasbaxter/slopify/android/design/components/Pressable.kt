package com.lukasbaxter.slopify.android.design.components

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.lukasbaxter.slopify.android.design.theme.Gestures
import com.lukasbaxter.slopify.android.design.theme.LocalTheme

/** Press feedback styles (UI.md 2.8 "Touch feel", 6.0.3). */
enum class PressFeedback {
    /** Rows, shortcut tiles, menu items: background `rgba(fg,.08)` while pressed. */
    Row,
    /** Icon buttons, tab bar, transport: opacity .6. */
    Fade,
    /** Cards and tiles: artwork dims to brightness .8 (put [pressDim] on the art). */
    Dim,
    None,
}

/** Whether the enclosing [pressable] is held, for custom press looks ([pressDim]). */
@Stable
class PressState {
    var pressed by mutableStateOf(false)
        internal set
}

/** The web's `navigator.vibrate(10)`. */
object Haptics {
    /** The menu long-press. */
    fun menu(h: HapticFeedback) = h.performHapticFeedback(HapticFeedbackType.LongPress)
    /** A light tick (swipe armed). */
    fun tick(h: HapticFeedback) = h.performHapticFeedback(HapticFeedbackType.TextHandleMove)
}

/**
 * Tap + long-press for anything that has a context menu (UI.md 2.8; ios Pressable.swift): hold
 * still 450 ms (moving 10 dp cancels) opens the menu with a haptic, and the lift after it does
 * not count as a tap. `onTouchDown` fires as the finger lands (stream pre-warm). A scroll that
 * takes the touch cancels the press. A child that handles the tap (a "more" button) wins.
 *
 *     Modifier.pressable(PressFeedback.Row, onTap = play, onLongPress = openMenu, onTouchDown = prewarm)
 */
fun Modifier.pressable(
    feedback: PressFeedback = PressFeedback.Row,
    enabled: Boolean = true,
    state: PressState? = null,
    onLongPress: (() -> Unit)? = null,
    onTouchDown: (() -> Unit)? = null,
    onTap: (() -> Unit)? = null,
): Modifier = composed {
    val theme = LocalTheme.current
    val haptics = LocalHapticFeedback.current
    val press = state ?: remember { PressState() }
    val tap by rememberUpdatedState(onTap)
    val long by rememberUpdatedState(onLongPress)
    val down by rememberUpdatedState(onTouchDown)
    val hasLong = onLongPress != null
    this
        .semantics {
            role = Role.Button
            if (enabled && onTap != null) onClick { tap?.invoke(); true }
            if (enabled && hasLong) onLongClick { long?.invoke(); true }
        }
        .then(
            when (feedback) {
                PressFeedback.Row -> Modifier.drawBehind { if (press.pressed) drawRect(theme.fg(0.08)) }
                PressFeedback.Fade -> Modifier.graphicsLayer { alpha = if (press.pressed) 0.6f else 1f }
                PressFeedback.Dim, PressFeedback.None -> Modifier
            },
        )
        .pointerInput(enabled, hasLong) {
            if (!enabled) return@pointerInput
            val slop = Gestures.LONG_PRESS_SLOP.dp.toPx()
            awaitEachGesture {
                val first = awaitFirstDown(requireUnconsumed = false)
                press.pressed = true
                down?.invoke()
                var outcome = if (hasLong) withTimeoutOrNull(Gestures.LONG_PRESS_MS) { track(first.id, first.position, slop) } else track(first.id, first.position, slop)
                if (outcome == null) {
                    // Held still for 450 ms: the menu. Swallow the rest of this touch.
                    press.pressed = false
                    Haptics.menu(haptics)
                    long?.invoke()
                    do {
                        val e = awaitPointerEvent()
                        e.changes.forEach { it.consume() }
                    } while (e.changes.any { it.pressed })
                    outcome = PressOutcome.Cancel
                }
                press.pressed = false
                if (outcome == PressOutcome.Tap) tap?.invoke()
            }
        }
}

private enum class PressOutcome { Tap, Cancel }

/** Follows one finger until it lifts (a tap unless a child took it) or moves / is taken by a scroll. */
private suspend fun AwaitPointerEventScope.track(id: PointerId, start: Offset, slop: Float): PressOutcome {
    while (true) {
        val e = awaitPointerEvent(PointerEventPass.Main)
        val c = e.changes.firstOrNull { it.id == id } ?: return PressOutcome.Cancel
        if (!c.pressed) {
            if (c.isConsumed) return PressOutcome.Cancel
            c.consume()
            return PressOutcome.Tap
        }
        if ((c.position - start).getDistance() > slop) return PressOutcome.Cancel
        // A parent scroll consumes after us: look once it has had its turn.
        val after = awaitPointerEvent(PointerEventPass.Final)
        val f = after.changes.firstOrNull { it.id == id } ?: return PressOutcome.Cancel
        if (f.isConsumed) return PressOutcome.Cancel
    }
}

/** Card art: brightness .8 while `state` is pressed. */
fun Modifier.pressDim(state: PressState): Modifier =
    drawWithContent { drawContent(); if (state.pressed) drawRect(Color.Black.copy(alpha = 0.2f)) }

/** Long-press only (450 ms / 10 dp + haptic), for views that already handle taps. */
fun Modifier.onLongPressMenu(action: () -> Unit): Modifier = pressable(PressFeedback.None, onLongPress = action)
