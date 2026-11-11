package com.lukasbaxter.slopify.android.app

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.Velocity
import com.lukasbaxter.slopify.android.design.theme.Motion
import kotlinx.coroutines.launch

/**
 * A full-screen layer above the tabs (now playing, the queue; ios fullScreenCover): rises from
 * the bottom (0.3 s), slides down to close (0.25 s), follows a swipe down and closes past the
 * now-playing thresholds. System back closes it (its handler sits above the tab stacks').
 * Touches never fall through to the pages below.
 */
@Composable
internal fun ShellLayer(open: Boolean, onClose: () -> Unit, content: @Composable () -> Unit) {
    val height = LocalWindowInfo.current.containerSize.height.toFloat().coerceAtLeast(1f)
    val offset = remember { Animatable(height) }
    var present by remember { mutableStateOf(open) }
    var leaving by remember { mutableStateOf(false) }
    val close by rememberUpdatedState(onClose)
    val scope = rememberCoroutineScope()
    LaunchedEffect(open) {
        if (open) {
            present = true
            leaving = false
            offset.animateTo(0f, Motion.nowPlayingIn())
        } else if (present) {
            leaving = true
            offset.animateTo(height, Motion.sheetOut())
            present = false
            leaving = false
        } else {
            offset.snapTo(height)
        }
    }
    if (!present) return
    BackHandler(enabled = open && !leaving) { close() }
    val density = LocalDensity.current
    val dismiss = remember {
        ShellDragDismiss(density, object : ShellDragDismiss.Target {
            override fun begin() = !leaving && !offset.isRunning
            override fun moved(dyPx: Float) { scope.launch { offset.snapTo(dyPx) } }
            override fun released(commit: Boolean) {
                scope.launch {
                    if (commit) {
                        leaving = true
                        offset.animateTo(height, Motion.sheet(250))
                        close()
                    } else {
                        offset.animateTo(0f, Motion.snapBack())
                    }
                }
            }
        })
    }
    val connection = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource) = dismiss.preScroll(available, source) ?: Offset.Zero
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource) = dismiss.postScroll(available, source) ?: Offset.Zero
            override suspend fun onPreFling(available: Velocity) = dismiss.preFling(available) ?: Velocity.Zero
        }
    }
    // No background of its own: a screen that slides itself out first leaves nothing behind.
    Box(
        Modifier
            .fillMaxSize()
            .graphicsLayer { translationY = offset.value }
            .nestedScroll(connection)
            .then(dismiss.dragModifier()),
    ) { content() }
}
