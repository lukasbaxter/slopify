package com.lukasbaxter.slopify.android.design.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * An sRGB colour with 0..255 channels (Double so blends stay exact until they are rounded,
 * as the web's `mix()` and CSS `color-mix()` do). `alpha` is 0..1. (ios Design/Theme/RGB.swift)
 */
@Immutable
data class RGB(val r: Double, val g: Double, val b: Double, val alpha: Double = 1.0) {

    /** Channels rounded and clamped the way the web's `clamp()` does. */
    val rounded: RGB get() = RGB(clamp(r), clamp(g), clamp(b), alpha)
    val ints: List<Int> get() = listOf(clamp(r).toInt(), clamp(g).toInt(), clamp(b).toInt())

    /** Lowercase `#rrggbb`. */
    val hex: String get() = "#" + ints.joinToString("") { "%02x".format(it) }

    override fun toString(): String = if (alpha < 1) "$hex@$alpha" else hex

    val color: Color get() = Color(red = (r / 255).toFloat().coerceIn(0f, 1f), green = (g / 255).toFloat().coerceIn(0f, 1f),
        blue = (b / 255).toFloat().coerceIn(0f, 1f), alpha = alpha.toFloat().coerceIn(0f, 1f))

    fun opacity(a: Double): RGB = copy(alpha = a)

    /** Web `mix(a, b, t)`: per-channel linear blend towards `other` by `t`, rounded. */
    fun mix(other: RGB, t: Double): RGB = RGB(r + (other.r - r) * t, g + (other.g - g) * t, b + (other.b - b) * t).rounded

    /** CSS `color-mix(in srgb, self p, other)`: `p` of self, the rest of `other`, rounded. */
    fun colorMix(p: Double, other: RGB): RGB =
        RGB(r * p + other.r * (1 - p), g * p + other.g * (1 - p), b * p + other.b * (1 - p)).rounded

    /** Web `isLight`: YIQ brightness over 140. */
    val isLight: Boolean get() = (r * 299 + g * 587 + b * 114) / 1000 > 140

    /** WCAG relative luminance (prefs.js `luminance`). */
    val luminance: Double
        get() {
            fun lin(v0: Double): Double { val v = v0 / 255; return if (v <= 0.03928) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4) }
            return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        }

    fun contrast(other: RGB): Double {
        val a = luminance
        val b = other.luminance
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /** prefs.js `inkOn`: black or white, whichever reads on this colour (black wins ties). */
    val inkOn: RGB get() = if (contrast(BLACK) >= contrast(WHITE)) BLACK else WHITE

    companion object {
        val BLACK = hex(0x000000)
        val WHITE = hex(0xffffff)

        /** `0xRRGGBB`. */
        fun hex(v: Int, alpha: Double = 1.0): RGB =
            RGB((v shr 16 and 255).toDouble(), (v shr 8 and 255).toDouble(), (v and 255).toDouble(), alpha)

        /** `#rrggbb`, `#rgb` or `#rrggbbaa` (case-insensitive, `#` optional). Null for anything else. */
        fun parse(s: String?): RGB? {
            var h = s?.trim() ?: return null
            if (h.startsWith("#")) h = h.substring(1)
            if (h.isEmpty() || !h.all { it.isHexDigitChar() }) return null
            if (h.length == 3) h = h.map { "$it$it" }.joinToString("")
            if (h.length != 6 && h.length != 8) return null
            val n = h.substring(0, 6).toInt(16)
            val a = if (h.length == 8) h.substring(6).toInt(16) / 255.0 else 1.0
            return hex(n, a)
        }

        private val STRICT = Regex("^#?[0-9a-fA-F]{6}$")

        /** Strict 6-digit form, the only one the web's `hexToRgb` accepts for themes. */
        fun strictHex(s: String?): RGB? = if (s != null && STRICT.matches(s)) parse(s) else null

        private fun Char.isHexDigitChar() = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

        private fun clamp(x: Double): Double = max(0.0, min(255.0, Math.round(x).toDouble()))
    }
}
