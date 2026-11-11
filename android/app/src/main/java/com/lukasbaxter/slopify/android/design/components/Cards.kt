package com.lukasbaxter.slopify.android.design.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontWeight
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles

/** Card layout family (UI.md 6.0.7, 6.0.8). */
enum class CardStyle { Home, Page }

/**
 * Album / artist / playlist tile (UI.md 6.0.7; ios MediaCard.swift). The whole card is one
 * target: a tap always opens the item (cards never play on phone). `round` = artist (circle
 * art; centred text outside Home).
 *
 * Styles: [CardStyle.Home] (Home and see-all: title 1 line 14/700 lh 1.3 +8, sub 13 `--fg-sub`
 * 2 lines, left aligned, art fades in) and [CardStyle.Page] (artist, genre, radar: title 2
 * lines lh 1.4 +4, sub 13 `--fg-dim` 2 lines). `missing` greys the art and shows `request`.
 */
@Composable
fun MediaCard(
    title: String,
    subtitle: String?,
    modifier: Modifier = Modifier,
    round: Boolean = false,
    style: CardStyle = CardStyle.Page,
    /** Unavailable release: art `grayscale(.6) brightness(.55)`, title `--fg-dim`, `request` pill centred. */
    missing: Boolean = false,
    request: (@Composable () -> Unit)? = null,
    onLongPress: (() -> Unit)? = null,
    onClick: () -> Unit,
    art: @Composable () -> Unit,
) {
    val theme = LocalTheme.current
    val press = remember { PressState() }
    val centred = round && style == CardStyle.Page
    val align = if (centred) TextAlign.Center else TextAlign.Start
    Column(
        modifier.pressable(PressFeedback.Dim, state = press, onLongPress = onLongPress, onTap = onClick),
        horizontalAlignment = if (centred) Alignment.CenterHorizontally else Alignment.Start,
    ) {
        Box(Modifier.fillMaxWidth().aspectRatio(1f), contentAlignment = Alignment.Center) {
            Box(
                Modifier.matchParentSize()
                    .clip(if (round) CircleShape else RoundedCornerShape(Radius.card))
                    .then(if (missing) Modifier.missingArt() else Modifier)
                    .pressDim(press),
            ) { art() }
            if (missing && request != null) request()
        }
        Text(
            title,
            style = if (style == CardStyle.Home) TextStyles.cardTitle else TextStyles.cardTitlePage,
            color = if (missing) theme.fgDim else theme.fg,
            maxLines = if (style == CardStyle.Home) 1 else 2, overflow = TextOverflow.Ellipsis, textAlign = align,
            modifier = Modifier.fillMaxWidth().padding(top = if (style == CardStyle.Home) 8.dp else 4.dp),
        )
        if (!subtitle.isNullOrEmpty()) {
            Text(
                subtitle, style = TextStyles.cardSub, color = if (style == CardStyle.Home) theme.fgSub else theme.fgDim,
                maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = align,
                modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
            )
        }
    }
}

/** Card with a server cover. Home cards fade in over the page; others sit on `#282828`. */
@Composable
fun MediaCard(
    source: CoverSource,
    title: String,
    subtitle: String?,
    modifier: Modifier = Modifier,
    round: Boolean = false,
    style: CardStyle = CardStyle.Page,
    missing: Boolean = false,
    request: (@Composable () -> Unit)? = null,
    artSize: Dp = 158.dp,
    onLongPress: (() -> Unit)? = null,
    onClick: () -> Unit,
) = MediaCard(title, subtitle, modifier, round, style, missing, request, onLongPress, onClick) {
    CoverImage(
        source, artSize, Modifier.fillMaxSize(),
        shape = if (round) CoverShape.Circle else CoverShape.Rounded(Radius.card),
        placeholder = if (style == CardStyle.Home) CoverPlaceholder.None else CoverPlaceholder.CardHover,
        fade = style == CardStyle.Home,
    )
}

/** `grayscale(.6) brightness(.55)`, as one colour matrix over the art. */
private fun Modifier.missingArt(): Modifier = drawWithContent {
    val m = ColorMatrix().apply { setToSaturation(0.4f) }
    val b = 0.55f
    val v = m.values
    for (i in 0 until 3) for (j in 0 until 4) v[i * 5 + j] *= b
    val paint = Paint().apply { colorFilter = ColorFilter.colorMatrix(ColorMatrix(v)) }
    drawIntoCanvas { c ->
        c.saveLayer(androidx.compose.ui.geometry.Rect(0f, 0f, size.width, size.height), paint)
        drawContent()
        c.restore()
    }
}

/**
 * Horizontal shelf (UI.md 6.0.8): fixed columns, gap 16, no snapping, no scroll bar.
 * [CardStyle.Home]: 150 columns, bleeds edge to edge with a 16 inset. [CardStyle.Page]: 158
 * columns, clipped at the page's 16 inset, 6 bottom padding.
 */
@Composable
fun <T> Shelf(items: List<T>, modifier: Modifier = Modifier, style: CardStyle = CardStyle.Page, key: ((T) -> Any)? = null, cell: @Composable (T) -> Unit) {
    val column = if (style == CardStyle.Home) 150.dp else 158.dp
    LazyRow(
        modifier.fillMaxWidth().then(if (style == CardStyle.Home) Modifier else Modifier.padding(horizontal = Spacing.gutter).clipToBounds()),
        contentPadding = if (style == CardStyle.Home) PaddingValues(horizontal = Spacing.gutter) else PaddingValues(bottom = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(Spacing.shelfGap),
        verticalAlignment = Alignment.Top,
    ) {
        items(items, key = key) { Box(Modifier.width(column)) { cell(it) } }
    }
}

/** Two-column grid in a padded page (UI.md 6.0.9): row gap 16, column gap 12. Not lazy: grids here are short. */
@Composable
fun <T> CardGrid(items: List<T>, modifier: Modifier = Modifier, columns: Int = 2, cell: @Composable (T) -> Unit) {
    Column(modifier.fillMaxWidth().padding(horizontal = Spacing.gutter), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        for (row in items.chunked(columns)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                for (it in row) Box(Modifier.weight(1f)) { cell(it) }
                repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** Section heading size family (`.shelf-head`, UI.md 6.0.6). */
enum class SectionStyle { Home, Search, Artist, Detail }

/**
 * Section heading (`.shelf-head`, UI.md 6.0.6): weight 700, size by page, optional "Show all"
 * (14/700 `--fg-dim`; the web hides it on Home, pass null there). `first` = first section on
 * the page (smaller top margin).
 */
@Composable
fun SectionHeader(title: String, modifier: Modifier = Modifier, style: SectionStyle = SectionStyle.Detail, first: Boolean = false, showAll: (() -> Unit)? = null) {
    val theme = LocalTheme.current
    val top = when (style) {
        SectionStyle.Home -> 0.dp
        SectionStyle.Search -> if (first) 8.dp else 20.dp
        SectionStyle.Artist -> if (first) 8.dp else 24.dp
        SectionStyle.Detail -> if (first) 4.dp else 24.dp
    }
    val text = when (style) {
        SectionStyle.Home -> TextStyles.sectionHome
        SectionStyle.Search -> TextStyles.sectionSearch
        SectionStyle.Artist -> TextStyles.sectionArtist
        SectionStyle.Detail -> TextStyles.sectionDetail
    }
    Row(
        modifier.fillMaxWidth().padding(top = top, bottom = 12.dp).padding(horizontal = Spacing.gutter),
        verticalAlignment = Alignment.Bottom,
    ) {
        Text(title, style = text, color = theme.fg, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false).semantics { heading() }.alignByBaseline())
        Spacer(Modifier.weight(1f).width(8.dp))
        if (showAll != null) {
            Text(L("Show all"), fontSize = 14.sp, fontWeight = FontWeight.Bold, color = theme.fgDim,
                modifier = Modifier.padding(start = 8.dp).pressable(PressFeedback.Fade, onTap = showAll).alignByBaseline())
        }
    }
}
