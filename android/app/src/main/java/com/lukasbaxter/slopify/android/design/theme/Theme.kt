package com.lukasbaxter.slopify.android.design.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Every colour token of the web app (UI.md 2.1, 7.9), derived from 4 theme colours exactly as
 * `applyTheme()` in web/src/api/prefs.js (ios Design/Theme/Theme.swift). Read it with
 * `Theme.current`. Token names match the CSS variables: `bgBase` = `--bg-base`, ...
 * [rgb] holds the raw values (for blending); the `Color` accessors are what views use.
 */
@Immutable
class Theme private constructor(
    val colors: ThemeColors,
    /** `data-light="1"`: Paper and other light themes. */
    val isLight: Boolean,
    val rgb: Tokens,
) {
    @Immutable
    data class Tokens(
        val accent: RGB, val accentInk: RGB, val accentOnDark: RGB, val accentHover: RGB, val accentPress: RGB,
        val seekAccent: RGB, val onAccent: RGB, val onFg: RGB,
        val bgBase: RGB, val bgHighlight: RGB, val bgElevated: RGB, val bgElevatedHi: RGB, val card: RGB, val cardHover: RGB,
        val tint: RGB, val tintHi: RGB, val tintPress: RGB,
        val fg: RGB, val fgDim: RGB, val fgChrome: RGB, val fgSub: RGB, val fgFaint: RGB,
        val themeFg: RGB, val themeFgDim: RGB, val themeOnFg: RGB,
        val black: RGB, val page: RGB, val chip: RGB, val field: RGB, val sheet: RGB, val green: RGB, val danger: RGB, val dangerBg: RGB,
    )

    override fun equals(other: Any?): Boolean = other is Theme && other.colors == colors && other.isLight == isLight && other.rgb == rgb
    override fun hashCode(): Int = rgb.hashCode() * 31 + isLight.hashCode()

    // Dark islands (app.css:51-59)

    /**
     * The token set that places sitting on artwork keep on a light theme: now playing, Browse
     * tiles, the mini player row. Same theme on dark themes.
     */
    val darkIsland: Theme get() = if (isLight) island(RGB.hex(0xa7a7a7)) else this

    /** `.hero` (detail headers, profile hero, the top bar over a hero): dark set with `--fg-sub: #d0d0d0`. */
    val heroIsland: Theme get() = if (isLight) island(RGB.hex(0xd0d0d0)) else this

    private fun island(fgSub: RGB): Theme {
        fun h(x: Int, a: Double) = RGB.hex(x, a)
        val t = rgb.copy(
            fg = h(0xffffff, 1.0), fgDim = h(0xb3b3b3, 1.0), fgChrome = h(0xb3b3b3, 1.0), fgSub = fgSub, fgFaint = h(0x727272, 1.0),
            accentInk = rgb.accentOnDark, onFg = h(0x000000, 1.0),
            bgBase = h(0x121212, 1.0), bgHighlight = h(0x1f1f1f, 1.0), bgElevated = h(0x1f1f1f, 1.0), bgElevatedHi = h(0x2a2a2a, 1.0),
            card = h(0x181818, 1.0), cardHover = h(0x282828, 1.0),
            tint = h(0xffffff, 0x1a / 255.0), tintHi = h(0xffffff, 0x24 / 255.0), tintPress = h(0xffffff, 0x36 / 255.0),
            page = h(0x121212, 1.0), chip = h(0x2a2a2a, 1.0), field = h(0x1f1f1f, 1.0), sheet = h(0x282828, 1.0), danger = h(0xf3727f, 1.0),
        )
        return Theme(colors, false, t)
    }

    /** A sheet opened from the mini player gets the theme's own ink back (app.css:1272). */
    val themeInk: Theme get() = Theme(colors, isLight, rgb.copy(fg = rgb.themeFg, fgDim = rgb.themeFgDim, onFg = rgb.themeOnFg))

    // Colours

    val accent: Color get() = rgb.accent.color
    val accentInk: Color get() = rgb.accentInk.color
    val accentOnDark: Color get() = rgb.accentOnDark.color
    val accentHover: Color get() = rgb.accentHover.color
    val accentPress: Color get() = rgb.accentPress.color
    /** The liked heart fill. */
    val seekAccent: Color get() = rgb.seekAccent.color
    val onAccent: Color get() = rgb.onAccent.color
    val onFg: Color get() = rgb.onFg.color
    val bgBase: Color get() = rgb.bgBase.color
    val bgHighlight: Color get() = rgb.bgHighlight.color
    val bgElevated: Color get() = rgb.bgElevated.color
    val bgElevatedHi: Color get() = rgb.bgElevatedHi.color
    val card: Color get() = rgb.card.color
    val cardHover: Color get() = rgb.cardHover.color
    val tint: Color get() = rgb.tint.color
    val tintHi: Color get() = rgb.tintHi.color
    val tintPress: Color get() = rgb.tintPress.color
    val fg: Color get() = rgb.fg.color
    val fgDim: Color get() = rgb.fgDim.color
    val fgChrome: Color get() = rgb.fgChrome.color
    val fgSub: Color get() = rgb.fgSub.color
    val fgFaint: Color get() = rgb.fgFaint.color
    val black: Color get() = rgb.black.color
    val page: Color get() = rgb.page.color
    val chip: Color get() = rgb.chip.color
    val field: Color get() = rgb.field.color
    val sheet: Color get() = rgb.sheet.color
    val green: Color get() = rgb.green.color
    val danger: Color get() = rgb.danger.color
    val dangerBg: Color get() = rgb.dangerBg.color

    /** `rgba(var(--fg-rgb), a)`: pressed rows (.08), dividers (.1), separators (.14), grabbers (.25). */
    fun fg(alpha: Double): Color = rgb.fg.opacity(alpha).color
    /** `rgba(var(--page-rgb), a)`. */
    fun page(alpha: Double): Color = rgb.page.opacity(alpha).color

    /** Fixed colours that are not tokens (UI.md 2.1). */
    object Fixed {
        val avatarFallback = RGB.hex(0x509bf5).color
        val drawerAvatarFallback = RGB.hex(0x535353).color
        val offlinePill = RGB.hex(0x3a3a3a).color
        val drawerScrim = Color.Black.copy(alpha = 0.55f)
        val sheetScrim = Color.Black.copy(alpha = 0.6f)
        /** Home mix tiles (Home.jsx:43). */
        val mixPalette: List<RGB> = listOf(0xe8115b, 0x1e3264, 0x8d67ab, 0xe13300, 0x148a08, 0x0d73ec, 0x7d4b32, 0xba5d07).map { RGB.hex(it) }
        /** Liked Songs tile gradient, 135deg (app.css:469-473). */
        val likedGradient = listOf(RGB.hex(0x450af5).color, RGB.hex(0xc4efd9).color)
        val likedHero = RGB.hex(0x5038a0)
        val radarHero = RGB.hex(0x8d67ab)
        /** `.content --hero` default (app.css:283), not clamped. */
        val defaultHero = RGB.hex(0x3d3c3c)
        /** Now playing gradient fallback when there is no cover colour. */
        val nowPlayingFallback = RGB.hex(0x535353)
        val textFieldBorder = RGB.hex(0x555555).color
        val secondaryButtonBorder = RGB.hex(0x7a7a7a).color
        /** The settings/theme sheet check is hard-coded green (UI.md 7.9). */
        val checkGreen = RGB.hex(0x1ed760).color
        /** `TILE_COLORS` (Library.jsx:270): the Search genre tiles, in server order. */
        val browseTiles: List<RGB> = listOf(
            0xe13300, 0x1e3264, 0x8d67ab, 0xe8115b, 0x148a08, 0x0d73ec, 0x7d4b32, 0xba5d07,
            0x477d95, 0x503750, 0x27856a, 0xd84000, 0xe1118c, 0xa56752, 0x4b7d9b, 0xe61e32,
        ).map { RGB.hex(it) }
        /** Search "Start browsing" tiles (Library.jsx:1740-1757); Charts and Liked reuse radarHero / likedHero. */
        val madeForYouTile = RGB.hex(0x1e3264)
        val newReleasesTile = RGB.hex(0xe13300)
        /** The white search field: black text, `#121212` at .85 for the placeholder (app.css:1296-1300). */
        val searchFieldBackground = Color.White
        val searchFieldText = Color.Black
        val searchFieldPlaceholder = RGB.hex(0x121212).color.copy(alpha = 0.85f)
        /** `.verified svg` (app.css:368). */
        val verified = RGB.hex(0x4cb3ff).color
        /** Profile hero (Library.jsx:1032). */
        val profileHero = RGB.hex(0x4a4a4a)
        /** A falling stat in Listening history (app.css:1620). */
        val deltaDown = RGB.hex(0xf87171).color
        /** The native server-address field border (mobile/App.js). */
        val fieldBorder = RGB.hex(0x3e3e3e).color
        /** Hero wash end (`rgba(18,18,18,.3)`), request-pill shadow and other black/white constants. */
        val heroWash = RGB.hex(0x121212, 0.3).color
        val white = Color.White
        val black = Color.Black
        /** `--tint-press` of the dark set, the busy request pill. */
        val busyPill = RGB.hex(0xffffff, 0x36 / 255.0).color
    }

    companion object {
        /** The derived token set for 4 colours (prefs.js `applyTheme`). Bad hex falls back per key. */
        operator fun invoke(input: ThemeColors = ThemeColors.Default): Theme {
            val d = ThemeColors.Default
            val accent = RGB.strictHex(input.accent) ?: RGB.parse(d.accent)!!
            val bg = RGB.strictHex(input.bg) ?: RGB.parse(d.bg)!!
            val surface = RGB.strictHex(input.surface) ?: RGB.parse(d.surface)!!
            val fg = RGB.strictHex(input.fg) ?: RGB.parse(d.fg)!!
            val colors = ThemeColors(accent.hex, bg.hex, surface.hex, fg.hex)
            val light = bg.isLight
            val fgDim = fg.mix(bg, if (light) 0.28 else 0.3)
            var ink = accent
            if (light) {
                var i = 0
                while (i < 12 && ink.contrast(bg.mix(fg, 0.2)) < 4.5) { ink = ink.mix(RGB.BLACK, 0.1); i++ }
            }
            fun h(x: Int) = RGB.hex(x)
            val tokens = Tokens(
                accent = accent,
                accentInk = ink,
                accentOnDark = if (light) accent.mix(RGB.WHITE, 0.45) else accent,
                accentHover = accent.mix(if (light) RGB.BLACK else RGB.WHITE, 0.12),
                accentPress = accent.mix(RGB.BLACK, 0.12),
                seekAccent = accent,
                onAccent = accent.inkOn,
                onFg = fg.inkOn,
                bgBase = bg,
                bgHighlight = surface,
                bgElevated = surface,
                bgElevatedHi = surface.mix(fg, 0.08),
                card = bg.mix(surface, 0.5),
                cardHover = surface.mix(fg, 0.06),
                tint = RGB.hex(if (light) 0x000000 else 0xffffff, 0x1a / 255.0),
                tintHi = RGB.hex(if (light) 0x000000 else 0xffffff, 0x24 / 255.0),
                tintPress = RGB.hex(if (light) 0x000000 else 0xffffff, 0x36 / 255.0),
                fg = fg,
                fgDim = fgDim,
                fgChrome = fgDim,
                fgSub = if (light) fgDim else h(0xa7a7a7),
                fgFaint = if (light) fgDim else h(0x727272),
                themeFg = fg,
                themeFgDim = fgDim,
                themeOnFg = fg.inkOn,
                black = if (light) bg.mix(fg, 0.05) else h(0x000000),
                page = if (light) bg else h(0x121212),
                chip = if (light) surface.mix(fg, 0.08) else h(0x2a2a2a),
                field = if (light) surface.mix(fg, 0.05) else h(0x1f1f1f),
                sheet = if (light) surface else h(0x282828),
                green = if (light) ink else h(0x1ed760),
                danger = if (light) h(0xb3261e) else h(0xf3727f),
                dangerBg = if (light) h(0xfbe4e2) else h(0x2a1618),
            )
            return Theme(colors, light, tokens)
        }

        val Default: Theme = Theme()

        /** The active token set (root: [com.lukasbaxter.slopify.android.design.SlopifyTheme]; islands override it). */
        val current: Theme
            @Composable @ReadOnlyComposable get() = LocalTheme.current
    }
}

val LocalTheme = staticCompositionLocalOf { Theme.Default }

/** Places on artwork colour (now playing, tiles, mini player row) keep dark tokens on light themes. */
@Composable
fun DarkIsland(content: @Composable () -> Unit) =
    CompositionLocalProvider(LocalTheme provides LocalTheme.current.darkIsland, content = content)

/** Detail-page heroes: dark tokens with `--fg-sub #d0d0d0` on light themes. */
@Composable
fun HeroIsland(content: @Composable () -> Unit) =
    CompositionLocalProvider(LocalTheme provides LocalTheme.current.heroIsland, content = content)

/** Give back the theme's own ink inside an island (device sheet from the mini player). */
@Composable
fun ThemeInk(content: @Composable () -> Unit) =
    CompositionLocalProvider(LocalTheme provides LocalTheme.current.themeInk, content = content)
