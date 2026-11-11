package com.lukasbaxter.slopify.android.design.icons

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlin.math.max
import kotlin.math.min

/** How a glyph element is painted. [Current] = the view's tint (SVG currentColor). */
@Immutable
sealed interface IconPaint {
    data object Current : IconPaint
    /** `var(--seek-accent)` (filled heart). */
    data object SeekAccent : IconPaint
    /** `var(--green)` (download progress ring). */
    data object Green : IconPaint
    data class Rgb(val hex: Int) : IconPaint
}

/** SVG `rotate(deg cx cy)`. */
@Immutable
data class IconRotate(val degrees: Float, val cx: Float, val cy: Float)

/** One SVG element (path or circle), with the style it inherits from its `<svg>` / `<g>`. */
@Immutable
data class IconElement(
    val d: String,
    val fill: IconPaint?,
    val stroke: IconPaint? = null,
    val lineWidth: Float = 1f,
    val cap: StrokeCap = StrokeCap.Butt,
    val join: StrokeJoin = StrokeJoin.Miter,
    val evenOdd: Boolean = false,
    val opacity: Float = 1f,
    val strokeOpacity: Float = 1f,
    val rotate: IconRotate? = null,
)

/** A glyph: a square viewBox (16, 20 or 24) and its elements, drawn in order. */
@Immutable
data class IconSpec(val viewBox: Float, val elements: List<IconElement>)

/** The filled ("on") partner of an outline glyph: tab glyphs and the heart. */
val Icon.filled: Icon
    get() = when (this) {
        Icon.HomeTab -> Icon.HomeTabFilled
        Icon.SearchTab -> Icon.SearchTabFilled
        Icon.LibraryTab -> Icon.LibraryTabFilled
        Icon.Heart -> Icon.HeartFilled
        else -> this
    }

/**
 * Draws a web glyph at `size`, painted with `tint` (SVG currentColor; default the local content
 * colour), except parts the web paints with a fixed colour (the heart's `--seek-accent`, black
 * arrows). `tintAll` paints those too (the Liked Songs tile's white heart).
 *
 *     IconView(Icon.Heart, filled = liked, size = 24.dp, tint = theme.fgSub)
 */
@Composable
fun IconView(
    icon: Icon,
    modifier: Modifier = Modifier,
    filled: Boolean = false,
    size: Dp = 16.dp,
    tint: Color = LocalContentColor.current,
    tintAll: Boolean = false,
) {
    val spec = (if (filled) icon.filled else icon).spec
    val theme = LocalTheme.current
    Canvas(modifier.size(size).clearAndSetSemantics {}) { drawIcon(spec, theme, tint, tintAll) }
}

/** Paints `spec` centred in the draw area (shared by [IconView] and custom canvases). */
fun DrawScope.drawIcon(spec: IconSpec, theme: Theme, tint: Color, tintAll: Boolean = false) {
    val s = min(size.width, size.height) / spec.viewBox
    val dx = (size.width - spec.viewBox * s) / 2
    val dy = (size.height - spec.viewBox * s) / 2
    fun paint(p: IconPaint): Color = if (tintAll) tint else when (p) {
        IconPaint.Current -> tint
        IconPaint.SeekAccent -> theme.seekAccent
        IconPaint.Green -> theme.green
        is IconPaint.Rgb -> RGB.hex(p.hex).color
    }
    translate(dx, dy) {
        scale(s, s, pivot = Offset.Zero) {
            for (el in spec.elements) {
                val path = SvgPath.path(el.d, el.evenOdd)
                val r = el.rotate
                fun draw() {
                    el.fill?.let { drawPath(path, paint(it), alpha = el.opacity) }
                    el.stroke?.let {
                        drawPath(path, paint(it), alpha = el.opacity * el.strokeOpacity, style = Stroke(width = el.lineWidth, cap = el.cap, join = el.join))
                    }
                }
                if (r != null) rotate(r.degrees, pivot = Offset(r.cx, r.cy)) { draw() } else draw()
            }
        }
    }
}

/** Repeat button glyph. Repeat-one adds the "1" badge (DECISIONS: fix, do not copy). */
enum class RepeatGlyphMode { Off, All, One }

@Composable
fun RepeatGlyph(mode: RepeatGlyphMode, modifier: Modifier = Modifier, size: Dp = 18.dp, tint: Color = LocalContentColor.current) {
    Box(modifier) {
        IconView(Icon.Repeat, size = size, tint = tint)
        if (mode == RepeatGlyphMode.One) {
            val badge = size * 0.5f
            Box(
                Modifier.align(Alignment.TopEnd).offset(x = size * 0.18f, y = -size * 0.2f).size(badge)
                    .background(LocalTheme.current.page, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("1", color = tint, style = TextStyle(fontSize = max(7f, size.value * 0.42f).sp, fontWeight = FontWeight.Bold), modifier = Modifier.padding(horizontal = size * 0.06f))
            }
        }
    }
}

/** Shuffle button glyph. Smart shuffle adds the spark (the desktop footer's mark, Player.jsx:333). */
enum class ShuffleGlyphMode { Off, On, Smart }

@Composable
fun ShuffleGlyph(mode: ShuffleGlyphMode, modifier: Modifier = Modifier, size: Dp = 18.dp, tint: Color = LocalContentColor.current) {
    Box(modifier) {
        IconView(Icon.Shuffle, size = size, tint = tint)
        if (mode == ShuffleGlyphMode.Smart) {
            IconView(Icon.Spark, Modifier.align(Alignment.TopEnd).offset(x = size * 0.25f, y = -size * 0.22f), size = size * 0.5f, tint = tint)
        }
    }
}

/** The detail-page download button glyph (Library.jsx:2007-2026), drawn at `size` (24 on phone). */
sealed interface DownloadGlyphState {
    data object None : DownloadGlyphState
    data class Busy(val progress: Double) : DownloadGlyphState
    data object Part : DownloadGlyphState
    data object Done : DownloadGlyphState
}

@Composable
fun DownloadGlyph(state: DownloadGlyphState, modifier: Modifier = Modifier, size: Dp = 24.dp, tint: Color = LocalContentColor.current) {
    val theme = LocalTheme.current
    Canvas(modifier.size(size).clearAndSetSemantics {}) {
        val s = min(this.size.width, this.size.height) / 24f
        scale(s, s, pivot = Offset.Zero) {
            fun line(d: String, color: Color, w: Float) =
                drawPath(SvgPath.path(d), color, style = Stroke(width = w, cap = StrokeCap.Round, join = StrokeJoin.Round))
            when (state) {
                DownloadGlyphState.Part, DownloadGlyphState.Done -> {
                    drawCircle(tint, radius = 12f, center = Offset(12f, 12f))
                    line("M12 6v9m0 0-3.5-3.5M12 15l3.5-3.5M7.5 18h9", Color.Black, 1.8f)
                }
                DownloadGlyphState.None, is DownloadGlyphState.Busy -> {
                    val busy = state as? DownloadGlyphState.Busy
                    drawCircle(tint, radius = 10.5f, center = Offset(12f, 12f), alpha = if (busy != null) 0.3f else 1f, style = Stroke(1.5f))
                    if (busy != null) {
                        val sweep = 360f * max(0.03, min(1.0, busy.progress)).toFloat()
                        drawArc(theme.green, -90f, sweep, false, topLeft = Offset(1.5f, 1.5f), size = Size(21f, 21f), style = Stroke(1.5f))
                    }
                    line("M12 7v8m0 0-3-3m3 3 3-3", tint, 1.5f)
                }
            }
        }
    }
}
