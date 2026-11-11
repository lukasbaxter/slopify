package com.lukasbaxter.slopify.android.design.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles

/**
 * Filter pill (UI.md 6.0.5): min height 32, padding 0/16, fully round, 14/500 (13 in the
 * Library tab: `small`). Off: `--chip` / `--fg`; on: `--accent` / `--on-accent`.
 */
@Composable
fun Chip(title: String, modifier: Modifier = Modifier, on: Boolean = false, small: Boolean = false, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(
        modifier.pressable(PressFeedback.Fade, onTap = onClick)
            .semantics { selected = on }
            .defaultMinSize(minHeight = 32.dp)
            .background(if (on) theme.accent else theme.chip, CircleShape)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(title, style = if (small) TextStyles.chipSmall else TextStyles.chip, color = if (on) theme.onAccent else theme.fg, maxLines = 1)
    }
}

/** A horizontally scrolling row of chips, 8 apart, inset by the page gutter. */
@Composable
fun ChipRow(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Spacing.gutter),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/**
 * `.banner.error` (UI.md 2.9, 6.0.10): padding 12/16, radius 8, `--danger-bg`, `--danger` 14.
 * Page placement adds margin 16 24 ([pageBanner]); the player error bar uses `compact`
 * (padding 8/16, radius 4). Tap runs `onTap` (dismiss).
 */
@Composable
fun ErrorBanner(message: String, modifier: Modifier = Modifier, compact: Boolean = false, onTap: (() -> Unit)? = null) {
    val theme = LocalTheme.current
    Text(
        message, fontSize = 14.sp, color = theme.danger,
        modifier = modifier.fillMaxWidth()
            .then(if (onTap != null) Modifier.pressable(PressFeedback.None, onTap = onTap) else Modifier)
            .background(theme.dangerBg, RoundedCornerShape(if (compact) 4.dp else Radius.dialog))
            .padding(vertical = if (compact) 8.dp else 12.dp, horizontal = 16.dp),
    )
}

/** Top-of-page banner placement: margin 16 vertical, 24 horizontal. */
fun Modifier.pageBanner(): Modifier = padding(vertical = 16.dp, horizontal = 24.dp)

/** `.placeholder-note`: 13 `--fg-sub`, padding 16, margin 8 0. */
@Composable
fun PlaceholderNote(text: String, modifier: Modifier = Modifier) {
    val theme = LocalTheme.current
    Text(text, fontSize = 13.sp, color = theme.fgSub, modifier = modifier.fillMaxWidth().padding(vertical = 8.dp).padding(16.dp))
}

/**
 * Loading rows (UI.md 2.9, 6.0.11): height 64, optional 48x48 art (playlists and mixes), bars
 * 55 % x 12 and 35 % x 10, radius 6, `--chip`, gap 8; pulse 1 -> .45 -> 1 over 1.4 s.
 */
@Composable
fun SkeletonRows(modifier: Modifier = Modifier, count: Int = 8, art: Boolean = false) {
    val theme = LocalTheme.current
    Column(modifier.skeletonPulse().clearAndSetSemantics {}) {
        repeat(count) {
            Row(
                Modifier.fillMaxWidth().height(Shell.trackRow).padding(vertical = 8.dp, horizontal = Spacing.gutter),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (art) Box(Modifier.size(48.dp).background(theme.chip, RoundedCornerShape(Radius.art)))
                BoxWithConstraints(Modifier.weight(1f)) {
                    val w = maxWidth
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.width(w * 0.55f).height(12.dp).background(theme.chip, RoundedCornerShape(6.dp)))
                        Box(Modifier.width(w * 0.35f).height(10.dp).background(theme.chip, RoundedCornerShape(6.dp)))
                    }
                }
            }
        }
    }
}

/** Title placeholder (`.sk-title`): 60 % x 22, radius 6, margin 12 0 8. */
@Composable
fun SkeletonTitle(modifier: Modifier = Modifier) {
    val theme = LocalTheme.current
    BoxWithConstraints(modifier.fillMaxWidth().padding(PaddingValues(top = 12.dp, bottom = 8.dp)).skeletonPulse().clearAndSetSemantics {}) {
        Box(Modifier.width(maxWidth * 0.6f).height(22.dp).background(theme.chip, RoundedCornerShape(6.dp)))
    }
}

/** Opacity 1 -> .45 -> 1, 1.4 s ease-in-out, forever. */
@Composable
fun Modifier.skeletonPulse(): Modifier {
    val a by rememberInfiniteTransition(label = "pulse").animateFloat(1f, 0.45f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "pulse")
    return graphicsLayer { alpha = a }
}

