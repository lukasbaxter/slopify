package com.lukasbaxter.slopify.android.design.icons

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/** One absolute drawing step in viewBox units. */
sealed interface PathOp {
    data class Move(val x: Float, val y: Float) : PathOp
    data class Line(val x: Float, val y: Float) : PathOp
    data class Cubic(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val x: Float, val y: Float) : PathOp
    data class Quad(val x1: Float, val y1: Float, val x: Float, val y: Float) : PathOp
    data object Close : PathOp
}

/**
 * Minimal SVG path-data parser (M L H V C S Q T A Z, absolute and relative), enough for every
 * path in web/src (ios Design/Icons/IconSpec.swift `SVGPath`). Arcs become cubic Béziers.
 * Pure Kotlin so the JVM tests run it; [toPath] makes the Compose path.
 */
object SvgPath {
    private val opsCache = HashMap<String, List<PathOp>>()
    private val pathCache = HashMap<Pair<String, Boolean>, Path>()

    @Synchronized fun ops(d: String): List<PathOp> = opsCache.getOrPut(d) { parse(d) }

    /** The Compose path in viewBox units, cached (callers must not mutate it). */
    @Synchronized fun path(d: String, evenOdd: Boolean = false): Path = pathCache.getOrPut(d to evenOdd) {
        toPath(ops(d)).apply { fillType = if (evenOdd) PathFillType.EvenOdd else PathFillType.NonZero }
    }

    fun toPath(ops: List<PathOp>): Path {
        val p = Path()
        for (op in ops) when (op) {
            is PathOp.Move -> p.moveTo(op.x, op.y)
            is PathOp.Line -> p.lineTo(op.x, op.y)
            is PathOp.Cubic -> p.cubicTo(op.x1, op.y1, op.x2, op.y2, op.x, op.y)
            is PathOp.Quad -> p.quadraticTo(op.x1, op.y1, op.x, op.y)
            PathOp.Close -> p.close()
        }
        return p
    }

    /** The pen position after the path (CGPath.currentPoint), for tests. */
    fun end(ops: List<PathOp>): Pair<Float, Float> {
        var cur = 0f to 0f
        var start = cur
        for (op in ops) when (op) {
            is PathOp.Move -> { cur = op.x to op.y; start = cur }
            is PathOp.Line -> cur = op.x to op.y
            is PathOp.Cubic -> cur = op.x to op.y
            is PathOp.Quad -> cur = op.x to op.y
            PathOp.Close -> cur = start
        }
        return cur
    }

    /** Tight bounds of the drawn outline (curves sampled), like CGPath.boundingBoxOfPath. */
    fun bounds(ops: List<PathOp>): Rect {
        var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE; var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
        fun add(x: Float, y: Float) { minX = minOf(minX, x); minY = minOf(minY, y); maxX = maxOf(maxX, x); maxY = maxOf(maxY, y) }
        var cx = 0f; var cy = 0f
        for (op in ops) when (op) {
            is PathOp.Move -> { cx = op.x; cy = op.y; add(cx, cy) }
            is PathOp.Line -> { cx = op.x; cy = op.y; add(cx, cy) }
            is PathOp.Cubic -> {
                for (i in 1..16) {
                    val t = i / 16f; val u = 1 - t
                    add(u * u * u * cx + 3 * u * u * t * op.x1 + 3 * u * t * t * op.x2 + t * t * t * op.x,
                        u * u * u * cy + 3 * u * u * t * op.y1 + 3 * u * t * t * op.y2 + t * t * t * op.y)
                }
                cx = op.x; cy = op.y
            }
            is PathOp.Quad -> {
                for (i in 1..16) {
                    val t = i / 16f; val u = 1 - t
                    add(u * u * cx + 2 * u * t * op.x1 + t * t * op.x, u * u * cy + 2 * u * t * op.y1 + t * t * op.y)
                }
                cx = op.x; cy = op.y
            }
            PathOp.Close -> Unit
        }
        return if (minX > maxX) Rect.Zero else Rect(minX, minY, maxX, maxY)
    }

    fun parse(d: String): List<PathOp> {
        val out = ArrayList<PathOp>()
        val t = Tokenizer(d)
        var cmd = 0.toChar()
        var curX = 0f; var curY = 0f; var startX = 0f; var startY = 0f
        var lastCtrl: Pair<Float, Float>? = null
        var lastQuad: Pair<Float, Float>? = null
        while (true) {
            val peek = t.peekCommand()
            val next = peek ?: if (cmd != 0.toChar() && t.hasNumber()) cmd else break
            if (peek != null) t.skip()
            cmd = next
            val rel = cmd.isLowerCase()
            fun px(x: Float) = if (rel) curX + x else x
            fun py(y: Float) = if (rel) curY + y else y
            var ctrl: Pair<Float, Float>? = null
            var quad: Pair<Float, Float>? = null
            when (cmd.lowercaseChar()) {
                'm' -> {
                    val x = t.number() ?: return out; val y = t.number() ?: return out
                    curX = px(x); curY = py(y); startX = curX; startY = curY
                    out += PathOp.Move(curX, curY)
                    cmd = if (rel) 'l' else 'L' // following pairs are lineto
                }
                'l' -> {
                    val x = t.number() ?: return out; val y = t.number() ?: return out
                    curX = px(x); curY = py(y); out += PathOp.Line(curX, curY)
                }
                'h' -> { val x = t.number() ?: return out; curX = px(x); out += PathOp.Line(curX, curY) }
                'v' -> { val y = t.number() ?: return out; curY = py(y); out += PathOp.Line(curX, curY) }
                'c' -> {
                    val x1 = t.number() ?: return out; val y1 = t.number() ?: return out
                    val x2 = t.number() ?: return out; val y2 = t.number() ?: return out
                    val x = t.number() ?: return out; val y = t.number() ?: return out
                    val c2 = px(x2) to py(y2)
                    val ex = px(x); val ey = py(y)
                    out += PathOp.Cubic(px(x1), py(y1), c2.first, c2.second, ex, ey)
                    curX = ex; curY = ey; ctrl = c2
                }
                's' -> {
                    val x2 = t.number() ?: return out; val y2 = t.number() ?: return out
                    val x = t.number() ?: return out; val y = t.number() ?: return out
                    val c1 = lastCtrl?.let { (2 * curX - it.first) to (2 * curY - it.second) } ?: (curX to curY)
                    val c2 = px(x2) to py(y2)
                    val ex = px(x); val ey = py(y)
                    out += PathOp.Cubic(c1.first, c1.second, c2.first, c2.second, ex, ey)
                    curX = ex; curY = ey; ctrl = c2
                }
                'q' -> {
                    val x1 = t.number() ?: return out; val y1 = t.number() ?: return out
                    val x = t.number() ?: return out; val y = t.number() ?: return out
                    val c = px(x1) to py(y1)
                    val ex = px(x); val ey = py(y)
                    out += PathOp.Quad(c.first, c.second, ex, ey)
                    curX = ex; curY = ey; quad = c
                }
                't' -> {
                    val x = t.number() ?: return out; val y = t.number() ?: return out
                    val c = lastQuad?.let { (2 * curX - it.first) to (2 * curY - it.second) } ?: (curX to curY)
                    val ex = px(x); val ey = py(y)
                    out += PathOp.Quad(c.first, c.second, ex, ey)
                    curX = ex; curY = ey; quad = c
                }
                'a' -> {
                    val rx = t.number() ?: return out; val ry = t.number() ?: return out; val rot = t.number() ?: return out
                    val large = t.flag() ?: return out; val sweep = t.flag() ?: return out
                    val x = t.number() ?: return out; val y = t.number() ?: return out
                    val ex = px(x); val ey = py(y)
                    arc(out, curX, curY, ex, ey, rx, ry, rot, large, sweep)
                    curX = ex; curY = ey
                }
                'z' -> {
                    out += PathOp.Close; curX = startX; curY = startY
                    cmd = 0.toChar() // a number after Z is invalid; stop repeating
                }
                else -> return out
            }
            lastCtrl = ctrl; lastQuad = quad
        }
        return out
    }

    /** SVG endpoint arc (F.6.5 of the SVG spec) as cubic segments. */
    private fun arc(out: MutableList<PathOp>, x0: Float, y0: Float, x1p: Float, y1p: Float, rx0: Float, ry0: Float, angle: Float, large: Boolean, sweep: Boolean) {
        if (x0 == x1p && y0 == y1p) return
        var rx = abs(rx0).toDouble(); var ry = abs(ry0).toDouble()
        if (rx == 0.0 || ry == 0.0) { out += PathOp.Line(x1p, y1p); return }
        val phi = angle * Math.PI / 180; val cosP = cos(phi); val sinP = sin(phi)
        val dx = (x0 - x1p) / 2.0; val dy = (y0 - y1p) / 2.0
        val x1 = cosP * dx + sinP * dy; val y1 = -sinP * dx + cosP * dy
        val lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if (lambda > 1) { val s = sqrt(lambda); rx *= s; ry *= s }
        val num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        val den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var coef = sqrt(maxOf(0.0, num / den))
        if (large == sweep) coef = -coef
        val cx1 = coef * rx * y1 / ry; val cy1 = -coef * ry * x1 / rx
        val cx = cosP * cx1 - sinP * cy1 + (x0 + x1p) / 2.0
        val cy = sinP * cx1 + cosP * cy1 + (y0 + y1p) / 2.0
        fun ang(ux: Double, uy: Double, vx: Double, vy: Double) = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        val t1 = ang(1.0, 0.0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if (!sweep && dt > 0) dt -= 2 * Math.PI else if (sweep && dt < 0) dt += 2 * Math.PI
        val segs = ceil(abs(dt) / (Math.PI / 2)).toInt()
        val step = dt / segs
        val k = 4.0 / 3.0 * tan(step / 4)
        fun point(a: Double): Pair<Double, Double> {
            val x = rx * cos(a); val y = ry * sin(a)
            return (cosP * x - sinP * y + cx) to (sinP * x + cosP * y + cy)
        }
        fun deriv(a: Double): Pair<Double, Double> {
            val x = -rx * sin(a); val y = ry * cos(a)
            return (cosP * x - sinP * y) to (sinP * x + cosP * y)
        }
        var t = t1
        for (i in 0 until segs) {
            val a = t; val b = t + step
            val pa = point(a)
            val pb = if (i == segs - 1) x1p.toDouble() to y1p.toDouble() else point(b)
            val da = deriv(a); val db = deriv(b)
            out += PathOp.Cubic(
                (pa.first + k * da.first).toFloat(), (pa.second + k * da.second).toFloat(),
                (pb.first - k * db.first).toFloat(), (pb.second - k * db.second).toFloat(),
                pb.first.toFloat(), pb.second.toFloat(),
            )
            t = b
        }
    }

    private class Tokenizer(private val s: String) {
        private var i = 0

        private fun skipSeparators() {
            while (i < s.length && (s[i] == ' ' || s[i] == ',' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
        }

        fun peekCommand(): Char? {
            skipSeparators()
            if (i >= s.length) return null
            val c = s[i]
            return if (c.isLetter() && c != 'e' && c != 'E') c else null
        }

        fun skip() { i++ }

        fun hasNumber(): Boolean {
            skipSeparators()
            if (i >= s.length) return false
            val c = s[i]
            return c == '-' || c == '+' || c == '.' || c in '0'..'9'
        }

        /** SVG number grammar: sign, digits, one dot, exponent. "1.5.5" is 1.5 then .5. */
        fun number(): Float? {
            skipSeparators()
            val st = i
            if (i < s.length && (s[i] == '-' || s[i] == '+')) i++
            var dot = false; var digits = false
            while (i < s.length) {
                val c = s[i]
                if (c in '0'..'9') { digits = true; i++ } else if (c == '.' && !dot) { dot = true; i++ } else break
            }
            if (digits && i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                var j = i + 1
                if (j < s.length && (s[j] == '-' || s[j] == '+')) j++
                if (j < s.length && s[j] in '0'..'9') {
                    i = j
                    while (i < s.length && s[i] in '0'..'9') i++
                }
            }
            val v = if (digits) s.substring(st, i).toFloatOrNull() else null
            if (v == null) i = st
            return v
        }

        /** Arc flags may be packed without separators ("a1 1 0 011 1"). */
        fun flag(): Boolean? {
            skipSeparators()
            if (i >= s.length || (s[i] != '0' && s[i] != '1')) return null
            return s[i++] == '1'
        }
    }
}
