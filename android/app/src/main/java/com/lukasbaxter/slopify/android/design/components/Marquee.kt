package com.lukasbaxter.slopify.android.design.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * One line that ping-pongs when it overflows (Marquee.jsx, app.css:666-683; UI.md 3.6; ios
 * Marquee.swift). `dist = textWidth - boxWidth`; when > 0 the text moves to `-(dist + 24)` over
 * `D = 4 + dist/30` s per direction, holding 25 % at each end, linear, alternating. The right
 * edge fades over 28 always; the left 20 fade shows only while moving. Static when it fits.
 * Never wider than the width offered.
 */
@Composable
fun Marquee(text: String, modifier: Modifier = Modifier, style: TextStyle = TextStyle.Default, color: Color = Color.Unspecified) {
    BoxWithConstraints(modifier.fillMaxWidth().semantics { contentDescription = text }) {
        val density = LocalDensity.current
        val measurer = rememberTextMeasurer()
        val textPx = remember(text, style, density) { measurer.measure(text, style, maxLines = 1, softWrap = false, constraints = Constraints()).size.width }
        val boxPx = if (constraints.hasBoundedWidth) constraints.maxWidth else textPx
        val distPx = max(0, textPx - boxPx)
        if (distPx <= 0) {
            Text(text, style = style, color = color, maxLines = 1, softWrap = false, overflow = TextOverflow.Clip)
            return@BoxWithConstraints
        }
        val distDp = with(density) { distPx.toDp().value }
        var seconds by remember { mutableDoubleStateOf(0.0) }
        LaunchedEffect(text, distDp) {
            val start = withFrameNanos { it }
            while (true) withFrameNanos { seconds = (it - start) / 1e9 }
        }
        Box(
            Modifier.fillMaxWidth().clipToBounds()
                .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                .drawWithContent {
                    drawContent()
                    val moving = MarqueeMath.offset(seconds, distDp).second
                    drawRect(marqueeMask(size.width, 20.dp.toPx(), 28.dp.toPx(), moving), blendMode = BlendMode.DstIn)
                },
        ) {
            Text(
                text, style = style, color = color, maxLines = 1, softWrap = false,
                modifier = Modifier
                    .wrapContentWidth(Alignment.Start, unbounded = true)
                    .offset { IntOffset((MarqueeMath.offset(seconds, distDp).first * density.density).roundToInt(), 0) },
            )
        }
    }
}

/** The marquee's timing, pure for tests. */
object MarqueeMath {
    /** Position (dp) and whether the left fade is on, `t` seconds into the loop. */
    fun offset(t: Double, dist: Float): Pair<Float, Boolean> {
        val d = 4 + dist / 30.0
        val cycle = ((t % (2 * d)) + 2 * d) % (2 * d)
        val forward = cycle < d
        val p = if (forward) cycle / d else 1 - (cycle - d) / d // alternate
        val move = min(1.0, max(0.0, (p - 0.25) / 0.5))
        return (-move * (dist + 24)).toFloat() to (p > 0.25)
    }
}

/**
 * Entity title ladder 96 -> 72 -> 48 -> 32 at weight 800 until it fits `maxLines` (FittedTitle.jsx).
 * The phone forces a fixed 24 on detail heroes (UI.md 6.3.2), so use this only where the web's
 * phone CSS does not override it.
 */
@Composable
fun FittedTitle(text: String, modifier: Modifier = Modifier, maxLines: Int = 2, color: Color = Color.Unspecified) {
    BoxWithConstraints(modifier) {
        val measurer = rememberTextMeasurer()
        val c = constraints
        val size = remember(text, c, maxLines) {
            FITTED_LADDER.firstOrNull { s ->
                val r = measurer.measure(text, fittedStyle(s), maxLines = maxLines, constraints = Constraints(maxWidth = c.maxWidth))
                !r.hasVisualOverflow && (!c.hasBoundedHeight || r.size.height <= c.maxHeight)
            } ?: FITTED_LADDER.last()
        }
        Text(text, style = fittedStyle(size), color = color, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
    }
}

val FITTED_LADDER = listOf(96, 72, 48, 32)

private fun fittedStyle(size: Int) = TextStyle(fontSize = size.sp, fontWeight = FontWeight.ExtraBold, lineHeight = (size * 1.05).sp)

/** Left fade (only while moving), solid middle, right fade. */
private fun marqueeMask(width: Float, left: Float, right: Float, leftFade: Boolean): Brush = Brush.horizontalGradient(
    0f to (if (leftFade) Color.Transparent else Color.Black),
    (left / width).coerceIn(0f, 1f) to Color.Black,
    (1 - right / width).coerceIn(0f, 1f) to Color.Black,
    1f to Color.Transparent,
)

