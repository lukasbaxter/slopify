package com.lukasbaxter.slopify.android.design.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme

/** White pill (dialog "Create", Save): `--fg` fill, `--on-fg` 14/700, padding 10/24, 40 % when disabled (UI.md 2.10). */
@Composable
fun PrimaryButton(title: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Text(
        title, style = TextStyles.button, color = theme.onFg,
        modifier = modifier.alpha(if (enabled) 1f else 0.4f)
            .pressable(PressFeedback.Fade, enabled = enabled, onTap = onClick)
            .background(theme.fg, CircleShape)
            .padding(vertical = 10.dp, horizontal = 24.dp),
    )
}

/** Outlined pill (dialog "Cancel"): 1 #7a7a7a border, 14/700, padding 8/16, min height 32. */
@Composable
fun SecondaryButton(title: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(
        modifier.alpha(if (enabled) 1f else 0.4f)
            .pressable(PressFeedback.Fade, enabled = enabled, onTap = onClick)
            .defaultMinSize(minHeight = 32.dp)
            .border(1.dp, Theme.Fixed.secondaryButtonBorder, CircleShape)
            .padding(vertical = 8.dp, horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { Text(title, style = TextStyles.button, color = theme.fg) }
}

/**
 * The round play button of detail pages (`.bigplay`, UI.md 6.3.3): 48 circle `--accent`, 22
 * glyph `--on-accent`, pressed `--accent-press`. Pause glyph while `playing`.
 */
@Composable
fun BigPlayButton(playing: Boolean, modifier: Modifier = Modifier, size: Dp = 48.dp, glyph: Dp = 22.dp, onClick: () -> Unit) {
    val theme = LocalTheme.current
    val press = remember { PressState() }
    val label = if (playing) L("Pause") else L("Play")
    Box(
        modifier.size(size)
            .pressable(PressFeedback.None, state = press, onTap = onClick)
            .semantics { contentDescription = label }
            .background(if (press.pressed) theme.accentPress else theme.accent, CircleShape),
        contentAlignment = Alignment.Center,
    ) { IconView(if (playing) Icon.Pause else Icon.Play, size = glyph, tint = theme.onAccent) }
}

/**
 * Action-row icon button (`.iconbtn`): 40x40 hit box, 24 glyph `--fg-sub`; `on` paints the glyph
 * `--seek-accent` (shuffle on, album saved, download held). Press: opacity .6. The glyph slot
 * gets the colour to paint with.
 */
@Composable
fun IconButton(
    label: String,
    modifier: Modifier = Modifier,
    on: Boolean = false,
    size: Dp = 40.dp,
    onClick: () -> Unit,
    glyph: @Composable (tint: Color) -> Unit,
) {
    val theme = LocalTheme.current
    Box(
        modifier.size(size).pressable(PressFeedback.Fade, onTap = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { glyph(if (on) theme.seekAccent else theme.fgSub) }
}

/** [IconButton] with a plain glyph. */
@Composable
fun IconButton(icon: Icon, label: String, modifier: Modifier = Modifier, on: Boolean = false, glyphSize: Dp = 24.dp, size: Dp = 40.dp, onClick: () -> Unit) =
    IconButton(label, modifier, on, size, onClick) { tint -> IconView(icon, size = glyphSize, tint = tint) }

/** Artist "Follow" / "Following" outlined pill (UI.md 6.3.3): min height 32, padding 0/16, 13/700, 1 border `--fg-faint`, `--fg` while following. */
@Composable
fun FollowPill(following: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(
        modifier.pressable(PressFeedback.Fade, onTap = onClick)
            .defaultMinSize(minHeight = 32.dp)
            .border(1.dp, if (following) theme.fg else theme.fgFaint, CircleShape)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { Text(if (following) L("Following") else L("Follow"), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = theme.fg) }
}

/** Request pill over a missing release card (UI.md 6.0.7): white, black 12/700, padding 6/12; busy: `--tint-press` with white text. */
@Composable
fun RequestPill(title: String, modifier: Modifier = Modifier, busy: Boolean = false, onClick: () -> Unit) {
    Text(
        title, fontSize = 12.sp, fontWeight = FontWeight.Bold, color = if (busy) Color.White else Color.Black,
        modifier = modifier.pressable(PressFeedback.Fade, enabled = !busy, onTap = onClick)
            .shadow(8.dp, CircleShape, ambientColor = Color.Black, spotColor = Color.Black)
            .background(if (busy) Theme.Fixed.busyPill else Color.White, CircleShape)
            .padding(vertical = 6.dp, horizontal = 12.dp),
    )
}
