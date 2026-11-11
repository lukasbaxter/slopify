package com.lukasbaxter.slopify.android.design.color

import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Pure colour maths ported from the web (via ios Design/Color/ColorMath.swift), so tests check
 * it against values the JS computed (test resources design/ColorFixtures.json, made by
 * ios/tools/color-fixtures.mjs). Pixels are RGBA bytes (0..255 ints), row-major, as a canvas
 * `getImageData` returns them.
 */
object ColorMath {
    data class Hsl(val h: Double, val s: Double, val l: Double)

    /** colors.js `rgbToHsl`: h, s, l in 0..1. */
    fun rgbToHsl(r0: Double, g0: Double, b0: Double): Hsl {
        val r = r0 / 255; val g = g0 / 255; val b = b0 / 255
        val mx = maxOf(r, g, b); val mn = minOf(r, g, b); val l = (mx + mn) / 2
        if (mx == mn) return Hsl(0.0, 0.0, l)
        val d = mx - mn
        val s = if (l > 0.5) d / (2 - mx - mn) else d / (mx + mn)
        val h = when (mx) {
            r -> (g - b) / d + (if (g < b) 6 else 0)
            g -> (b - r) / d + 2
            else -> (r - g) / d + 4
        }
        return Hsl(h / 6, s, l)
    }

    /** colors.js `hslToRgb`, rounded channels. */
    fun hslToRgb(h: Double, s: Double, l: Double): IntArray {
        fun f(n: Double): Int {
            val k = (n + h * 12) % 12
            val a = s * min(l, 1 - l)
            return jsRound(255 * (l - a * max(-1.0, minOf(k - 3, 9 - k, 1.0))))
        }
        return intArrayOf(f(0.0), f(8.0), f(4.0))
    }

    /** JS `Math.round` (halves go up). */
    fun jsRound(x: Double): Int = floor(x + 0.5).toInt()

    private class Bin { var n = 0.0; var r = 0.0; var g = 0.0; var b = 0.0; var h = 0.0; var s = 0.0; var l = 0.0 }
    private fun key(r: Int, g: Int, b: Int): Int = (r shr 4 shl 8) or (g shr 4 shl 4) or (b shr 4)

    /** colors.js `vibrantColor` on 40x40 pixels: the most prominent saturated mid-tone bin's mean. */
    fun vibrant(px: IntArray): RGB? {
        val bins = ArrayList<Bin>() // insertion order matters for ties
        val index = HashMap<Int, Int>()
        var i = 0
        while (i + 3 < px.size) {
            val r = px[i]; val g = px[i + 1]; val b = px[i + 2]; i += 4
            val hsl = rgbToHsl(r.toDouble(), g.toDouble(), b.toDouble())
            if (hsl.l < 0.08 || hsl.l > 0.92) continue
            val k = key(r, g, b)
            val at = index.getOrPut(k) { bins.add(Bin()); bins.size - 1 }
            val e = bins[at]
            e.n += 1; e.r += r; e.g += g; e.b += b; e.s += hsl.s; e.l += hsl.l
        }
        var best: Bin? = null
        var bestScore = -1.0
        for (e in bins) {
            val s = e.s / e.n; val l = e.l / e.n
            val score = e.n * (0.15 + s) * (if (l > 0.2 && l < 0.75) 1.0 else 0.35)
            if (score > bestScore) { bestScore = score; best = e }
        }
        val e = best ?: return null
        return RGB(jsRound(e.r / e.n).toDouble(), jsRound(e.g / e.n).toDouble(), jsRound(e.b / e.n).toDouble())
    }

    private class E(val rgb: IntArray, val h: Double, val s: Double, val l: Double, val score: Double)

    /** colors.js `paletteColors` on 48x48 pixels: three gradient stops, light to dark. */
    fun palette(px: IntArray): List<RGB>? {
        val bins = ArrayList<Bin>()
        val index = HashMap<Int, Int>()
        var total = 0; var neutral = 0; var i = 0
        while (i + 3 < px.size) {
            val r = px[i]; val g = px[i + 1]; val b = px[i + 2]; i += 4
            val hsl = rgbToHsl(r.toDouble(), g.toDouble(), b.toDouble())
            total += 1
            if (hsl.s < 0.15 || hsl.l < 0.08 || hsl.l > 0.92) neutral += 1
            if (hsl.l < 0.08 || hsl.l > 0.94) continue
            val k = key(r, g, b)
            val at = index.getOrPut(k) { bins.add(Bin()); bins.size - 1 }
            val e = bins[at]
            e.n += 1; e.r += r; e.g += g; e.b += b; e.h += hsl.h; e.s += hsl.s; e.l += hsl.l
        }
        if (total > 0 && neutral.toDouble() / total >= 0.6) return listOf(RGB.hex(0xffffff), RGB.hex(0xe2e2e2), RGB.hex(0xbebebe))
        val scored = bins.mapIndexed { idx, b ->
            val l = b.l / b.n; val s = b.s / b.n
            val lightness = if (l > 0.2 && l < 0.8) 1.0 else 0.35
            idx to E(intArrayOf(jsRound(b.r / b.n), jsRound(b.g / b.n), jsRound(b.b / b.n)), b.h / b.n, s, l, b.n * (0.15 + s) * lightness)
        }.sortedWith(compareByDescending<Pair<Int, E>> { it.second.score }.thenBy { it.first })
        fun hueDist(a: Double, b: Double): Double { val x = abs(a - b); return min(x, 1 - x) }
        val out = ArrayList<E>()
        for ((_, e) in scored) {
            if (out.size >= 3) break
            if (out.all { hueDist(it.h, e.h) > 0.08 || abs(it.l - e.l) > 0.3 } && e.s > 0.12) out.add(e)
        }
        val first = out.firstOrNull() ?: return null
        fun shift(e: E, dl: Double): E {
            val l = max(0.15, min(0.85, e.l + dl))
            return E(hslToRgb(e.h, max(e.s, 0.35), l), e.h, e.s, l, 0.0)
        }
        while (out.size < 3) out.add(shift(first, if (out.size == 1) 0.22 else -0.22))
        val byLight = out.mapIndexed { idx, e -> idx to e }.sortedWith(compareByDescending<Pair<Int, E>> { it.second.l }.thenBy { it.first }).map { it.second }
        val floorL = doubleArrayOf(0.66, 0.54, 0.42)
        return byLight.mapIndexed { idx, e ->
            val c = hslToRgb(e.h, min(0.62, max(e.s, 0.38)), max(e.l, floorL[idx]))
            RGB(c[0].toDouble(), c[1].toDouble(), c[2].toDouble())
        }
    }

    /**
     * Player.jsx `clampLightness`: lightness into [lo, hi], hue and saturation kept.
     * Mini player card colour: `clampLightness(vibrant)`.
     */
    fun clampLightness(c: RGB, lo: Double = 0.18, hi: Double = 0.30): RGB {
        val r = c.r / 255; val g = c.g / 255; val b = c.b / 255
        val mx = maxOf(r, g, b); val mn = minOf(r, g, b)
        var h = 0.0
        val l = (mx + mn) / 2; val d = mx - mn
        val sat = if (d == 0.0) 0.0 else d / (1 - abs(2 * l - 1))
        if (d != 0.0) {
            h = when (mx) {
                r -> ((g - b) / d) % 6
                g -> (b - r) / d + 2
                else -> (r - g) / d + 4
            }
            h = (h * 60 + 360) % 360
        }
        val nl = min(hi, max(lo, l))
        if (nl == l) return c
        val cc = (1 - abs(2 * nl - 1)) * sat
        val x = cc * (1 - abs((h / 60) % 2 - 1)); val m = nl - cc / 2
        val (r2, g2, b2) = when {
            h < 60 -> Triple(cc, x, 0.0)
            h < 120 -> Triple(x, cc, 0.0)
            h < 180 -> Triple(0.0, cc, x)
            h < 240 -> Triple(0.0, x, cc)
            h < 300 -> Triple(x, 0.0, cc)
            else -> Triple(cc, 0.0, x)
        }
        return RGB(jsRound((r2 + m) * 255).toDouble(), jsRound((g2 + m) * 255).toDouble(), jsRound((b2 + m) * 255).toDouble())
    }

    /**
     * Library.jsx `heroTint(rgb, phone: true)` as the browser paints it:
     * `color-mix(in srgb, hsl(H S% L%) 55%, #121212)` with S clamped to 30..65% and L to 24..38%.
     */
    fun heroTint(c: RGB): RGB {
        val r = c.r / 255; val g = c.g / 255; val b = c.b / 255
        val mx = maxOf(r, g, b); val mn = minOf(r, g, b); val l = (mx + mn) / 2
        var h = 0.0; var sat = 0.0
        if (mx != mn) {
            val d = mx - mn
            sat = if (l > 0.5) d / (2 - mx - mn) else d / (mx + mn)
            h = when (mx) {
                r -> (g - b) / d + (if (g < b) 6 else 0)
                g -> (b - r) / d + 2
                else -> (r - g) / d + 4
            }
            h /= 6
        }
        sat = min(0.65, if (sat > 0.04) max(sat, 0.3) else sat)
        val bigL = min(0.38, max(0.24, l))
        val base = cssHsl(jsRound(h * 360).toDouble(), jsRound(sat * 100).toDouble(), jsRound(bigL * 100).toDouble())
        return base.colorMix(0.55, RGB.hex(0x121212))
    }

    /** Library.jsx `phoneHero(hex)`: fixed palette colours through the same clamp. Null for a bad hex. */
    fun phoneHero(hex: String): RGB? = RGB.strictHex(hex)?.let(::heroTint)

    /** CSS Color 4 `hsl(h s% l%)` to sRGB 0..255 (unrounded). */
    fun cssHsl(h: Double, s0: Double, l0: Double): RGB {
        val s = s0 / 100; val l = l0 / 100
        fun f(n: Double): Double {
            val k = (n + h / 30) % 12
            val a = s * min(l, 1 - l)
            return (l - a * max(-1.0, minOf(k - 3, 9 - k, 1.0))) * 255
        }
        return RGB(f(0.0), f(8.0), f(4.0))
    }

    private const val BLURHASH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~"

    /** Library.jsx `blurhashAverage`: the DC term of a blurhash (instant hero tint before sampling). */
    fun blurhashAverage(hash: String?): RGB? {
        if (hash == null || hash.length < 6) return null
        var v = 0
        for (ch in hash.substring(2, 6)) {
            val i = BLURHASH.indexOf(ch)
            if (i < 0) return null
            v = v * 83 + i
        }
        return RGB((v shr 16 and 255).toDouble(), (v shr 8 and 255).toDouble(), (v and 255).toDouble())
    }

    /** Detail page `--hero` precedence (UI.md 6.3.1 step 5), given what is known. */
    fun detailHero(mixColor: String? = null, sampled: RGB? = null, isArtist: Boolean = false, isLiked: Boolean = false): RGB {
        if (mixColor != null) phoneHero(mixColor)?.let { return it }
        if (!isArtist && sampled != null) return heroTint(sampled)
        if (isLiked) return heroTint(Theme.Fixed.likedHero)
        if (isArtist && sampled != null) return heroTint(sampled)
        return Theme.Fixed.defaultHero
    }
}
