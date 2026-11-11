package com.lukasbaxter.slopify.android.features.account

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * "Daily" / "Cumulative" line chart (History.jsx `LineChart`, UI.md 7.5.5 #5). Drawn in dp with
 * 11 sp labels (DECISIONS: readable labels); touch shows the point, a sideways drag scrubs
 * (DECISIONS fix), a vertical drag scrolls the page.
 */
@Composable
internal fun AccountHistoryLineChart(title: String, points: List<AccountHistoryLogic.Point>) {
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val locale = Localizer.shared.locale
    var hover by remember { mutableStateOf<Int?>(null) }
    val padL = 44.dp
    val padR = 12.dp
    val padT = 12.dp
    val padB = 24.dp
    val summary = points.lastOrNull()?.let { "${it.label}: ${AccountHistoryLogic.streams(it.streams.toInt(), locale)}" }.orEmpty()
    Column(
        Modifier.fillMaxWidth().background(theme.card, AccountCardShape).padding(top = 12.dp, start = 12.dp, end = 12.dp, bottom = 8.dp)
            .clearAndSetSemantics { contentDescription = "$title. $summary" },
    ) {
        Text(title, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = theme.fg, modifier = Modifier.padding(horizontal = 4.dp).padding(bottom = 4.dp))
        BoxWithConstraints(Modifier.fillMaxWidth().height(170.dp)) {
            val wPx = constraints.maxWidth.toFloat()
            val hPx = constraints.maxHeight.toFloat()
            val l = with(density) { padL.toPx() }
            val r = with(density) { padR.toPx() }
            val t = with(density) { padT.toPx() }
            val b = with(density) { padB.toPx() }
            val n = points.size
            val maxV = max(1.0, points.maxOfOrNull { max(it.streams, it.minutes) } ?: 1.0)
            val ticks = AccountHistoryLogic.ticks(maxV)
            val top = ticks.lastOrNull() ?: 1.0
            val pw = wPx - l - r
            val ph = hPx - t - b
            fun x(i: Int) = l + if (n > 1) i.toFloat() / (n - 1) * pw else pw / 2
            fun y(v: Double) = t + (1 - (v / top).toFloat()) * ph
            val labelIdx = AccountHistoryLogic.xLabelIndices(n)
            val labelStyle = TextStyle(fontSize = 11.sp, color = theme.fgFaint)
            val green = theme.green
            val grid = theme.fg(0.06)
            val cross = theme.fg(0.35)
            Canvas(
                Modifier.fillMaxSize().pointerInput(n, wPx) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        hover = AccountHistoryLogic.scrubIndex(down.position.x.toDouble(), l.toDouble(), (wPx - r).toDouble(), n)
                        var total = Offset.Zero
                        var sideways: Boolean? = null
                        while (true) {
                            val e = awaitPointerEvent()
                            val c = e.changes.firstOrNull { it.id == down.id } ?: break
                            if (!c.pressed) break
                            total += c.positionChange()
                            if (sideways == null && total.getDistance() > viewConfiguration.touchSlop) sideways = abs(total.x) > abs(total.y)
                            if (sideways == false) break
                            if (sideways == true) c.consume()
                            hover = AccountHistoryLogic.scrubIndex(c.position.x.toDouble(), l.toDouble(), (wPx - r).toDouble(), n)
                        }
                        hover = null
                    }
                },
            ) {
                for (v in ticks) {
                    drawLine(grid, Offset(l, y(v)), Offset(size.width - r, y(v)), 1.dp.toPx())
                    drawLabel(measurer, AccountHistoryLogic.number(v, locale), labelStyle, Offset(l - 8.dp.toPx(), y(v)), LabelAnchor.Trailing)
                }
                for (i in labelIdx) {
                    val anchor = if (i == 0) LabelAnchor.Leading else if (i == n - 1) LabelAnchor.Trailing else LabelAnchor.Center
                    drawLabel(measurer, points[i].label, labelStyle, Offset(x(i), size.height - 8.dp.toPx()), anchor)
                }
                if (n > 0) {
                    val stroke = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
                    fun line(pick: (AccountHistoryLogic.Point) -> Double) = Path().apply {
                        points.forEachIndexed { i, p -> if (i == 0) moveTo(x(i), y(pick(p))) else lineTo(x(i), y(pick(p))) }
                    }
                    drawPath(line { it.minutes }, green.copy(alpha = 0.45f), style = stroke)
                    drawPath(line { it.streams }, green, style = stroke)
                }
                val i = hover
                if (i != null && i in points.indices) {
                    drawLine(cross, Offset(x(i), t), Offset(x(i), size.height - b), 1.dp.toPx(),
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx())))
                    drawCircle(green.copy(alpha = 0.45f), 4.dp.toPx(), Offset(x(i), y(points[i].minutes)))
                    drawCircle(green, 4.dp.toPx(), Offset(x(i), y(points[i].streams)))
                }
            }
            val i = hover
            if (i != null && i in points.indices) {
                val p = points[i]
                var boxW by remember { mutableIntStateOf(0) }
                val left = min(max(0f, x(i) - boxW / 2f), max(0f, wPx - boxW))
                val s = p.streams.toInt()
                val m = p.minutes.toInt()
                Column(
                    Modifier.offset { IntOffset(left.roundToInt(), 28.dp.roundToPx()) }
                        .onSizeChanged { boxW = it.width }
                        .background(theme.page, RoundedCornerShape(8.dp))
                        .border(1.dp, theme.fg(0.08), RoundedCornerShape(8.dp))
                        .padding(vertical = 6.dp, horizontal = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(p.label, fontSize = 12.sp, fontWeight = FontWeight.Bold, color = theme.fg)
                    Text(if (s == 1) L("1 stream") else L("{n} streams", "n" to AccountHistoryLogic.number(s, locale)), fontSize = 12.sp, color = theme.fg)
                    Text(if (m == 1) L("1 minute streamed") else L("{n} minutes streamed", "n" to AccountHistoryLogic.number(m, locale)), fontSize = 12.sp, color = theme.fg)
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterHorizontally)) {
            LegendDot(green = 1f, L("streams"))
            LegendDot(green = 0.45f, L("minutes streamed"))
        }
    }
}

@Composable
private fun LegendDot(green: Float, label: String) {
    val theme = LocalTheme.current
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(theme.green.copy(alpha = green), CircleShape))
        Text(label, fontSize = 12.sp, color = theme.fgSub)
    }
}

private enum class LabelAnchor { Leading, Center, Trailing }

/** A text label vertically centred on `at`, its leading/centre/trailing edge at `at.x`. */
private fun DrawScope.drawLabel(measurer: TextMeasurer, text: String, style: TextStyle, at: Offset, anchor: LabelAnchor) {
    val m = measurer.measure(text, style)
    val w = m.size.width.toFloat()
    val x = when (anchor) {
        LabelAnchor.Leading -> at.x
        LabelAnchor.Center -> at.x - w / 2
        LabelAnchor.Trailing -> at.x - w
    }
    drawText(m, topLeft = Offset(x, at.y - m.size.height / 2f))
}

/**
 * Listening clock (History.jsx `Clock`): 24 equal wedges from 12 o'clock clockwise, radius by
 * value, spokes, hour labels 0/6/12/18. Drawn in a 320 box scaled to the width (max 360).
 * Tapping a wedge shows its hour and value (the web's native SVG tooltip).
 */
@Composable
internal fun AccountHistoryClock(values: List<Double>, format: (Double) -> String) {
    val theme = LocalTheme.current
    val measurer = rememberTextMeasurer()
    var picked by remember(values) { mutableStateOf<Int?>(null) }
    val fr = AccountHistoryLogic.clockFractions(values)
    val label = values.withIndex().filter { it.value > 0 }.joinToString(", ") { "${AccountHistoryLogic.hourLabel(it.index)}: ${format(it.value)}" }
    Column(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = label }, horizontalAlignment = Alignment.CenterHorizontally) {
        val green = theme.green
        val spoke = theme.fg(0.12)
        val page = theme.page
        val hourStyle = TextStyle(fontSize = 12.sp, color = theme.fgFaint)
        Canvas(
            Modifier.widthIn(max = 360.dp).fillMaxWidth().aspectRatio(1f).pointerInput(values) {
                detectTapGestures { pos ->
                    val c = Offset(size.width / 2f, size.height / 2f)
                    val d = pos - c
                    val r = sqrt(d.x * d.x + d.y * d.y)
                    if (r > 150f * min(size.width, size.height) / 320f) { picked = null; return@detectTapGestures }
                    // Angle from 12 o'clock, clockwise.
                    var a = atan2(d.y.toDouble(), d.x.toDouble()) + PI / 2
                    if (a < 0) a += 2 * PI
                    val i = (a / (PI / 12)).toInt() % 24
                    picked = if (picked == i) null else i
                }
            },
        ) {
            val s = min(size.width, size.height) / 320f
            val c = Offset(size.width / 2, size.height / 2)
            val big = 150f * s
            fun pt(a: Double, r: Float) = Offset(c.x + r * cos(a).toFloat(), c.y + r * sin(a).toFloat())
            for (i in fr.indices) drawLine(spoke, c, pt(-PI / 2 + i * PI / 12, big), 1.dp.toPx())
            fr.forEachIndexed { i, f ->
                if (f <= 0) return@forEachIndexed
                val start = -90f + i * 15f
                val rr = big * f.toFloat()
                val alpha = if (picked == null || picked == i) 1f else 0.5f
                val tl = Offset(c.x - rr, c.y - rr)
                val sz = Size(rr * 2, rr * 2)
                drawArc(green.copy(alpha = alpha), start, 15f, useCenter = true, topLeft = tl, size = sz)
                drawArc(page, start, 15f, useCenter = true, topLeft = tl, size = sz, style = Stroke(2.dp.toPx()))
            }
            for ((h, hx, hy) in listOf(Triple(0, 160f, 14f), Triple(6, 310f, 164f), Triple(12, 160f, 314f), Triple(18, 10f, 164f))) {
                drawLabel(measurer, "$h", hourStyle, Offset(c.x + (hx - 160) * s, c.y + (hy - 4 - 160) * s), LabelAnchor.Center)
            }
        }
        val p = picked
        Text(
            if (p != null) "${AccountHistoryLogic.hourLabel(p)}: ${format(values.getOrElse(p) { 0.0 })}" else " ",
            fontSize = 12.sp, color = theme.fgSub, modifier = Modifier.padding(top = 4.dp),
        )
    }
}
