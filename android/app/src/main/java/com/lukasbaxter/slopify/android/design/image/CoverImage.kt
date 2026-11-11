package com.lukasbaxter.slopify.android.design.image

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlin.math.ceil
import kotlin.math.min

/** Clip of a cover. */
@Immutable
sealed interface CoverShape {
    data class Rounded(val radius: Dp) : CoverShape
    data object Circle : CoverShape

    val shape: Shape get() = when (this) {
        Circle -> CircleShape
        is Rounded -> RoundedCornerShape(radius)
    }
}

enum class CoverPlaceholder {
    /** `--chip` square (sheets, skeletons, default). */
    Chip,
    /** `--card-hover` (#282828): track rows, cards, mini player. */
    CardHover,
    /** Music-note glyph on `--chip` (cards without art, `mobile-library.css:196`). */
    Note,
    /** Nothing behind the image (Home cards show the page until decoded). */
    None,
}

/**
 * Artwork tile: album, track, playlist, artist (round), folder, or any URL (ios
 * Design/Image/CoverImage.swift). Placeholder while loading or when there is no picture,
 * cross-fade in (150 ms ease-out, Home FadeImg), crop-fill, clipped to `shape`. No layout of its
 * own: give it a size with `modifier`.
 *
 *     CoverImage(CoverSource.of(album), 48.dp, Modifier.size(48.dp))
 */
@Composable
fun CoverImage(
    source: CoverSource,
    size: Dp,
    modifier: Modifier = Modifier,
    shape: CoverShape = CoverShape.Rounded(Radius.art),
    placeholder: CoverPlaceholder = CoverPlaceholder.Chip,
    fade: Boolean = true,
    /** Called with the loaded image (e.g. to sample its colour). */
    onLoad: ((ImageBitmap) -> Unit)? = null,
) {
    val api = LocalApiClient.current
    val density = LocalDensity.current
    val px = ceil(size.value * maxOf(density.density, 1f)).toInt()
    val url = remember(source, px, api, api?.baseUrl) { source.url(api, px) }
    val loader = ImageLoader.shared
    var image by remember(url) { mutableStateOf(url?.let { loader.cached(it) }) }
    val alpha = remember(url) { Animatable(if (image != null || !fade) 1f else 0f) }
    val loaded by rememberUpdatedState(onLoad)
    LaunchedEffect(url) {
        val u = url ?: return@LaunchedEffect
        image?.let { loaded?.invoke(it); return@LaunchedEffect }
        val img = loader.image(u) ?: return@LaunchedEffect
        image = img
        loaded?.invoke(img)
        if (fade) alpha.animateTo(1f, Motion.imageFade()) else alpha.snapTo(1f)
    }
    Box(modifier.clip(shape.shape).clearAndSetSemantics {}) {
        CoverPlaceholderView(placeholder)
        image?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alpha = alpha.value) }
    }
}

@Composable
private fun CoverPlaceholderView(p: CoverPlaceholder) {
    val theme = LocalTheme.current
    when (p) {
        CoverPlaceholder.Chip -> Box(Modifier.fillMaxSize().background(theme.chip))
        CoverPlaceholder.CardHover -> Box(Modifier.fillMaxSize().background(theme.cardHover))
        CoverPlaceholder.None -> Unit
        CoverPlaceholder.Note -> BoxWithConstraints(Modifier.fillMaxSize().background(theme.chip), contentAlignment = Alignment.Center) {
            IconView(Icon.MusicNote, size = min(maxWidth.value, maxHeight.value).dp * 0.32f, tint = theme.fgFaint)
        }
    }
}

/** Liked Songs tile: 135deg #450af5 -> #c4efd9 with a centred white heart at `heart` of the box. */
@Composable
fun LikedCover(modifier: Modifier = Modifier, heart: Float = 0.45f, radius: Dp = Radius.art) {
    BoxWithConstraints(
        modifier.clip(RoundedCornerShape(radius)).clearAndSetSemantics {}
            .background(Brush.linearGradient(Theme.Fixed.likedGradient, start = Offset.Zero, end = Offset.Infinite)),
        contentAlignment = Alignment.Center,
    ) {
        IconView(Icon.HeartFilled, size = min(maxWidth.value, maxHeight.value).dp * heart, tint = Color.White, tintAll = true)
    }
}

/**
 * A user's round picture with the initial fallback (UI.md 2.1): `#509bf5` disc with a black
 * initial (header, 14/700), or `drawer` style `#535353` with a white initial. The picture fills
 * its circle (DECISIONS: no zoom).
 */
@Composable
fun Avatar(userId: String?, name: String?, modifier: Modifier = Modifier, size: Dp = 32.dp, drawer: Boolean = false) {
    val api = LocalApiClient.current
    val url = remember(userId, api, api?.baseUrl) { userId?.let { CoverSource.User(it).url(api, (size.value * 3).toInt()) } }
    var image by remember(url) { mutableStateOf(url?.let { ImageLoader.shared.cached(it) }) }
    LaunchedEffect(url) { if (image == null && url != null) image = ImageLoader.shared.image(url) }
    val initial = (name?.takeIf { it.isNotEmpty() } ?: "?").take(1).uppercase()
    Box(
        modifier.size(size).clip(CircleShape)
            .background(if (drawer) Theme.Fixed.drawerAvatarFallback else Theme.Fixed.avatarFallback)
            .clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        Text(
            initial,
            color = if (drawer) Color.White else Color.Black,
            style = TextStyle(fontSize = (size.value * (if (drawer) 22f / 56 else 14f / 32)).sp, fontWeight = FontWeight.Bold),
        )
        image?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
    }
}
