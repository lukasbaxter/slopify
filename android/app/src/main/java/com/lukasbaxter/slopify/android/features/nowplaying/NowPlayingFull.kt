package com.lukasbaxter.slopify.android.features.nowplaying

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.session.SleepState
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.color.ArtworkColor
import com.lukasbaxter.slopify.android.design.components.Marquee
import com.lukasbaxter.slopify.android.design.components.QualityBadge
import com.lukasbaxter.slopify.android.design.components.rememberTrackMenuBuilder
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.icons.RepeatGlyph
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyph
import com.lukasbaxter.slopify.android.design.image.ImageLoader
import com.lukasbaxter.slopify.android.design.image.LocalApiClient
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.overlay.ToastLayout
import com.lukasbaxter.slopify.android.design.sheets.BottomSheet
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialog
import com.lukasbaxter.slopify.android.design.sheets.NameDialogHost
import com.lukasbaxter.slopify.android.design.theme.DarkIsland
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme
import com.lukasbaxter.slopify.android.player.Player
import com.lukasbaxter.slopify.android.player.RepeatMode
import com.lukasbaxter.slopify.android.player.ShuffleMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min

internal enum class NowPlayingTab { Album, Lyrics }

/** "PLAYING FROM" header text, kept per context. */
@Composable
internal fun rememberNowPlayingFrom(context: String?): NowPlayingFrom {
    val app = LocalAppModel.current
    val api = LocalApiClient.current ?: app.account.api
    var from by remember { mutableStateOf(NowPlayingFrom.fallback) }
    LaunchedEffect(context, api) {
        NowPlayingFrom.immediate(context)?.let { from = it }
        from = NowPlayingFrom.resolve(context, api)
    }
    return from
}

/** Optimistic sleep state: shown at once for 3 s, then the server's broadcast. */
private data class SleepOverride(val value: SleepState?, val until: Long)

/**
 * Full-screen now playing (UI.md 3.2, 4.2.2; FullScreen.jsx, mobile-nowplaying.css:5-111; ios
 * NowPlayingView.swift). Always opens on the Album tab; swipe down or the chevron closes it.
 */
@Composable
internal fun NowPlayingScreen() = DarkIsland {
    val app = LocalAppModel.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val ps = rememberNowPlayingSession()
    val track = ps.player.current
    var tab by remember { mutableStateOf(NowPlayingTab.Album) }
    var menu by remember { mutableStateOf<MenuSheet?>(null) }
    var dialog by remember { mutableStateOf<NameDialog?>(null) }
    var showDevices by remember { mutableStateOf(false) }
    var sleepOverride by remember { mutableStateOf<SleepOverride?>(null) }
    var scrubbing by remember { mutableStateOf(false) }
    var headerBottom by remember { mutableFloatStateOf(0f) }
    var rootTop by remember { mutableFloatStateOf(0f) }
    var pageHeight by remember { mutableIntStateOf(0) }
    val drag = remember { Animatable(0f) }
    val builder = rememberTrackMenuBuilder { dialog = it }
    val from = rememberNowPlayingFrom(ps.player.context)

    DisposableEffect(Unit) {
        ToastCenter.shared.layout.value = ToastLayout.NowPlaying
        onDispose { ToastCenter.shared.layout.value = ToastLayout.Shell(miniPlayer = true) }
    }
    // The chevron on the Lyrics tab goes back to the cover; so does system back.
    BackHandler(tab == NowPlayingTab.Lyrics) { tab = NowPlayingTab.Album }

    fun close() = app.nav.setNowPlayingOpen(false)

    fun setSleep(pick: NowPlayingSleepPick) {
        val now = System.currentTimeMillis()
        val until = now + 3000
        when (pick) {
            is NowPlayingSleepPick.Minutes -> {
                sleepOverride = SleepOverride(SleepState(at = now + pick.minutes * 60_000.0, endOfTrack = false), until)
                app.session.setSleep(pick.minutes)
            }
            NowPlayingSleepPick.EndOfTrack -> {
                sleepOverride = SleepOverride(SleepState(at = null, endOfTrack = true), until)
                app.session.setSleepEndOfTrack()
            }
            NowPlayingSleepPick.Off -> {
                sleepOverride = SleepOverride(null, until)
                app.session.setSleep(null)
            }
        }
    }

    fun openMenu() {
        val t = track ?: return
        val o = sleepOverride
        val sleep = if (o != null && o.until > System.currentTimeMillis()) o.value else ps.session.sleep
        menu = NowPlayingMenus(app, builder, scope, sleep, setSleep = ::setSleep).nowPlaying(t)
    }

    Box(
        Modifier.fillMaxSize()
            .onGloballyPositioned { rootTop = it.positionInRoot().y; pageHeight = it.size.height }
            .npSwipeDown(
                allowed = { y ->
                    !scrubbing && menu == null && !showDevices &&
                        NowPlayingMath.swipeDismissAllowed(tab == NowPlayingTab.Lyrics, y, headerBottom)
                },
                onDrag = { dy -> scope.launch { drag.snapTo(dy) } },
                onEnd = { dy, elapsed ->
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
        Box(Modifier.fillMaxSize().graphicsLayer { translationY = drag.value }.clipToBounds()) {
            NowPlayingBackground(tab, track)
            Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                TopRow(
                    tab, from, track,
                    onChevron = { if (tab == NowPlayingTab.Lyrics) tab = NowPlayingTab.Album else close() },
                    onMore = ::openMenu,
                    modifier = Modifier.onGloballyPositioned { headerBottom = it.boundsInRoot().bottom - rootTop },
                )
                if (tab == NowPlayingTab.Album) {
                    Stage(track, Modifier.weight(1f).fillMaxWidth())
                    BottomBlock(
                        ps, track,
                        onScrubbing = { scrubbing = it },
                        openDevices = { showDevices = true },
                        openLyrics = { tab = NowPlayingTab.Lyrics },
                        like = { t -> builder.like(t) },
                    )
                } else {
                    NowPlayingLyricsPane(track, ps, Modifier.weight(1f).fillMaxWidth())
                }
            }
        }
    }
    ContextMenuSheet(menu) { menu = null }
    NameDialogHost(dialog) { dialog = null }
    BottomSheet(showDevices, { showDevices = false }) { DeviceSheet() }
}

// Background

@Composable
private fun NowPlayingBackground(tab: NowPlayingTab, track: Track?) {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val api = LocalApiClient.current ?: app.account.api
    val colorUrl = track?.let { NowPlayingCover.source(it).url(api, 320) }
    var np by remember { mutableStateOf<RGB?>(null) }
    LaunchedEffect(colorUrl) { np = ArtworkColor.shared.vibrant(colorUrl) }
    val base = np ?: Theme.Fixed.nowPlayingFallback
    val top by animateColorAsState(base.color, tween(300, easing = LinearEasing), label = "np")
    val mid by animateColorAsState(base.colorMix(0.55, theme.rgb.page).color, tween(300, easing = LinearEasing), label = "npMid")
    if (tab == NowPlayingTab.Album) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to top, 0.45f to mid, 1f to theme.page)))
        return
    }
    Box(Modifier.fillMaxSize().background(theme.page).clipToBounds()) {
        // The outgoing song keeps its picture while it fades out.
        val urls = remember { LinkedHashMap<String, String?>() }
        track?.let { urls[it.id] = colorUrl }
        while (urls.size > 4) urls.remove(urls.keys.first())
        Crossfade(track?.id, animationSpec = tween(900), label = "backdrop") { id ->
            if (id != null) LyricsBackdrop(urls[id])
        }
    }
}

/** Blurred cover at brightness x0.42, saturation 1.4, with a black scrim on light covers. */
@Composable
private fun LyricsBackdrop(url: String?) {
    var image by remember(url) { mutableStateOf(url?.let { ImageLoader.shared.cached(it) }) }
    var scrim by remember(url) { mutableFloatStateOf(0f) }
    LaunchedEffect(url) {
        val u = url ?: return@LaunchedEffect
        if (image == null) image = ImageLoader.shared.image(u)
        scrim = withContext(Dispatchers.Default) {
            val bytes = ImageLoader.shared.data(u) ?: return@withContext 0f
            val px = ImageLoader.pixels(bytes, 8) ?: return@withContext 0f
            NowPlayingMath.averageColor(px)?.let { NowPlayingMath.lyricsScrimOpacity(it).toFloat() } ?: 0f
        }
    }
    val scrimShown by animateFloatAsState(scrim, tween(300), label = "scrim")
    val filter = remember {
        val m = ColorMatrix().apply { setToSaturation(NowPlayingMath.LYRICS_BACKDROP_SATURATION.toFloat()) }
        val k = NowPlayingMath.LYRICS_BACKDROP_BRIGHTNESS.toFloat()
        m.timesAssign(ColorMatrix().apply { setToScale(k, k, k, 1f) })
        ColorFilter.colorMatrix(m)
    }
    Box(Modifier.fillMaxSize()) {
        image?.let { img: ImageBitmap ->
            Image(
                img, null, contentScale = ContentScale.Crop, colorFilter = filter,
                modifier = Modifier.fillMaxSize().graphicsLayer { scaleX = 1.1f; scaleY = 1.1f }.blur(60.dp),
            )
        }
        Box(Modifier.fillMaxSize().graphicsLayer { alpha = scrimShown }.background(Theme.Fixed.black))
    }
}

// Top row (.fs-top)

@Composable
private fun TopRow(tab: NowPlayingTab, from: NowPlayingFrom, track: Track?, onChevron: () -> Unit, onMore: () -> Unit, modifier: Modifier) {
    val theme = LocalTheme.current
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).padding(top = 4.dp, start = 16.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        NowPlayingTapTarget(L("Close"), onClick = onChevron) { IconView(Icon.ChevronDown, size = 24.dp, tint = theme.fg) }
        Column(Modifier.weight(1f).padding(horizontal = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (tab == NowPlayingTab.Album) {
                Text(from.kind.uppercase(), style = NowPlayingType.fromKind, color = theme.fg(0.7), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(from.name, style = NowPlayingType.fromName, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            } else {
                Text(track?.title ?: "", style = NowPlayingType.fromName, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(track?.creditLine ?: "", style = TextStyles.subLine, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        NowPlayingTapTarget(
            L("More options"), Modifier.graphicsLayer { alpha = if (track == null) 0.35f else 1f },
            enabled = track != null, onClick = onMore,
        ) { IconView(Icon.Dots24, size = 24.dp, tint = theme.fg) }
    }
}

// Stage (.fs-stage)

@Composable
private fun Stage(track: Track?, modifier: Modifier) {
    BoxWithConstraints(modifier, contentAlignment = Alignment.TopCenter) {
        val side = max(0f, min(maxWidth.value - 48, maxHeight.value - 24)).dp
        SteadyArt(track, Modifier.padding(top = 24.dp).size(side).clip(RoundedCornerShape(Radius.panel)))
    }
}

/**
 * The big cover (`useSteadyArt`, FullScreen.jsx:66-102): keeps the previous song's art until the
 * new one has loaded, paints the 320 copy then swaps in the 640 one, and fades each new song in
 * (`fs-art-in .45s`: opacity .4 -> 1, scale .985 -> 1).
 */
@Composable
private fun SteadyArt(track: Track?, modifier: Modifier) {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val api = LocalApiClient.current ?: app.account.api
    var image by remember { mutableStateOf<ImageBitmap?>(null) }
    var shownId by remember { mutableStateOf<String?>(null) }
    val fade = remember { Animatable(1f) }
    LaunchedEffect(track?.id) {
        val t = track
        if (t == null) { image = null; shownId = null; return@LaunchedEffect }
        val src = NowPlayingCover.source(t)
        var first = true
        for (u in listOfNotNull(src.url(api, 320), src.url(api, 640))) {
            val img = ImageLoader.shared.cached(u) ?: ImageLoader.shared.image(u) ?: continue
            if (first && shownId != t.id) {
                // A new song: run the fade once; the hi swap does not re-run it.
                image = img
                shownId = t.id
                fade.snapTo(0f)
                launch { fade.animateTo(1f, Motion.ease(450)) }
            } else {
                image = img
            }
            first = false
        }
        if (shownId != t.id) { image = null; shownId = t.id }
    }
    Box(modifier.graphicsLayer {
        alpha = 0.4f + 0.6f * fade.value
        val s = 0.985f + 0.015f * fade.value
        scaleX = s; scaleY = s
    }) {
        val img = image
        if (img != null) Image(img, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else Box(Modifier.fillMaxSize().background(theme.fg(0.08)))
    }
}

// Bottom block (.fs-bottom)

@Composable
private fun BottomBlock(
    ps: NowPlayingSession,
    track: Track?,
    onScrubbing: (Boolean) -> Unit,
    openDevices: () -> Unit,
    openLyrics: () -> Unit,
    like: (Track) -> Unit,
) {
    val app = LocalAppModel.current
    Column(Modifier.fillMaxWidth().padding(top = 24.dp, start = 24.dp, end = 24.dp, bottom = 16.dp)) {
        Meta(ps, track, like)
        Spacer(Modifier.height(16.dp))
        SeekBar(ps, onScrubbing, Modifier.npOutset(top = 20.dp))
        Spacer(Modifier.height(8.dp))
        Controls(ps, app.player)
        Spacer(Modifier.height(24.dp))
        PhoneRow(ps, openDevices, openLyrics)
    }
}

@Composable
private fun Meta(ps: NowPlayingSession, track: Track?, like: (Track) -> Unit) {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val likes by app.likes.state.collectAsStateWithLifecycle()
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        // Nothing in here may widen the page: the title marquee never reports more than it is offered.
        Column(Modifier.weight(1f)) {
            Marquee(track?.title ?: L("Nothing playing"), style = TextStyles.pageTitle, color = theme.fg)
            if (track != null) {
                NowPlayingArtistLinks(track, TextStyles.body, theme.fgSub, Modifier.padding(top = 2.dp)) { id -> app.nav.open(Route.Artist(id)) }
                QualityBadge(ps.deliveredFormat(track), Modifier.padding(top = 6.dp))
            }
        }
        if (track != null) {
            val liked = likes.isLiked(track.id)
            NowPlayingTapTarget(
                if (liked) L("Remove from Liked Songs") else L("Save to Liked Songs"),
                Modifier.npOutset(end = 10.dp),
                onClick = { like(track) },
            ) { IconView(Icon.Heart, filled = liked, size = 24.dp, tint = theme.fg) }
        }
    }
}

// Seek bar (.fs-seek)

@Composable
private fun SeekBar(ps: NowPlayingSession, onScrubbing: (Boolean) -> Unit, modifier: Modifier) {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val scope = rememberCoroutineScope()
    val progress by app.player.progress.collectAsStateWithLifecycle()
    val live = rememberNowPlayingPosition()
    var scrub by remember { mutableStateOf<Double?>(null) }
    var scrubbing by remember { mutableStateOf(false) }
    var release by remember { mutableStateOf<Job?>(null) }
    val duration = progress.duration
    val shown = scrub ?: min(live, duration)
    val f = NowPlayingMath.fraction(shown, max(1.0, duration)).toFloat()
    val thumb by animateFloatAsState(if (scrubbing) 1.34f else 1f, tween(120), label = "thumb")
    val mirroring by rememberUpdatedState(ps.mirroring)
    val durationNow by rememberUpdatedState(duration)
    val seekLabel = L("Seek")
    val value = NowPlayingMath.time(progress.position)
    Column(modifier.semantics { contentDescription = seekLabel; stateDescription = value }) {
        BoxWithConstraints(
            Modifier.npOutset(bottom = 14.dp).fillMaxWidth().height(44.dp)
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        down.consume()
                        val w = size.width.toFloat()
                        scrubbing = true
                        onScrubbing(true)
                        release?.cancel()
                        scrub = NowPlayingMath.scrubValue(down.position.x, w, durationNow)
                        var x = down.position.x
                        while (true) {
                            val e = awaitPointerEvent()
                            val c = e.changes.firstOrNull { it.id == down.id } ?: break
                            c.consume()
                            x = c.position.x
                            if (!c.pressed) break
                            scrub = NowPlayingMath.scrubValue(x, w, durationNow)
                        }
                        val v = NowPlayingMath.scrubValue(x, w, durationNow)
                        scrub = v
                        scrubbing = false
                        onScrubbing(false)
                        app.player.seek(v)
                        val hold = NowPlayingMath.scrubHold(mirroring)
                        release?.cancel()
                        release = scope.launch {
                            delay((hold * 1000).toLong())
                            scrub = null
                        }
                    }
                },
            contentAlignment = Alignment.CenterStart,
        ) {
            val w = maxWidth
            Box(Modifier.fillMaxWidth().height(4.dp).background(theme.fg(0.3)))
            Box(Modifier.fillMaxWidth(f).height(4.dp).background(theme.fg))
            Box(
                Modifier.offset(x = w * f - 6.dp).size(12.dp)
                    .graphicsLayer { scaleX = thumb; scaleY = thumb }
                    .background(theme.fg, CircleShape),
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(NowPlayingMath.time(shown), style = NowPlayingType.time, color = theme.fgSub)
            Text(NowPlayingMath.remaining(shown, duration), style = NowPlayingType.time, color = theme.fgSub)
        }
    }
}

// Transport (.fs-controls)

@Composable
private fun Controls(ps: NowPlayingSession, player: Player) {
    val theme = LocalTheme.current
    val s = ps.player
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        NowPlayingTapTarget(L("Shuffle"), Modifier.npOutset(start = 6.dp), onClick = { player.setShuffle(s.shuffle.nowPlayingNext) }) {
            ShuffleGlyph(s.shuffle.nowPlayingGlyph, size = 24.dp, tint = if (s.shuffle == ShuffleMode.Off) theme.fg else theme.accentInk)
        }
        NowPlayingTapTarget(L("Previous"), onClick = { player.previous() }) { IconView(Icon.Previous, size = 32.dp, tint = theme.fg) }
        NowPlayingTapTarget(if (s.isPlaying) L("Pause") else L("Play"), size = 64.dp, onClick = { player.togglePlay() }) {
            Box(Modifier.fillMaxSize().background(theme.fg, CircleShape), contentAlignment = Alignment.Center) {
                IconView(if (s.isPlaying) Icon.Pause else Icon.Play, size = 28.dp, tint = theme.onFg)
            }
        }
        NowPlayingTapTarget(L("Next"), onClick = { player.next() }) { IconView(Icon.Next, size = 32.dp, tint = theme.fg) }
        NowPlayingTapTarget(L("Repeat"), Modifier.npOutset(end = 6.dp), onClick = { player.setRepeat(s.repeatMode.nowPlayingNext) }) {
            RepeatGlyph(s.repeatMode.nowPlayingGlyph, size = 24.dp, tint = if (s.repeatMode == RepeatMode.Off) theme.fg else theme.accentInk)
        }
    }
}

// Bottom row (.fs-phone-row)

@Composable
private fun PhoneRow(ps: NowPlayingSession, openDevices: () -> Unit, openLyrics: () -> Unit) {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        NowPlayingDeviceButton(
            ps.casting, NowPlayingDevices.label(ps.active, ps.devices),
            Modifier.weight(1f).npOutset(start = 10.dp), showName = true, onClick = openDevices,
        )
        NowPlayingTapTarget(L("Lyrics"), onClick = openLyrics) { IconView(Icon.Lyrics24, size = 24.dp, tint = theme.fg) }
        NowPlayingTapTarget(L("Queue"), Modifier.npOutset(end = 10.dp), onClick = { app.nav.setQueueOpen(true) }) {
            IconView(Icon.Queue24, size = 24.dp, tint = theme.fg)
        }
    }
}

/** Type that has no shared token (the web sizes these inline). */
internal object NowPlayingType {
    val fromKind = TextStyles.marginal.copy(fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.88.sp)
    val fromName = TextStyles.subLine.copy(fontWeight = FontWeight.Bold)
    val time = TextStyles.marginal.copy(fontSize = 11.sp, fontFeatureSettings = "tnum")
}
