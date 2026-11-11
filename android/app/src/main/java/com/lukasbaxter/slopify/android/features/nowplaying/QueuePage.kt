package com.lukasbaxter.slopify.android.features.nowplaying

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.components.rememberTrackMenuBuilder
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.player.PlayerState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.min

private const val QUEUE_ROW_HEIGHT = 64f

/** Rows of a queue section, `pos` = absolute queue index. */
internal data class QueueSections(val nowPlaying: Int?, val queued: IntRange, val context: IntRange, val endOfQueue: Boolean) {
    companion object {
        /** Now playing / Next in queue (the `_queued` run after it) / Next from (at most 80). */
        fun of(p: PlayerState): QueueSections {
            val q = p.queue
            val idx = p.index
            val base = idx + 1
            var split = 0
            while (base + split < p.queuedFlags.size && base + split < q.size && p.queuedFlags[base + split]) split++
            val ctxStart = base + split
            val ctx = if (ctxStart < q.size) ctxStart until min(q.size, ctxStart + 80) else IntRange.EMPTY
            return QueueSections(
                nowPlaying = idx.takeIf { it in q.indices },
                queued = base until base + split,
                context = ctx,
                endOfQueue = split == 0 && ctxStart >= q.size,
            )
        }
    }
}

/**
 * The phone queue page (UI.md 3.3; RightPanel.jsx:43-262, 433-484; ios QueueView.swift). The
 * theme's own tokens (no dark island). Just the list (web v0.1.177: no pinned transport).
 * Reorder by the drag handle; remove from the long-press sheet; swipe down from the header or
 * the list at its top closes it.
 */
@Composable
internal fun QueuePage() {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val ps = rememberNowPlayingSession()
    val p = ps.player
    val from = rememberNowPlayingFrom(p.context)
    val builder = rememberTrackMenuBuilder { }
    var menu by remember { mutableStateOf<MenuSheet?>(null) }
    // Drag to reorder: absolute queue index lifted, finger travel (dp), target slot.
    var dragFrom by remember { mutableStateOf<Int?>(null) }
    var dragDY by remember { mutableFloatStateOf(0f) }
    var dragTo by remember { mutableStateOf<Int?>(null) }
    var dismissing by remember { mutableStateOf(false) }
    var headerBottom by remember { mutableFloatStateOf(0f) }
    var rootTop by remember { mutableFloatStateOf(0f) }
    var pageHeight by remember { mutableIntStateOf(0) }
    val drag = remember { Animatable(0f) }
    val scroll = rememberScrollState()

    fun close() {
        app.nav.setQueueOpen(false)
        app.nav.setNowPlayingOpen(false)
    }

    fun openMenu(t: Track, pos: Int, current: Boolean) {
        menu = NowPlayingMenus(app, builder, scope).queueRow(t, pos, removable = !current)
    }

    Box(
        Modifier.fillMaxSize()
            .onGloballyPositioned { rootTop = it.positionInRoot().y; pageHeight = it.size.height }
            .npSwipeDown(
                allowed = { y ->
                    // A reorder drag has lifted its row by now (its handle takes the touch at once).
                    val ok = menu == null && NowPlayingMath.queueSwipeDismissAllowed(
                        y, headerBottom, scroll.value / density.density, onHandle = dragFrom != null,
                    )
                    if (ok) dismissing = true
                    ok
                },
                onDrag = { dy -> scope.launch { drag.snapTo(dy) } },
                onEnd = { dy, elapsed ->
                    dismissing = false
                    scope.launch {
                        if (NowPlayingMath.dismissesNowPlaying(with(density) { dy.toDp().value }, elapsed)) {
                            launch { drag.animateTo(pageHeight.toFloat(), Motion.sheet(250)) }
                            delay(200)
                            close()
                        } else {
                            drag.animateTo(0f, Motion.sheet(250))
                        }
                    }
                },
            ),
    ) {
        Column(Modifier.fillMaxSize().graphicsLayer { translationY = drag.value }.background(theme.page)) {
            QueueHeader(from, ::close, Modifier.statusBarsPadding().onGloballyPositioned { headerBottom = it.boundsInRoot().bottom - rootTop })
            Column(
                Modifier.fillMaxWidth().weight(1f)
                    .verticalScroll(scroll, enabled = dragFrom == null && !dismissing)
                    // The list is the whole page: no space kept for a transport (.panel-body 8 16 24).
                    .padding(top = 8.dp, start = 16.dp, end = 16.dp, bottom = 24.dp)
                    .navigationBarsPadding(),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                val q = p.queue
                if (q.isEmpty()) {
                    Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(L("Add to your queue"), style = TextStyles.bodyBold, color = theme.fg)
                        Text(L("Play an album or playlist, or use “Add to queue” on any song."), style = TextStyles.subLine, color = theme.fgSub, textAlign = TextAlign.Center)
                    }
                    return@Column
                }
                val sections = QueueSections.of(p)
                @Composable
                fun row(pos: Int, current: Boolean) = key(pos) {
                    val lifted = dragFrom == pos
                    val f = dragFrom
                    val to = dragTo
                    val shiftTarget = if (f != null && to != null && !lifted) NowPlayingMath.reorderShift(pos, f, to, QUEUE_ROW_HEIGHT) else 0f
                    val shift by animateFloatAsState(shiftTarget, if (dragFrom == null) snap() else tween(150), label = "shift")
                    QueueRow(
                        q[pos], pos, current,
                        rec = p.recFlags.getOrNull(pos) == true,
                        lifted = lifted,
                        offsetY = if (lifted) dragDY else shift,
                        canMenu = dragFrom == null,
                        onMenu = { openMenu(q[pos], pos, current) },
                        onDragStart = { dragFrom = pos; dragTo = pos; dragDY = 0f },
                        onDrag = { dy ->
                            dragDY = dy
                            dragTo = NowPlayingMath.reorderTarget(pos, dy, QUEUE_ROW_HEIGHT, app.player.state.value.index, app.player.state.value.queue.size)
                        },
                        onDragEnd = {
                            val a = dragFrom
                            val b = dragTo
                            if (a != null && b != null && a != b) app.player.moveInQueue(a, b)
                            dragFrom = null; dragTo = null; dragDY = 0f
                        },
                    )
                }
                sections.nowPlaying?.let { idx -> QueueSection(L("Now playing")) { row(idx, current = true) } }
                if (!sections.queued.isEmpty()) {
                    QueueSection(L("Next in queue"), L("Clear queue") to { app.player.clearQueued() }) {
                        for (i in sections.queued) row(i, current = false)
                    }
                }
                if (!sections.context.isEmpty()) {
                    QueueSection(if (p.context != null) L("Next from: {name}", "name" to from.name) else L("Next up")) {
                        for (i in sections.context) row(i, current = false)
                    }
                }
                if (sections.endOfQueue) {
                    Text(L("End of the queue."), Modifier.padding(vertical = 12.dp), style = TextStyles.subLine, color = theme.fgSub)
                }
            }
        }
    }
    ContextMenuSheet(menu) { menu = null }
}

// Header (.panel-header)

@Composable
private fun QueueHeader(from: NowPlayingFrom, close: () -> Unit, modifier: Modifier) {
    val theme = LocalTheme.current
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).padding(top = 4.dp, start = 16.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        NowPlayingTapTarget(L("Close panel"), onClick = close) { IconView(Icon.ChevronDown, size = 24.dp, tint = theme.fg) }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(from.kind.uppercase(), style = NowPlayingType.fromKind, color = theme.fg(0.7), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(from.name, style = NowPlayingType.fromName, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.size(44.dp))
    }
}

@Composable
private fun QueueSection(title: String, action: Pair<String, () -> Unit>? = null, rows: @Composable () -> Unit) {
    val theme = LocalTheme.current
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 32.dp).padding(bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f), style = TextStyles.bodyBold, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            action?.let { (label, run) ->
                Text(
                    label, style = TextStyles.subLine.copy(fontWeight = FontWeight.Bold), color = theme.fg,
                    modifier = Modifier.pressable(PressFeedback.Fade, onTap = run).padding(vertical = 8.dp),
                )
            }
        }
        rows()
    }
}

// Row (.qrow)

@Composable
private fun QueueRow(
    t: Track,
    pos: Int,
    current: Boolean,
    rec: Boolean,
    lifted: Boolean,
    offsetY: Float,
    canMenu: Boolean,
    onMenu: () -> Unit,
    onDragStart: () -> Unit,
    onDrag: (dy: Float) -> Unit,
    onDragEnd: () -> Unit,
) {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val density = LocalDensity.current
    var handle by remember { mutableStateOf<LayoutCoordinates?>(null) }
    val rowShape = RoundedCornerShape(Radius.row)
    Row(
        Modifier.fillMaxWidth()
            .zIndex(if (lifted) 3f else 0f)
            .graphicsLayer { translationY = offsetY * density.density }
            .then(
                if (lifted) Modifier.npBleed(8.dp).shadow(12.dp, rowShape, ambientColor = Color.Black, spotColor = Color.Black)
                    .background(theme.sheet, rowShape).padding(horizontal = 8.dp)
                else Modifier,
            )
            .heightIn(min = Shell.trackRow)
            .pressable(PressFeedback.Row, onLongPress = if (canMenu) onMenu else null),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val play = L("Play")
        CoverImage(
            NowPlayingCover.source(t), 48.dp,
            Modifier.size(48.dp).pressable(PressFeedback.None) { app.player.skipTo(pos) }.semantics { contentDescription = play },
            shape = CoverShape.Rounded(Radius.art), placeholder = CoverPlaceholder.CardHover,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(
                Modifier.pressable(PressFeedback.None) { if (t.albumId.isNotEmpty()) app.nav.open(Route.Album(t.albumId)) },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                if (rec) IconView(Icon.SmartPick, size = 12.dp, tint = theme.accentInk)
                Text(t.title, style = TextStyles.rowTitle, color = if (current) theme.accentInk else theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            NowPlayingArtistLinks(t, TextStyles.subLine, theme.fgSub) { id -> app.nav.open(Route.Artist(id)) }
        }
        if (!current) {
            val label = L("Drag to reorder")
            Box(
                Modifier.npOutset(end = 12.dp).size(44.dp)
                    .onGloballyPositioned { handle = it }
                    .semantics { contentDescription = label }
                    .pointerInput(pos) {
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            down.consume()
                            // Root y: the row (and this handle) moves under the finger while lifted.
                            val y0 = handle?.takeIf { it.isAttached }?.localToRoot(down.position)?.y ?: down.position.y
                            onDragStart()
                            while (true) {
                                val e = awaitPointerEvent()
                                val c = e.changes.firstOrNull { it.id == down.id } ?: break
                                c.consume()
                                if (!c.pressed) break
                                val y = handle?.takeIf { it.isAttached }?.localToRoot(c.position)?.y ?: c.position.y
                                onDrag((y - y0) / density.density)
                            }
                            onDragEnd()
                        }
                    },
                contentAlignment = Alignment.Center,
            ) { IconView(Icon.Handle, size = 24.dp, tint = theme.fgSub) }
        }
    }
}
