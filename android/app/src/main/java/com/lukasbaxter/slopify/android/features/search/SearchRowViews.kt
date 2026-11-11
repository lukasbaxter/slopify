package com.lukasbaxter.slopify.android.features.search

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
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
import com.lukasbaxter.slopify.android.design.theme.DarkIsland
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Theme
import com.lukasbaxter.slopify.android.design.theme.TextStyles

/**
 * `SearchRow` (Library.jsx:86-103, mobile-home-search.css:145-154): 48 art (round for artists),
 * name 16 / lh 1.3, sub 13 `--fg-sub`, min height 64, padding 8 0, gap 12; optional trailing
 * action and the 44 remove button (recent searches). `missing`: an Everywhere release the
 * library lacks (art `grayscale(.4) brightness(.7)`, name `--fg-sub`).
 */
@Composable
internal fun SearchRow(
    source: CoverSource,
    name: String,
    sub: String,
    modifier: Modifier = Modifier,
    round: Boolean = false,
    missing: Boolean = false,
    onRemove: (() -> Unit)? = null,
    action: (@Composable RowScope.() -> Unit)? = null,
    onTap: () -> Unit,
) {
    val theme = LocalTheme.current
    Row(
        modifier.fillMaxWidth().pressable(PressFeedback.Row, onTap = onTap).semantics { role = Role.Button }
            .heightIn(min = 64.dp).padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CoverImage(
            source, 48.dp, Modifier.size(48.dp).then(if (missing) Modifier.searchMissingArt() else Modifier),
            shape = if (round) CoverShape.Circle else CoverShape.Rounded(Radius.art), placeholder = CoverPlaceholder.Chip,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(name, style = TextStyles.rowTitle.copy(lineHeight = 1.3.em), color = if (missing) theme.fgSub else theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub.isNotEmpty()) {
                Text(sub, style = TextStyles.subLine.copy(lineHeight = 1.3.em), color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        action?.invoke(this)
        if (onRemove != null) {
            val label = L("Remove")
            Box(
                Modifier.offset(x = 12.dp).size(44.dp).pressable(PressFeedback.Fade, onTap = onRemove).semantics { contentDescription = label },
                contentAlignment = Alignment.Center,
            ) { IconView(Icon.Close, size = 16.dp, tint = theme.fgSub) }
        }
    }
}

/** `grayscale(.4) brightness(.7)` as one colour matrix over the art. */
private fun Modifier.searchMissingArt(): Modifier = drawWithContent {
    val m = ColorMatrix().apply { setToSaturation(0.6f) }
    val v = m.values
    for (i in 0 until 3) for (j in 0 until 4) v[i * 5 + j] *= 0.7f
    val paint = Paint().apply { colorFilter = ColorFilter.colorMatrix(ColorMatrix(v)) }
    drawIntoCanvas { c ->
        c.saveLayer(Rect(0f, 0f, size.width, size.height), paint)
        drawContent()
        c.restore()
    }
}

/**
 * Browse tile (`.tile`, app.css:947-951, mobile-home-search.css:139-143): 100 high, radius 4,
 * padding 12, the tile colour; 15/700 title top-left at 58 % width; a 56 % cover rotated 25°
 * peeking out bottom-right (-18 %), shadow `0 8 24 rgba(0,0,0,.5)`. Press: brightness .8.
 */
@Composable
internal fun SearchBrowseTile(title: String, color: RGB, modifier: Modifier = Modifier, onClick: () -> Unit, cover: @Composable () -> Unit) {
    val press = remember { PressState() }
    DarkIsland {
        val theme = LocalTheme.current
        BoxWithConstraints(
            modifier.fillMaxWidth().height(100.dp)
                .pressable(PressFeedback.None, state = press, onTap = onClick)
                .semantics { role = Role.Button; contentDescription = title }
                .clip(RoundedCornerShape(Radius.art))
                .pressDim(press)
                .background(color.color),
        ) {
            val w = maxWidth
            val h = maxHeight
            val side = w * 0.56f
            Box(
                Modifier.offset(x = w + w * 0.18f - side, y = h + h * 0.18f - side)
                    .size(side)
                    .rotate(25f)
                    .shadow(12.dp, RoundedCornerShape(Radius.art), ambientColor = Theme.Fixed.black, spotColor = Theme.Fixed.black)
                    .clip(RoundedCornerShape(Radius.art)),
            ) { cover() }
            Text(
                title, fontSize = 15.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp, lineHeight = 1.2.em, color = theme.fg,
                modifier = Modifier.padding(12.dp).widthIn(max = w * 0.58f),
            )
        }
    }
}

/** Fills a tile's cover box. */
@Composable
internal fun SearchTileCover(source: CoverSource) {
    CoverImage(source, 100.dp, Modifier.fillMaxSize(), shape = CoverShape.Rounded(Radius.art), placeholder = CoverPlaceholder.None)
}
