package com.lukasbaxter.slopify.android.design.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.core.model.Format
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import java.util.Locale

/** What reaches the listener (QualityBadge.jsx `deliveredFormat` + `formatLabel`, UI.md 3.5, 4.3.7). */
object DeliveredFormat {
    /** The local stream mode: `File` (original), or an HLS / whole-file profile. */
    enum class Mode { File, Hls, Mp3 }

    /**
     * `deviceKind` is the session device's kind (`local` = this phone).
     * `profile`: `alac`, `aac-320`, `aac-160`, `aac-96` (already capped by the link watch).
     */
    fun delivered(f: Format?, deviceKind: String, mode: Mode = Mode.Hls, profile: String = "aac-320"): Format? {
        if (f == null) return null
        if (deviceKind != "local" || mode == Mode.File) return f
        if (profile == "alac") return if (f.lossless == true) f.copy(codec = "ALAC") else f
        val bitrate = mapOf("aac-320" to 320_000.0, "aac-160" to 160_000.0, "aac-96" to 96_000.0)[profile] ?: 320_000.0
        return Format(codec = if (mode == Mode.Hls) "AAC" else "MP3", lossless = false, bitrate = bitrate)
    }

    /** "FLAC 24-bit 96kHz", "FLAC 44.1kHz", "AAC 320kbps", or the bare codec. Null without a codec. */
    fun label(f: Format?): String? {
        val codec = f?.codec?.takeIf { it.isNotEmpty() } ?: return null
        if (f.lossless == true) {
            val parts = mutableListOf(codec)
            f.bitDepth?.let { b -> if (b > 16) parts += "${num(b)}-bit" }
            f.sampleRate?.let { sr ->
                if (sr > 0) {
                    val k = sr / 1000
                    parts += if (k == Math.rint(k)) "${k.toInt()}kHz" else String.format(Locale.ROOT, "%.1fkHz", k)
                }
            }
            return parts.joinToString(" ")
        }
        val br = f.bitrate
        if (br != null && br > 0) return "$codec ${ColorMath.jsRound(br / 1000)}kbps"
        return codec
    }

    private fun num(d: Double): String = if (d == Math.rint(d)) d.toInt().toString() else d.toString()
}

/**
 * The quality tag under the artist in now playing and in the device sheet (UI.md 3.5): 12/500
 * (11 in the sheet: `small`), line height 14, letter-spacing .02em, one line; `--accent-ink`
 * when lossless, `--fg-dim` otherwise. Nothing when the label is null.
 */
@Composable
fun QualityBadge(format: Format?, modifier: Modifier = Modifier, small: Boolean = false) {
    val text = DeliveredFormat.label(format) ?: return
    val theme = LocalTheme.current
    val lossless = format?.lossless == true
    val size = if (small) 11f else 12f
    val a11y = "$text, ${if (lossless) L("Lossless") else L("Compressed")}"
    Text(
        text, fontSize = size.sp, fontWeight = FontWeight.Medium, letterSpacing = (size * 0.02f).sp, maxLines = 1,
        color = if (lossless) theme.accentInk else theme.fgDim,
        modifier = modifier.height(14.dp).semantics { contentDescription = a11y },
    )
}

/**
 * Spotify's animated "now playing" mark (TrackRow.jsx:113-116, app.css:827-832): 14x14, three
 * 3-wide bars 2 apart, bottom-aligned, accent, heights 40/90/60 %, each scaling .4 -> 1 -> .4
 * over 0.9 s ease-in-out, delays 0 / .25 / .5 s. Static when `animating` is false.
 */
@Composable
fun NowPlayingBars(modifier: Modifier = Modifier, animating: Boolean = true) {
    val theme = LocalTheme.current
    val phase by rememberInfiniteTransition(label = "bars").animateFloat(
        0f, 1f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "bars",
    )
    val label = L("Now playing")
    Canvas(modifier.size(14.dp).semantics { contentDescription = label }) {
        val unit = size.height / 14f
        listOf(0.4f to 0f, 0.9f to 0.25f, 0.6f to 0.5f).forEachIndexed { i, (base, delay) ->
            val s = if (animating) NowPlayingBarsMath.scale(phase * 0.9 - delay) else 1f
            val h = 14f * base * s * unit
            drawRect(theme.accent, Offset(i * 5f * unit, size.height - h), Size(3f * unit, h))
        }
    }
}

/** The bars' keyframes, pure for tests. */
object NowPlayingBarsMath {
    /** Scale at `t` seconds into a bar's own loop: .4 -> 1 -> .4 over 0.9 s, smooth-step per half. */
    fun scale(t: Double): Float {
        var p = (t / 0.9) % 1.0
        if (p < 0) p += 1
        val half = if (p < 0.5) p * 2 else (1 - p) * 2
        val eased = half * half * (3 - 2 * half)
        return (0.4 + 0.6 * eased).toFloat()
    }
}
