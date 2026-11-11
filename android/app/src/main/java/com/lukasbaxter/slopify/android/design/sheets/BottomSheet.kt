package com.lukasbaxter.slopify.android.design.sheets

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.theme.Gestures
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.roundToInt

/** Where a sheet host is in its life: entering (not yet `appeared`), shown, or `leaving`. */
@Immutable
data class SheetPhase(val appeared: Boolean = false, val leaving: Boolean = false)

/** Closes the enclosing sheet host (all its sheets), then runs `then` once it is gone. */
fun interface SheetCloseAction {
    operator fun invoke(then: (() -> Unit)?)
    operator fun invoke() = invoke(null)
}

val LocalSheetPhase = compositionLocalOf { SheetPhase(appeared = true) }
/** Inside a bottom sheet or context menu: close it (`LocalCloseSheet.current { action() }`). */
val LocalCloseSheet = compositionLocalOf { SheetCloseAction { it?.invoke() } }

/**
 * Scrim plus the sheets of one presentation (UI.md 3.8, 5.5): black 60 % scrim fading in over
 * 0.2 s; tapping it closes everything and never falls through. Closing slides the sheets down
 * (0.25 s ease-in, the one dismiss for every sheet) and fades the scrim, then dismisses.
 * System back closes too.
 */
@Composable
fun SheetHost(dismiss: (then: (() -> Unit)?) -> Unit, content: @Composable () -> Unit) {
    var phase by remember { mutableStateOf(SheetPhase()) }
    val scope = rememberCoroutineScope()
    val onDismiss by rememberUpdatedState(dismiss)
    val close = remember {
        SheetCloseAction { then ->
            if (phase.leaving) return@SheetCloseAction
            phase = phase.copy(leaving = true)
            scope.launch { delay(Motion.SHEET_OUT_MS.toLong()); onDismiss(then) }
        }
    }
    LaunchedEffect(Unit) { phase = phase.copy(appeared = true) }
    val scrim by animateFloatAsState(if (phase.appeared && !phase.leaving) 1f else 0f, if (phase.leaving) Motion.sheetOut() else Motion.sheetIn(), label = "scrim")
    BackHandler { close() }
    Box(Modifier.fillMaxSize()) {
        val closeLabel = L("Close")
        Box(
            Modifier.fillMaxSize().alpha(scrim).background(Theme.Fixed.sheetScrim)
                .clickable(remember { MutableInteractionSource() }, indication = null) { close() }
                .semantics { contentDescription = closeLabel },
        )
        CompositionLocalProvider(LocalSheetPhase provides phase, LocalCloseSheet provides close) { content() }
    }
}

/**
 * One sheet panel: pinned to the bottom, top radius 16, `--sheet`, shadow `0 -8 40 .6`, padding
 * 12 8 (24 + bottom inset), at most 80 % of the screen (content scrolls inside), 36x4 grabber
 * 6 from the top. Enters from +40 with a fade (0.2 s); sub-sheets (`sub`) appear without
 * animation, are at least 45 % tall and are not draggable. Drag down: follows the finger;
 * closes past 100, or 40 within 300 ms; else snaps back.
 */
@Composable
fun BottomSheetFrame(sub: Boolean = false, content: @Composable () -> Unit) {
    val theme = LocalTheme.current
    val phase = LocalSheetPhase.current
    val closeSheet = LocalCloseSheet.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val bornShown = remember { phase.appeared }
    val enterPx = with(density) { 40.dp.toPx() }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val screenPx = constraints.maxHeight.toFloat()
        val offset = remember { Animatable(if (sub || bornShown) 0f else enterPx) }
        val fade = remember { Animatable(if (sub || bornShown) 1f else 0f) }
        var drag by remember { mutableStateOf(0f) }
        var dragStart by remember { mutableStateOf<Long?>(null) }
        LaunchedEffect(phase.appeared) {
            if (phase.appeared && !sub && !bornShown) {
                launch { offset.animateTo(0f, Motion.sheetIn()) }
                fade.animateTo(1f, Motion.sheetIn())
            }
        }
        LaunchedEffect(phase.leaving) { if (phase.leaving) offset.animateTo(screenPx, Motion.sheetOut()) }

        fun settle() {
            val start = dragStart ?: return
            dragStart = null
            val dyDp = with(density) { drag.toDp().value }
            if (Gestures.sheetShouldDismiss(dyDp, (System.nanoTime() - start) / 1_000_000)) closeSheet()
            else scope.launch { drag = 0f; offset.animateTo(0f, Motion.snapBack()) }
        }
        // Drags reach the sheet through the content's scroll: down at the top moves the sheet.
        val connection = remember(sub) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    if (sub || drag <= 0f || available.y >= 0f || phase.leaving) return Offset.Zero
                    val use = max(available.y, -drag)
                    drag += use
                    scope.launch { offset.snapTo(drag) }
                    return Offset(0f, use)
                }

                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                    if (sub || available.y <= 0f || source != NestedScrollSource.UserInput || phase.leaving) return Offset.Zero
                    if (dragStart == null) dragStart = System.nanoTime()
                    drag += available.y
                    scope.launch { offset.snapTo(drag) }
                    return Offset(0f, available.y)
                }
            }
        }
        val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
        val maxH = with(density) { (screenPx * 0.8f).toDp() }
        val minH = if (sub) with(density) { (screenPx * 0.45f).toDp() } else 0.dp
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .offset { IntOffset(0, offset.value.roundToInt()) }
                .graphicsLayer { alpha = fade.value }
                .shadow(if (phase.leaving) 0.dp else 20.dp, RoundedCornerShape(topStart = Radius.sheet, topEnd = Radius.sheet), ambientColor = Color.Black, spotColor = Color.Black)
                .clip(RoundedCornerShape(topStart = Radius.sheet, topEnd = Radius.sheet))
                .background(theme.sheet)
                .heightIn(min = minH, max = maxH)
                // a tap on the sheet never reaches the scrim
                .clickable(remember { MutableInteractionSource() }, indication = null) {}
                .pointerInput(sub) {
                    if (sub) return@pointerInput
                    awaitPointerEventScope {
                        while (true) {
                            val e = awaitPointerEvent(PointerEventPass.Final)
                            if (e.changes.all { !it.pressed }) settle()
                        }
                    }
                }
                .nestedScroll(connection),
        ) {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(top = 12.dp, start = 8.dp, end = 8.dp, bottom = 24.dp + navBottom)) {
                content()
            }
            if (!sub) {
                Box(Modifier.align(Alignment.TopCenter).padding(top = 6.dp).size(36.dp, 4.dp).background(theme.fg(0.25), RoundedCornerShape(2.dp)))
            }
        }
    }
}

/**
 * A generic bottom sheet over everything (device sheet, sleep timer) while `item` is non-null.
 * Inside, close with `LocalCloseSheet.current { then() }`.
 */
@Composable
fun <T : Any> BottomSheet(item: T?, onDismiss: () -> Unit, content: @Composable (T) -> Unit) {
    OverlayCover(item, onDismiss) { it, dismiss ->
        SheetHost(dismiss) { BottomSheetFrame { content(it) } }
    }
}

/** Boolean form of [BottomSheet]. */
@Composable
fun BottomSheet(visible: Boolean, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    BottomSheet(if (visible) Unit else null, onDismiss) { content() }
}
