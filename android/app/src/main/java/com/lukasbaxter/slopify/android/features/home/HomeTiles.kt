package com.lukasbaxter.slopify.android.features.home

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.PressState
import com.lukasbaxter.slopify.android.design.components.pressDim
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.image.ImageLoader
import com.lukasbaxter.slopify.android.design.image.LikedCover
import com.lukasbaxter.slopify.android.design.image.LocalApiClient
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import kotlin.math.ceil

/**
 * Shortcut tile (UI.md 6.1.4): 56 tall, `--chip`, radius 4, 56 art flush left, 13/700 two-line
 * label (lh 1.25, padding 10 / 8). Press: `rgba(fg,.08)` and art brightness .8. Opens, never plays.
 */
@Composable
internal fun HomeShortcutTile(shortcut: HomeLogic.Shortcut, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val theme = LocalTheme.current
    val press = remember { PressState() }
    val label = when (shortcut) {
        HomeLogic.Shortcut.Liked -> L("Liked Songs")
        is HomeLogic.Shortcut.AlbumTile -> HomeLogic.tileTitle(shortcut.album.name)
        is HomeLogic.Shortcut.PlaylistTile -> HomeLogic.tileTitle(shortcut.playlist.name)
    }
    Row(
        modifier.fillMaxWidth().height(56.dp)
            .clip(RoundedCornerShape(Radius.art))
            .background(theme.chip)
            .pressable(PressFeedback.Row, state = press, onTap = onClick)
            .semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(56.dp).pressDim(press)) {
            when (shortcut) {
                HomeLogic.Shortcut.Liked -> LikedCover(Modifier.fillMaxSize(), heart = 0.45f, radius = 0.dp)
                is HomeLogic.Shortcut.AlbumTile ->
                    CoverImage(CoverSource.of(shortcut.album), 56.dp, Modifier.fillMaxSize(), shape = CoverShape.Rounded(0.dp), placeholder = CoverPlaceholder.None)
                is HomeLogic.Shortcut.PlaylistTile ->
                    CoverImage(CoverSource.of(shortcut.playlist), 56.dp, Modifier.fillMaxSize(), shape = CoverShape.Rounded(0.dp), placeholder = CoverPlaceholder.None)
            }
        }
        Text(
            label,
            style = TextStyles.miniTitle.copy(fontWeight = TextStyles.cardTitle.fontWeight),
            color = theme.fg, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).padding(start = 10.dp, end = 8.dp),
        )
    }
}

/** CSS `#000` in `color-mix(<mix> 55%, #000)`: pure black on every theme. */
private val homeMixBlack = RGB(0.0, 0.0, 0.0)

/**
 * Daily Mix / Top Songs composite art (UI.md 6.1.6, 6.3.6): photo kept by its top edge over a
 * `160deg mix(color 55% black) -> color` ground, with a band in the raw mix colour carrying the label.
 * Home tile: 14 sp, padding 6/10, bottom radius 2. Page cover (`large`): 16 sp, padding 10/14, no radius.
 */
@Composable
internal fun HomeMixArt(source: CoverSource?, color: RGB, label: String, pixelSize: Dp, modifier: Modifier = Modifier, large: Boolean = false) {
    val api = LocalApiClient.current
    val density = LocalDensity.current
    val px = ceil(pixelSize.value * maxOf(density.density, 1f)).toInt()
    val url = remember(source, px, api, api?.baseUrl) { source?.url(api, px) }
    var image by remember(url) { mutableStateOf(url?.let { ImageLoader.shared.cached(it) }) }
    val alpha = remember(url) { Animatable(if (image != null) 1f else 0f) }
    LaunchedEffect(url) {
        val u = url ?: return@LaunchedEffect
        if (image != null) return@LaunchedEffect
        val img = ImageLoader.shared.image(u) ?: return@LaunchedEffect
        image = img
        alpha.animateTo(1f, Motion.imageFade())
    }
    val dark = color.colorMix(0.55, homeMixBlack).color
    val raw = color.color
    Box(
        modifier.fillMaxSize().clearAndSetSemantics {}.drawBehind {
            drawRect(Brush.linearGradient(listOf(dark, raw), start = Offset(size.width * 0.33f, size.height * 0.03f), end = Offset(size.width * 0.67f, size.height * 0.97f)))
        },
        contentAlignment = Alignment.BottomStart,
    ) {
        image?.let {
            Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alignment = Alignment.TopCenter, alpha = alpha.value)
        }
        val corner = if (large) 0.dp else Radius.card
        Text(
            label,
            style = (if (large) TextStyles.bodyBold else TextStyles.smallBold).copy(letterSpacing = (-0.2).sp),
            color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(bottomStart = corner, bottomEnd = corner))
                .background(raw)
                .padding(vertical = if (large) 10.dp else 6.dp, horizontal = if (large) 14.dp else 10.dp),
        )
    }
}

/** The hero's mix mark (`.hero-avatar.mixmark`): a 20 disc in the raw mix colour with a white note. */
@Composable
internal fun HomeMixMark(color: RGB) {
    Box(Modifier.fillMaxSize().clip(CircleShape).background(color.color), contentAlignment = Alignment.Center) {
        IconView(Icon.MusicNote, size = 12.dp, tint = Color.White, tintAll = true)
    }
}
