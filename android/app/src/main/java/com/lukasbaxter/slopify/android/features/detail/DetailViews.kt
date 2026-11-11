package com.lukasbaxter.slopify.android.features.detail

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.components.ErrorBanner
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pageBanner
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.image.ImageLoader
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles

// Small views only the detail pages use. Candidates for design/ are marked TODO(lead).

/** The page error banner under the top bar (`.banner.error`), tap to dismiss. */
@Composable
internal fun DetailErrorBanner(error: String?, onDismiss: () -> Unit) {
    val e = error ?: return
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    // Clear the 56 dp top bar (pageBanner adds 16).
    ErrorBanner(e, Modifier.padding(top = top + Shell.topBar - 16.dp).pageBanner(), onTap = onDismiss)
}

/**
 * TODO(lead): candidate shared component: the outlined pill used by "See more" / "Show less"
 * (`.seemore`) and "See discography" (`.seedisco`): min height 32, padding 0 16, 13/700,
 * 1 dp `--fg-faint` border, fully round. Same look as FollowPill without the state.
 */
@Composable
internal fun DetailOutlinePill(title: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(
        modifier.pressable(PressFeedback.Fade, onTap = onClick)
            .defaultMinSize(minHeight = 32.dp)
            .border(1.dp, theme.fgFaint, CircleShape)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { Text(title, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = theme.fg) }
}

/**
 * `.shelf-head` on the artist page with the right-hand hint (`.settings-hint`, 13 `--fg-dim`).
 * TODO(lead): SectionHeader could take a hint string instead.
 */
@Composable
internal fun DetailSectionHeader(title: String, hint: String?) {
    val theme = LocalTheme.current
    Row(Modifier.fillMaxWidth().padding(top = 24.dp, bottom = 12.dp).padding(horizontal = Spacing.gutter)) {
        Text(
            title, style = TextStyles.sectionArtist, color = theme.fg, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).alignByBaseline().semantics { heading() },
        )
        if (hint != null) Text(hint, fontSize = 13.sp, color = theme.fgDim, maxLines = 1, modifier = Modifier.padding(start = 8.dp).alignByBaseline())
    }
}

/**
 * A photo drawn crop-fill with its focal point at (`x`, `y`) of the box, like CSS
 * `background-position: center 25%` (the artist banner).
 */
@Composable
internal fun DetailFocalImage(url: String?, modifier: Modifier = Modifier, x: Float = 0.5f, y: Float = 0.25f) {
    val loader = ImageLoader.shared
    var image by remember(url) { mutableStateOf<ImageBitmap?>(url?.let { loader.cached(it) }) }
    val alpha = remember(url) { Animatable(if (image != null) 1f else 0f) }
    LaunchedEffect(url) {
        val u = url ?: return@LaunchedEffect
        if (image != null) return@LaunchedEffect
        image = loader.image(u) ?: return@LaunchedEffect
        alpha.animateTo(1f, Motion.imageFade())
    }
    Box(modifier.clipToBounds().clearAndSetSemantics {}) {
        image?.let {
            Image(
                it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop,
                alignment = BiasAlignment(x * 2 - 1, y * 2 - 1), alpha = alpha.value,
            )
        }
    }
}

/** `filter: grayscale(g) brightness(b)` as one colour matrix over the content (missing release art). */
internal fun Modifier.detailDimmed(grayscale: Float, brightness: Float): Modifier = drawWithContent {
    val m = ColorMatrix().apply { setToSaturation(1f - grayscale) }
    val v = m.values
    for (i in 0 until 3) for (j in 0 until 4) v[i * 5 + j] *= brightness
    val paint = Paint().apply { colorFilter = ColorFilter.colorMatrix(ColorMatrix(v)) }
    drawIntoCanvas { c ->
        c.saveLayer(androidx.compose.ui.geometry.Rect(0f, 0f, size.width, size.height), paint)
        drawContent()
        c.restore()
    }
}
