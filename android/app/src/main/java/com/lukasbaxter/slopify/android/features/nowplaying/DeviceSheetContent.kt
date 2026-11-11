package com.lukasbaxter.slopify.android.features.nowplaying

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.QualityBadge
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.sheets.LocalCloseSheet
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * "Connect to a device" (UI.md 4.3, 4.4; DevicePicker.jsx:205-239; ios DeviceSheet.swift). The
 * body of a bottom sheet: `BottomSheet(visible, ...) { DeviceSheet() }`. The sheet frame swallows
 * taps, so nothing reaches the page behind. No browser-only note (DECISIONS).
 */
@Composable
internal fun DeviceSheetBody() {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val closeSheet = LocalCloseSheet.current
    val ps = rememberNowPlayingSession()
    val devices = ps.devices
    val all = listOf(NowPlayingDevice.local) + devices
    val active = ps.active
    val others = NowPlayingDevices.others(devices, active)
    val divider = theme.fg(0.1)

    fun pick(d: NowPlayingDevice) {
        when (d.kind) {
            "local" -> app.player.transferToClient(null)
            "relay" -> app.player.transferToClient(d.relayClientId)
            else -> d.lan?.let { app.player.transferToSpeaker(it) }
        }
        closeSheet()
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        // A. Header
        Column(Modifier.padding(top = 12.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(L("Connect to a device"), style = TextStyles.dialogTitle.copy(letterSpacing = TextStyles.pageTitle.letterSpacing), color = theme.fg)
            if (devices.isNotEmpty()) Text(L("{n} on your network", "n" to devices.size), style = TextStyles.subLine, color = theme.fgSub)
        }
        // B. Current device
        Row(
            Modifier.fillMaxWidth()
                .drawBehind { drawRect(divider, Offset(0f, size.height - 1.dp.toPx()), androidx.compose.ui.geometry.Size(size.width, 1.dp.toPx())) }
                .padding(top = 12.dp, bottom = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            IconView(NowPlayingDevices.icon(active), size = 32.dp, tint = theme.accentInk)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(L("Current device"), style = TextStyles.subLine.copy(fontWeight = FontWeight.Bold), color = theme.fg)
                Text(NowPlayingDevices.label(active, all), style = TextStyles.bodyBold, color = theme.accentInk, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(NowPlayingDevices.subline(active, all), style = TextStyles.subLine, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
                QualityBadge(ps.deliveredFormat(ps.player.current), Modifier.padding(top = 2.dp), small = true)
            }
        }
        // C, D. Other devices
        if (others.isNotEmpty()) {
            Text(L("Select another device"), Modifier.padding(top = 20.dp, bottom = 4.dp), style = TextStyles.bodyBold, color = theme.fg)
            for (d in others) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp)
                        .pressable(PressFeedback.None) { pick(d) }
                        .padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    IconView(NowPlayingDevices.icon(d), size = 24.dp, tint = theme.fg)
                    Column(Modifier.weight(1f)) {
                        Text(NowPlayingDevices.label(d, all), style = TextStyles.body, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(NowPlayingDevices.subline(d, all), style = TextStyles.subLine, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        // F. Speaker volume (only while the session is not on this phone)
        if (ps.casting) {
            Box(Modifier.fillMaxWidth().padding(top = 8.dp).height(1.dp).npBleed(16.dp).background(divider))
            NowPlayingVolumeSlider(ps.player.volume, Modifier.padding(top = 12.dp))
        }
    }
}

/**
 * `SheetVolume` (DevicePicker.jsx:64-124): 22 dp speaker glyphs either side of an 8 dp accent bar
 * with a 20 dp thumb. The finger x sets the value anywhere on the bar; sends are throttled to one
 * per 120 ms plus the final value, and the sent value is held 2 s against echoes.
 */
@Composable
private fun NowPlayingVolumeSlider(volume: Double, modifier: Modifier = Modifier) {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    val scope = rememberCoroutineScope()
    var dragValue by remember { mutableStateOf<Double?>(null) }
    var held by remember { mutableStateOf<Double?>(null) }
    var heldAt by remember { mutableStateOf(0L) }
    val throttle = remember { NowPlayingThrottle(0.12) }
    var trailing by remember { mutableStateOf<Job?>(null) }
    LaunchedEffect(heldAt) {
        if (held == null) return@LaunchedEffect
        delay(2000)
        held = null
    }
    val shown = dragValue ?: held ?: volume
    val thumb by animateFloatAsState(if (dragValue != null) 1.25f else 1f, tween(120), label = "vol")

    fun nowSeconds() = System.nanoTime() / 1e9
    fun send(v: Double) {
        held = v
        heldAt = System.nanoTime()
        app.player.setVolume(v)
    }
    fun move(v: Double) {
        dragValue = v
        when (val d = throttle.offer(v, nowSeconds())) {
            is NowPlayingThrottle.Decision.Send -> send(d.value)
            is NowPlayingThrottle.Decision.Wait -> {
                if (trailing != null) return
                trailing = scope.launch {
                    delay((d.delay * 1000).toLong())
                    trailing = null
                    throttle.flush(nowSeconds())?.let { send(it) }
                }
            }
        }
    }
    fun end(v: Double) {
        trailing?.cancel()
        trailing = null
        throttle.flush(nowSeconds())
        send(v)
        dragValue = null
    }

    val label = L("Speaker volume")
    val valueText = L("Volume {n}%", "n" to shown.toInt())
    Row(
        modifier.fillMaxWidth().clearAndSetSemantics {
            contentDescription = label
            stateDescription = valueText
            progressBarRangeInfo = ProgressBarRangeInfo(shown.toFloat(), 0f..100f, steps = 19)
            setProgress { v -> send(v.toDouble().coerceIn(0.0, 100.0)); true }
        },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        IconView(Icon.VolumeLow, size = 22.dp, tint = theme.fg)
        BoxWithConstraints(
            Modifier.weight(1f).height(44.dp).pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    down.consume()
                    val w = size.width.toFloat()
                    var x = down.position.x
                    move(NowPlayingMath.volumeValue(x, w))
                    while (true) {
                        val e = awaitPointerEvent()
                        val c = e.changes.firstOrNull { it.id == down.id } ?: break
                        c.consume()
                        x = c.position.x
                        if (!c.pressed) break
                        move(NowPlayingMath.volumeValue(x, w))
                    }
                    end(NowPlayingMath.volumeValue(x, w))
                }
            },
            contentAlignment = Alignment.CenterStart,
        ) {
            val f = (shown / 100).coerceIn(0.0, 1.0).toFloat()
            Box(Modifier.fillMaxWidth().height(8.dp).background(theme.fg(0.3)))
            Box(Modifier.fillMaxWidth(f).height(8.dp).background(theme.accent))
            Box(
                Modifier.offset(x = maxWidth * f - 10.dp).size(20.dp)
                    .graphicsLayer { scaleX = thumb; scaleY = thumb }
                    .background(theme.accent, CircleShape),
            )
        }
        IconView(Icon.VolumeHigh, size = 22.dp, tint = theme.fg)
    }
}
