package com.lukasbaxter.slopify.android.app

import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.activity.OnBackPressedDispatcherOwner
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.lukasbaxter.slopify.android.design.components.SwipeToQueue
import com.lukasbaxter.slopify.android.design.theme.Motion
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min

/**
 * One tab's pages as the shell draws them (ios NavigationStack per tab): every page stays
 * composed while it is on the stack, so going back finds it as it was; only the top page (and the
 * one below it during a transition) is placed. The navigator is the truth; this follows it with
 * the push / pop animations and the interactive gestures (Library swipe-back, Home list
 * swipe-down, predictive back).
 */
@Stable
internal class PageStack(val tab: Tab, private val scope: CoroutineScope) {
    /** The navigator's stack, plus the page animating out (on top) while it does. */
    var entries by mutableStateOf<List<StackEntry>>(emptyList())
        private set
    var leaving by mutableStateOf<StackEntry?>(null)
        private set
    /** The top page's place: 1 = in, 0 = gone (slid right, or back in its tile). */
    val progress = Animatable(1f)
    /** A finger (or the back gesture) drives the top page. */
    var interactive by mutableStateOf(false)
        private set
    /** Home list dragged down / shrinking with predictive back: where it is now (px). Null = full screen. */
    var pull by mutableStateOf<Rect?>(null)
        private set
    /** Where a leaving Home list zooms back from (its rect when let go). */
    var zoomFrom by mutableStateOf<Rect?>(null)
        private set

    private var navStack: List<StackEntry> = emptyList()
    private var anim: Job? = null

    val top: StackEntry? get() = entries.lastOrNull()
    val transitioning: Boolean get() = leaving != null || interactive || pull != null || progress.value < 1f || progress.isRunning

    /** Follow the navigator. `animate`: this tab is lit and stayed lit. */
    fun sync(stack: List<StackEntry>, animate: Boolean) {
        val change = StackChange.of(navStack, stack)
        navStack = stack
        when (change) {
            StackChange.None -> Unit
            is StackChange.Push -> {
                finish()
                entries = stack
                if (animate) animate { progress.snapTo(0f); progress.animateTo(1f, enterSpec(change.entry)) }
                else animate { progress.snapTo(1f) }
            }
            is StackChange.Pop -> {
                finish(keepProgress = true)
                if (!animate) {
                    entries = stack
                    animate { progress.snapTo(1f) }
                    return
                }
                val l = change.leaving
                if (l.fromHome && zoomFrom == null) zoomFrom = pull
                pull = null
                leaving = l
                entries = stack + l
                animate {
                    progress.animateTo(0f, exitSpec(l))
                    leaving = null
                    entries = navStack
                    zoomFrom = null
                    interactive = false
                    progress.snapTo(1f)
                }
            }
            StackChange.Replace -> {
                finish()
                entries = stack
            }
        }
    }

    // Interactive: the finger or the back gesture holds the top page.

    /** False while a page is already leaving. */
    fun beginInteractive(): Boolean {
        if (leaving != null) return false
        anim?.cancel()
        interactive = true
        return true
    }

    /** Library swipe-back / predictive back on a pushed page: the page follows. */
    fun drag(p: Float) {
        if (!interactive) return
        animate { progress.snapTo(p.coerceIn(0f, 1f)) }
    }

    /** Home list: dragged down or shrinking. */
    fun pullTo(rect: Rect?) {
        if (!interactive) return
        pull = rect
    }

    /** Let go without leaving: back in place. */
    fun cancelInteractive() {
        if (!interactive) return
        val from = pull
        animate {
            if (from != null) {
                Animatable(0f).animateTo(1f, Motion.snapBack()) { pull = ShellMotion.lerp(from, fullRect, value) }
                pull = null
            }
            progress.animateTo(1f, Motion.snapBack())
            interactive = false
        }
    }

    /** The full-screen rect pages fill (px), set by the shell. */
    var fullRect: Rect = Rect.Zero
    /** The Home tab's tiles (only the Home stack has them). */
    var sources: HomeZoomSources? = null

    private fun animate(block: suspend CoroutineScope.() -> Unit) {
        anim?.cancel()
        anim = scope.launch(block = block)
    }

    /** Jump a running transition to its end. */
    private fun finish(keepProgress: Boolean = false) {
        anim?.cancel()
        if (leaving != null) {
            leaving = null
            zoomFrom = null
            scope.launch { progress.snapTo(1f) }
            interactive = false
        } else if (!keepProgress) {
            interactive = false
            pull = null
        }
    }

    private fun enterSpec(e: StackEntry): AnimationSpec<Float> = if (e.fromHome) Motion.nowPlayingIn() else Motion.sheet(200)
    private fun exitSpec(e: StackEntry): AnimationSpec<Float> = if (e.fromHome) Motion.sheet(280) else Motion.sheet(220)
}

/** A page's scroll, seen from outside it: at its top or not (ios `isAtTop`). */
internal class PageScroll(private val density: Density) : NestedScrollConnection {
    /** How far the page's list is scrolled down (px), from the nested-scroll deltas. */
    var scrolled by mutableFloatStateOf(0f)
        private set
    /** Optional: a downward pull at the top goes here (Home list swipe-down). */
    var dismiss: ShellDragDismiss? = null

    val atTop: Boolean get() = ShellMotion.isAtTop(with(density) { scrolled.toDp().value })

    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset =
        dismiss?.preScroll(available, source) ?: Offset.Zero

    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
        scrolled = max(0f, scrolled - consumed.y)
        return dismiss?.postScroll(available, source) ?: Offset.Zero
    }

    override suspend fun onPreFling(available: Velocity): Velocity = dismiss?.preFling(available) ?: Velocity.Zero
}

/** Back callbacks of pages that are not showing go nowhere (a hidden page must not eat back). */
private class InertBackOwner(lifecycle: Lifecycle) : OnBackPressedDispatcherOwner {
    override val onBackPressedDispatcher = OnBackPressedDispatcher()
    override val lifecycle: Lifecycle = lifecycle
}

/** Draws one tab: its root and pages, the top one placed (two during a transition). */
@Composable
internal fun TabStack(
    stack: PageStack,
    lit: Boolean,
    zoom: HomeZoomSources?,
    nav: Navigator,
    root: @Composable () -> Unit,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val inert = remember(lifecycle) { InertBackOwner(lifecycle) }
    val entries = stack.entries
    val leaving = stack.leaving
    CompositionLocalProvider(LocalHomeZoom provides zoom) {
        Box(Modifier.fillMaxSize()) {
            val count = entries.size
            for (i in -1 until count) {
                val e = if (i >= 0) entries[i] else null
                key(e?.id ?: ROOT_KEY) {
                    val isTop = i == count - 1
                    val isBelow = i == count - 2
                    val placed = { lit && (isTop || (isBelow && stack.transitioning)) }
                    val active = lit && isTop && leaving == null
                    PageSlot(stack, e, isTop, placed, active, inert, nav) {
                        if (e == null) root() else RouteDestination(e.route)
                    }
                }
            }
        }
    }
}

@Composable
private fun PageSlot(
    stack: PageStack,
    entry: StackEntry?,
    isTop: Boolean,
    placed: () -> Boolean,
    active: Boolean,
    inert: OnBackPressedDispatcherOwner,
    nav: Navigator,
    content: @Composable () -> Unit,
) {
    val real = LocalOnBackPressedDispatcherOwner.current
    val density = LocalDensity.current
    val scroll = remember { PageScroll(density) }
    val zoomPage = entry?.fromHome == true
    val dismiss = remember(zoomPage) {
        if (!zoomPage) null else ShellDragDismiss(density, object : ShellDragDismiss.Target {
            override fun begin() = stack.top == entry && stack.beginInteractive()
            override fun moved(dyPx: Float) = stack.pullTo(ShellMotion.pulledRect(stack.fullRect, dyPx))
            override fun released(commit: Boolean) { if (commit) nav.pop() else stack.cancelInteractive() }
        })
    }
    scroll.dismiss = dismiss
    val library = stack.tab == Tab.Library && entry != null
    var mod = Modifier
        .fillMaxSize()
        .layout { m, c ->
            val p = m.measure(c)
            layout(p.width, p.height) { if (placed()) p.place(0, 0) }
        }
    // Gestures sit outside the moving layer: they measure the finger on the screen, not on the
    // page that follows it.
    if (dismiss != null) mod = mod.then(dismiss.dragModifier())
    if (library) mod = mod.librarySwipeBack(stack, scroll, isTop, nav)
    mod = mod
        .graphicsLayer {
            val full = stack.fullRect
            if (isTop && entry != null && entry.fromHome && full.width > 0) {
                // Zoom: the page is drawn inside a rect between its tile and the screen.
                val target = if (stack.leaving == entry) stack.zoomFrom ?: full else stack.pull ?: full
                val source = stack.sourceFor(entry)
                val r = ShellMotion.lerp(source, target, stack.progress.value)
                val s = r.width / full.width
                transformOrigin = TransformOrigin(0f, 0f)
                scaleX = s; scaleY = s
                translationX = r.left; translationY = r.top
                alpha = ShellMotion.zoomAlpha(stack.progress.value)
                val radius = if (r == full) 0f else 16.dp.toPx() / max(s, 0.01f)
                shape = ClipRect(r.height / max(s, 0.01f), radius)
                clip = true
            } else if (isTop && entry != null) {
                translationX = ShellMotion.slideX(stack.progress.value, size.width)
            } else if (stack.top?.fromHome != true) {
                // The page under a sliding page moves a little with it.
                val topSliding = stack.transitioning
                translationX = if (topSliding) ShellMotion.belowX(stack.progress.value, size.width) else 0f
            }
        }
        .nestedScroll(scroll)
    Box(mod) {
        CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides (if (active && real != null) real else inert)) { content() }
    }
}

/** Where a Home list zooms from: its tile, else the middle of the screen. */
internal fun PageStack.sourceFor(entry: StackEntry): Rect =
    sources?.rect(entry.route) ?: ShellMotion.fallbackSource(fullRect)

/** Rounded clip of the zoomed page, in its own (unscaled) coordinates. */
private class ClipRect(private val height: Float, private val radius: Float) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val h = min(size.height, height)
        return if (radius <= 0f) Outline.Rectangle(Rect(0f, 0f, size.width, h))
        else Outline.Rounded(RoundRect(0f, 0f, size.width, h, CornerRadius(radius)))
    }
}

/**
 * Library swipe-back (ios LibrarySwipeBack): a left-to-right drag in the top half of a page
 * opened from Your Library pops it, interactively, while the page is scrolled to its top. Runs
 * after the page's own handlers, so a track row's swipe-to-queue (which takes the touch) wins.
 */
private fun Modifier.librarySwipeBack(stack: PageStack, scroll: PageScroll, isTop: Boolean, nav: Navigator): Modifier =
    pointerInput(stack, isTop) {
        if (!isTop) return@pointerInput
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            val startX = down.position.x / density
            if (startX < SwipeToQueue.EDGE_GUARD) return@awaitEachGesture
            if (down.position.y >= size.height / 2f || !scroll.atTop || stack.leaving != null) return@awaitEachGesture
            val velocity = VelocityTracker()
            velocity.addPosition(down.uptimeMillis, down.position)
            var began = false
            var dx = 0f
            try {
                while (true) {
                    val ev = awaitPointerEvent()
                    val c = ev.changes.firstOrNull { it.id == down.id } ?: break
                    if (!c.pressed) break
                    velocity.addPosition(c.uptimeMillis, c.position)
                    val tr = c.position - down.position
                    if (!began) {
                        if (tr.getDistance() < viewConfiguration.touchSlop) {
                            if (c.isConsumed) return@awaitEachGesture
                            continue
                        }
                        val ok = ShellMotion.swipeBackMayBegin(
                            isLibraryTab = nav.state.value.tab == Tab.Library,
                            stackCount = nav.state.value.stack(Tab.Library).size,
                            startX = startX,
                            startY = down.position.y,
                            screenHeight = size.height.toFloat(),
                            direction = tr,
                            scrollAtTop = scroll.atTop,
                            consumedByChild = c.isConsumed,
                        )
                        if (!ok) return@awaitEachGesture
                        if (!stack.beginInteractive()) return@awaitEachGesture
                        began = true
                    }
                    c.consume()
                    dx = max(0f, tr.x)
                    stack.drag(1 - dx / size.width)
                }
            } finally {
                if (began) {
                    val v = velocity.calculateVelocity().x / density
                    if (ShellMotion.swipeBackCommits(dx, size.width.toFloat(), v)) nav.pop() else stack.cancelInteractive()
                }
            }
        }
    }

private const val ROOT_KEY = -1L
