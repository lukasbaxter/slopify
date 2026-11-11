package com.lukasbaxter.slopify.android.features.nowplaying

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.color.ArtworkColor
import com.lukasbaxter.slopify.android.design.components.Marquee
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.LocalApiClient
import com.lukasbaxter.slopify.android.design.sheets.BottomSheet
import com.lukasbaxter.slopify.android.design.theme.DarkIsland
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.hypot

/**
 * The floating mini player card (UI.md 3.1, 4.2.1; Player.jsx:190-444, mobile-nowplaying.css:125-164;
 * ios MiniPlayer.swift). Tap opens now playing; swipe left/right skips.
 */
@Composable
internal fun MiniPlayerBar() {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val ps = rememberNowPlayingSession()
    var showDevices by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth()
            .background(Brush.verticalGradient(0f to theme.page(0.0), 0.27f to theme.page(0.92), 1f to theme.page))
            .padding(top = Shell.miniPlayerFade, start = 8.dp, end = 8.dp),
    ) {
        ps.player.error?.let { e ->
            Text(
                e, style = TextStyles.small, color = theme.danger,
                modifier = Modifier.padding(bottom = 8.dp).fillMaxWidth()
                    .background(theme.dangerBg, RoundedCornerShape(4.dp))
                    .pressable(PressFeedback.None) { app.player.clearError() }
                    .padding(vertical = 8.dp, horizontal = 16.dp),
            )
        }
        DarkIsland { MiniCard(ps) { showDevices = true } }
        Spacer(Modifier.height(Shell.miniPlayerGap))
    }
    // Outside the island: the sheet from the mini player keeps the theme's own ink.
    BottomSheet(showDevices, { showDevices = false }) { DeviceSheet() }
}

@Composable
private fun MiniCard(ps: NowPlayingSession, openDevices: () -> Unit) {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val api = LocalApiClient.current ?: app.account.api
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val track = ps.player.current
    val playing = ps.player.isPlaying

    val tintUrl = track?.let { NowPlayingCover.source(it).url(api, 128) }
    var tint by remember { mutableStateOf<RGB?>(null) }
    LaunchedEffect(tintUrl) { tint = ArtworkColor.shared.mini(tintUrl) }
    val bg by animateColorAsState((tint ?: theme.rgb.chip).colorMix(0.55, RGB.BLACK).color, tween(300, easing = LinearEasing), label = "mini")

    // Swipe to skip: only the art + text follow the finger (dp).
    val dx = remember { Animatable(0f) }
    val opacity = remember { Animatable(1f) }
    var nowWidth by remember { mutableIntStateOf(320) }
    val current = track != null

    fun runSkip(s: NowPlayingMath.Skip) {
        if (s == NowPlayingMath.Skip.Next) app.player.next() else app.player.previous()
        val out = (if (s == NowPlayingMath.Skip.Next) -1.2f else 1.2f) * with(density) { nowWidth.toDp().value }
        scope.launch {
            launch { opacity.animateTo(0f, tween(180)) }
            dx.animateTo(out, tween(180))
            dx.snapTo(if (s == NowPlayingMath.Skip.Next) 40f else -40f)
            launch { opacity.animateTo(1f, tween(200)) }
            dx.animateTo(0f, tween(200))
        }
    }

    val openLabel = L("Now playing")
    Box(
        Modifier.fillMaxWidth().height(Shell.miniPlayer)
            .clip(RoundedCornerShape(Radius.row))
            .background(bg)
            .semantics { onClick(openLabel) { app.nav.setNowPlayingOpen(true); true } }
            .pointerInput(current) {
                val start = 6.dp.toPx()
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    var started = false
                    var abandoned = false
                    var t0 = down.uptimeMillis
                    var t1 = down.uptimeMillis
                    var x = 0f
                    var y = 0f
                    while (true) {
                        val e = awaitPointerEvent()
                        val c = e.changes.firstOrNull { it.id == down.id } ?: break
                        x = (c.position.x - down.position.x) / density.density
                        y = (c.position.y - down.position.y) / density.density
                        t1 = c.uptimeMillis
                        if (!c.pressed) break
                        if (!started) {
                            if (hypot(x, y) * density.density < start) continue
                            started = true
                            t0 = c.uptimeMillis
                            abandoned = NowPlayingMath.abandonsSwipe(x, y)
                        }
                        if (abandoned) continue
                        val (off, op) = NowPlayingMath.skipFollow(x)
                        if (abs(x) > 6) c.consume()
                        scope.launch { dx.snapTo(off); opacity.snapTo(op.toFloat()) }
                    }
                    if (!started) return@awaitEachGesture
                    val s = if (current && !abandoned) NowPlayingMath.skip(x, y, (t1 - t0) / 1000.0) else null
                    if (s != null) runSkip(s)
                    else if (dx.value != 0f || opacity.value != 1f) scope.launch {
                        launch { opacity.animateTo(1f, tween(180)) }
                        dx.animateTo(0f, tween(180))
                    }
                }
            }
            .pressable(PressFeedback.None) { app.nav.setNowPlayingOpen(true) },
    ) {
        Row(Modifier.fillMaxSize().padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.weight(1f).fillMaxHeight()
                    .onSizeChanged { nowWidth = it.width }
                    .graphicsLayer { translationX = dx.value * density.density; alpha = opacity.value },
                contentAlignment = Alignment.CenterStart,
            ) { MiniNow(track, ps.elsewhere) }
            NowPlayingDeviceButton(ps.casting, NowPlayingDevices.nameFor(ps.active), onClick = openDevices)
            NowPlayingTapTarget(
                if (playing) L("Pause") else L("Play"),
                Modifier.graphicsLayer { alpha = if (current) 1f else 0.3f },
                enabled = current,
                onClick = { app.player.togglePlay() },
            ) { IconView(if (playing) Icon.Pause else Icon.Play, size = 20.dp, tint = theme.fg) }
        }
        MiniProgress(Modifier.align(Alignment.BottomCenter).padding(horizontal = 8.dp))
    }
}

@Composable
private fun MiniNow(track: Track?, elsewhere: String?) {
    val theme = LocalTheme.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (track != null) {
            CoverImage(NowPlayingCover.source(track), 40.dp, Modifier.size(40.dp), shape = CoverShape.Rounded(Radius.art), placeholder = CoverPlaceholder.CardHover)
        } else {
            Box(Modifier.size(40.dp).background(theme.cardHover, RoundedCornerShape(Radius.art)))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(track?.title ?: L("Nothing playing"), style = TextStyles.miniTitle, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (elsewhere != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    IconView(Icon.Cast, size = 13.dp, tint = theme.accentInk)
                    Marquee(L("Playing on {name}", "name" to elsewhere), style = TextStyles.miniArtist, color = theme.accentInk)
                }
            } else if (track != null) {
                Text(track.creditLine, style = TextStyles.miniArtist, color = theme.fg(0.7), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** 2 dp line, `--fg` over `rgba(fg,.25)`, from the live playhead every 250 ms. */
@Composable
private fun MiniProgress(modifier: Modifier) {
    val theme = LocalTheme.current
    val duration = LocalAppModel.current.player.progress.collectAsStateWithLifecycle().value.duration
    val pos = rememberNowPlayingPosition()
    val f = NowPlayingMath.fraction(pos, duration).toFloat()
    Box(modifier.fillMaxWidth().height(2.dp).clip(RoundedCornerShape(1.dp)).background(theme.fg(0.25)).clearAndSetSemantics {}) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(f).background(theme.fg))
    }
}

/**
 * `.devicebtn` (DevicePicker.jsx:196-201): the Connect glyph, green while casting. With
 * `showName` (now playing) the name follows the glyph while casting.
 */
@Composable
internal fun NowPlayingDeviceButton(casting: Boolean, label: String, modifier: Modifier = Modifier, showName: Boolean = false, onClick: () -> Unit) {
    val theme = LocalTheme.current
    val tint = if (casting) theme.accentInk else theme.fg
    val a11y = L("Playing on {name}", "name" to label)
    Row(
        modifier.widthIn(min = 44.dp).heightIn(min = 44.dp).height(44.dp)
            .pressable(PressFeedback.Fade, onTap = onClick)
            .semantics { contentDescription = a11y }
            .padding(horizontal = if (showName) 10.dp else 0.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = if (showName) Arrangement.spacedBy(8.dp, Alignment.Start) else Arrangement.Center,
    ) {
        IconView(Icon.Connect, size = 24.dp, tint = tint)
        if (showName && casting) {
            Marquee(label, Modifier.weight(1f, fill = false).clearAndSetSemantics {}, style = TextStyles.chip.copy(fontSize = 12.sp, fontWeight = FontWeight.SemiBold), color = tint)
        }
    }
}
