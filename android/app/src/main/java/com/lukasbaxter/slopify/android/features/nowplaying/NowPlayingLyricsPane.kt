package com.lukasbaxter.slopify.android.features.nowplaying

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.core.api.lyrics
import com.lukasbaxter.slopify.android.core.model.LyricJob
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.stores.LyricJobStore
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.image.LocalApiClient
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private enum class LyricsLoad { Idle, Loading, None, Ok }

/** A one-off jump to the top (a new song). */
private class LyricsJump

/** The now playing Lyrics tab body (RightPanel.jsx `Lyrics`; UI.md 3.2.5, 3.4; ios NowPlayingLyricsPane.swift). */
@Composable
internal fun NowPlayingLyricsPane(track: Track?, ps: NowPlayingSession, modifier: Modifier = Modifier) {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val api = LocalApiClient.current ?: app.account.api
    val player = app.player
    val revisions by app.lyricJobs.revision.collectAsStateWithLifecycle()
    val jobs by app.lyricJobs.jobs.collectAsStateWithLifecycle()
    val offline by app.connectivity.offline.collectAsStateWithLifecycle()
    val trackId = track?.id
    val revision = trackId?.let { revisions[it] } ?: 0
    val job = trackId?.let { jobs[it] }

    var state by remember { mutableStateOf(LyricsLoad.Idle) }
    var lines by remember { mutableStateOf(emptyList<NowPlayingLyricLine>()) }
    var activeIndex by remember { mutableIntStateOf(-1) }
    var manual by remember { mutableStateOf(false) }
    var jump by remember { mutableStateOf<LyricsJump?>(null) }
    // The line lit when this song's lyrics loaded: following starts from the next one.
    var loadIndex by remember { mutableStateOf<Int?>(null) }
    val reset = remember { NowPlayingLyricsReset() }
    val scroll = rememberScrollState()
    // Line i -> (top in content px, height px); read when scrolling to a line.
    val placed = remember { HashMap<Int, Pair<Int, Int>>() }
    var viewport by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var viewportHeight by remember { mutableIntStateOf(0) }
    val delaySeconds by rememberUpdatedState(ps.speakerDelay)
    val currentState by rememberUpdatedState(state)
    val currentLines by rememberUpdatedState(lines)

    fun pick(): Int {
        if (currentState != LyricsLoad.Ok) return -1
        // What is heard, not what the engine has played (RightPanel.jsx:346).
        val at = NowPlayingLyrics.lookupTime(player.positionNow() - player.outputLag(), delaySeconds)
        return NowPlayingLyrics.activeIndex(currentLines, at)
    }

    fun askSync(t: Track?) {
        val song = t ?: return
        scope.launch { app.lyricJobs.sync(song, api) }
    }

    suspend fun center(i: Int, animate: Boolean) {
        val (top, h) = placed[i] ?: return
        val target = (top + h / 2 - viewportHeight / 2).coerceIn(0, scroll.maxValue)
        if (animate) scroll.animateScrollTo(target, tween(350)) else scroll.scrollTo(target)
    }

    LaunchedEffect(trackId, revision) {
        val id = trackId
        if (id == null) { state = LyricsLoad.Idle; lines = emptyList(); return@LaunchedEffect }
        state = LyricsLoad.Loading
        var attempt = 0
        while (true) {
            try {
                val l = api.lyrics(id)
                lines = l?.let { NowPlayingLyrics.phoneLines(NowPlayingLyrics.lines(it)) } ?: emptyList()
                state = if (lines.isEmpty()) LyricsLoad.None else LyricsLoad.Ok
                val lit = NowPlayingLyrics.activeIndex(
                    lines, NowPlayingLyrics.lookupTime(player.positionNow() - player.outputLag(), delaySeconds),
                ).takeIf { state == LyricsLoad.Ok } ?: -1
                if (reset.loaded(id)) { loadIndex = lit; jump = LyricsJump() }
                activeIndex = lit
                return@LaunchedEffect
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                val d = NowPlayingLyrics.retryDelay(attempt)
                if (d == null) {
                    state = LyricsLoad.None
                    if (reset.loaded(id)) jump = LyricsJump()
                    return@LaunchedEffect
                }
                attempt += 1
                delay((d * 1000).toLong())
            }
        }
    }
    LaunchedEffect(trackId) { manual = false }
    // The active line from the live playhead, ten times a second.
    LaunchedEffect(trackId, revision, state) {
        while (true) {
            val i = pick()
            if (i != activeIndex) activeIndex = i
            delay(100)
        }
    }
    LaunchedEffect(activeIndex) {
        // The line lit by the load itself stays put: the list is at its top.
        loadIndex?.let { held -> loadIndex = null; if (activeIndex == held) return@LaunchedEffect }
        if (!manual && activeIndex >= 0) center(activeIndex, animate = true)
    }
    LaunchedEffect(jump) {
        val j = jump ?: return@LaunchedEffect
        // Let the new lines lay out first.
        withFrameNanos { }
        withFrameNanos { }
        scroll.scrollTo(0)
    }

    val manualScroll = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && currentState == LyricsLoad.Ok) manual = true
                return Offset.Zero
            }
        }
    }
    val scrolledDp = scroll.value / density.density
    val topFade = NowPlayingLyrics.showsTopFade(scrolledDp, activeIndex)
    val synced = NowPlayingLyrics.isSynced(lines)

    Box(
        modifier
            .onGloballyPositioned { viewport = it }
            .onSizeChanged { viewportHeight = it.height }
            .nestedScroll(manualScroll),
    ) {
        Column(
            Modifier.fillMaxSize()
                .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                .drawWithContent {
                    drawContent()
                    drawRect(
                        Brush.verticalGradient(
                            0f to (if (topFade) Color.Transparent else Color.Black), 0.06f to Color.Black,
                            0.92f to Color.Black, 1f to Color.Transparent,
                        ),
                        blendMode = BlendMode.DstIn,
                    )
                }
                .verticalScroll(scroll)
                .padding(top = 16.dp, start = 24.dp, end = 24.dp, bottom = 48.dp),
        ) {
            when (state) {
                LyricsLoad.Loading -> LyricsNote(L("Loading lyrics..."))
                LyricsLoad.Idle -> LyricsNote(L("Play something to see lyrics."))
                LyricsLoad.None -> when {
                    job != null -> SyncBanner(job)
                    offline -> LyricsNote(L("Lyrics aren’t available offline for this song."))
                    else -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        LyricsNote(L("Looks like we don’t have the lyrics for this song."))
                        LyricsPill(L("Find and sync lyrics"), 14, 8, 16) { askSync(track) }
                    }
                }
                LyricsLoad.Ok -> {
                    if (job != null) {
                        SyncBanner(job)
                        Spacer(Modifier.height(14.dp))
                    } else if (!synced) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(L("These lyrics aren’t synced to the song yet."), Modifier.weight(1f, fill = false), style = TextStyles.subLine, color = theme.fgSub)
                            LyricsPill(L("Sync them"), 13, 4, 12) { askSync(track) }
                        }
                        Spacer(Modifier.height(12.dp))
                    }
                    lines.forEachIndexed { i, l ->
                        if (i > 0) Spacer(Modifier.height(22.dp))
                        val on = !synced || i <= activeIndex
                        val color by animateColorAsState(if (on) theme.fg else theme.fg(0.5), tween(100), label = "line")
                        Text(
                            l.text,
                            style = TextStyles.titleSm.copy(letterSpacing = if (l.gap) 2.4.sp else (-0.2).sp, lineHeight = 1.3.em),
                            color = color,
                            modifier = Modifier.fillMaxWidth()
                                .onGloballyPositioned { c ->
                                    val v = viewport ?: return@onGloballyPositioned
                                    if (!v.isAttached || !c.isAttached) return@onGloballyPositioned
                                    val y = v.localPositionOf(c, Offset.Zero).y.roundToInt() + scroll.value
                                    placed[i] = y to c.size.height
                                }
                                .pressable(PressFeedback.None, enabled = l.start != null) {
                                    val s = l.start ?: return@pressable
                                    player.seek(s)
                                    manual = false
                                    scope.launch { center(i, animate = true) }
                                },
                        )
                    }
                    Spacer(Modifier.height(32.dp))
                }
            }
        }
        AnimatedVisibility(
            manual && state == LyricsLoad.Ok && synced,
            Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp),
            enter = fadeIn(tween(200)) + slideInVertically(tween(200)) { with(density) { 6.dp.roundToPx() } },
            exit = fadeOut(tween(200)) + slideOutVertically(tween(200)) { with(density) { 6.dp.roundToPx() } },
        ) {
            Text(
                L("Sync"), style = TextStyles.bodyBold, color = theme.onFg,
                modifier = Modifier
                    .pressable(PressFeedback.Fade) {
                        manual = false
                        scope.launch { center(activeIndex, animate = true) }
                    }
                    .background(theme.fg, CircleShape)
                    .padding(vertical = 10.dp, horizontal = 24.dp),
            )
        }
    }
}

@Composable
private fun LyricsNote(s: String) {
    Text(s, Modifier.padding(vertical = 8.dp), style = TextStyles.body, color = LocalTheme.current.fgSub)
}

@Composable
private fun LyricsPill(title: String, size: Int, v: Int, h: Int, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Text(
        title, style = TextStyles.bodyBold.copy(fontSize = size.sp), color = theme.fg, maxLines = 1,
        modifier = Modifier.pressable(PressFeedback.Fade, onTap = onClick)
            .border(1.dp, theme.fg(0.3), CircleShape)
            .padding(vertical = v.dp, horizontal = h.dp),
    )
}

/** `.lyrics-syncing`: spinner, **Syncing these lyrics** · {label}. */
@Composable
private fun SyncBanner(job: LyricJob) {
    val theme = LocalTheme.current
    val text = buildAnnotatedString {
        withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = theme.fg)) { append(L("Syncing these lyrics")) }
        append(" · " + ToastCenter.stageText(LyricJobStore.stage(job)))
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        LyricsSpinner()
        Text(text, style = TextStyles.small, color = theme.fgDim)
    }
}

/** 14 dp ring, 2 dp `rgba(fg,.2)` with an `--accent` quarter, one turn per 0.8 s. */
@Composable
private fun LyricsSpinner() {
    val theme = LocalTheme.current
    val turn by rememberInfiniteTransition(label = "spin").animateFloat(
        0f, 360f, infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Restart), label = "spin",
    )
    Canvas(Modifier.size(14.dp)) {
        val w = 2.dp.toPx()
        val inset = w / 2
        val arc = Size(size.width - w, size.height - w)
        val tl = Offset(inset, inset)
        drawArc(theme.fg(0.2), 0f, 360f, false, tl, arc, style = Stroke(w))
        rotate(turn) { drawArc(theme.accent, -90f, 90f, false, tl, arc, style = Stroke(w)) }
    }
}
