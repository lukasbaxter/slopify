package com.lukasbaxter.slopify.android.design.overlay

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme

/**
 * The bottom-aligned stack: toast, lyric-sync pill, offline pill, 8 apart, never taking touches.
 * The design root draws it above the overlays.
 */
@Composable
fun ToastStack(center: ToastCenter, modifier: Modifier = Modifier) {
    val toast by center.toast.collectAsStateWithLifecycle()
    val sync by center.lyricSync.collectAsStateWithLifecycle()
    val offline by center.offline.collectAsStateWithLifecycle()
    val layout by center.layout.collectAsStateWithLifecycle()
    Box(modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars).padding(bottom = layout.clearance), contentAlignment = Alignment.BottomCenter) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            toast?.let { t -> key(t.id) { ToastView(t.text) } }
            sync?.let { LyricSyncPill(it, Modifier.widthIn(max = 560.dp).padding(horizontal = 16.dp)) }
            if (offline) OfflinePill()
        }
    }
}

/** `.toast`: `--accent` fill, `--on-accent` 14/500, padding 12/16, radius 8, shadow 0 4 12 .5. No enter/exit animation. */
@Composable
fun ToastView(text: String, modifier: Modifier = Modifier) {
    val theme = LocalTheme.current
    Text(
        text,
        style = TextStyles.toast, color = theme.onAccent, textAlign = TextAlign.Center,
        modifier = modifier.padding(horizontal = 16.dp)
            .shadow(6.dp, RoundedCornerShape(Radius.dialog), ambientColor = Color.Black, spotColor = Color.Black)
            .background(theme.accent, RoundedCornerShape(Radius.dialog))
            .padding(vertical = 12.dp, horizontal = 16.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/** `Offline · downloaded music only`: #3a3a3a, white 12/600, padding 5/12, capsule, shadow 0 2 8 .4. */
@Composable
fun OfflinePill(modifier: Modifier = Modifier) {
    Text(
        L("Offline · downloaded music only"),
        color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        modifier = modifier.shadow(4.dp, CircleShape, ambientColor = Color.Black, spotColor = Color.Black)
            .background(Theme.Fixed.offlinePill, CircleShape)
            .padding(vertical = 5.dp, horizontal = 12.dp),
    )
}

/**
 * Lyric sync pill (LyricSyncStatus.jsx): `--bg-elevated-hi`, 13, padding 10/16, capsule, max
 * `min(560, screen - 32)`; 14 spinner ring (white 20 %, accent quarter, 0.8 s), then
 * **Syncing lyrics** · {title} — {stage} [· {n} more].
 */
@Composable
fun LyricSyncPill(state: ToastCenter.LyricSync, modifier: Modifier = Modifier) {
    val theme = LocalTheme.current
    val spin by rememberInfiniteTransition(label = "spin").animateFloat(
        0f, 360f, infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Restart), label = "spin",
    )
    val line = buildAnnotatedString {
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(L("Syncing lyrics")) }
        append(" · ${state.title} — ${state.stage}")
        if (state.more > 0) append(" · " + L("{n} more", "n" to state.more))
    }
    Row(
        modifier.background(theme.bgElevatedHi, CircleShape).padding(vertical = 10.dp, horizontal = 16.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Canvas(Modifier.size(14.dp)) {
            val w = 2.dp.toPx()
            drawCircle(Color.White.copy(alpha = 0.2f), radius = size.minDimension / 2 - w / 2, style = Stroke(w))
            drawArc(theme.accent, spin - 90f, 90f, false, topLeft = androidx.compose.ui.geometry.Offset(w / 2, w / 2),
                size = androidx.compose.ui.geometry.Size(size.width - w, size.height - w), style = Stroke(w))
        }
        Text(line, fontSize = 13.sp, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
