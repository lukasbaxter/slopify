package com.lukasbaxter.slopify.android.design.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.TweenSpec
import androidx.compose.animation.core.tween
import androidx.compose.ui.unit.dp

/** Static (unthemed) tokens, app.css:40-45 (ios Design/Theme/Tokens.swift). iOS points = dp. */
object Radius {
    /** `--r-panel` */
    val panel = 8.dp
    /** `--r-art` (hero cover, sheet header image, skeleton art) */
    val art = 4.dp
    /** `--r-row` (mini player card, skeleton bars) */
    val row = 6.dp
    /** Track-row artwork. */
    val rowArt = 3.dp
    /** Home / see-all / other-page cards (mobile-home-search.css:98). */
    val card = 2.dp
    /** Bottom sheet top corners. */
    val sheet = 16.dp
    /** Dialog card, toast, error banner. */
    val dialog = 8.dp
}

object Spacing {
    /** `--gap` */
    val gap = 8.dp
    /** Page side gutter. */
    val gutter = 16.dp
    /** Gap between cards in a shelf. */
    val shelfGap = 16.dp
}

/** Phone shell metrics (UI.md 2.3, 2.6). */
object Shell {
    /** Tab bar height above the bottom inset. */
    val tabBar = 49.dp
    /** Mini player card height, and its margin above the tab bar. */
    val miniPlayer = 56.dp
    val miniPlayerGap = 8.dp
    /** Fade zone above the mini player card. */
    val miniPlayerFade = 24.dp
    /** Root-page header row (avatar + title), below the top inset. */
    val header = 48.dp
    /** Detail top bar row, below the top inset. */
    val topBar = 56.dp
    /** Bottom padding of every scroll view, above the bottom inset: 24 + 56 + 8 + 49. */
    val contentBottom = 137.dp
    /** Fixed track-row height in long lists (VirtualList, UI.md 5.3); 84 with a lyric snippet. */
    val trackRow = 64.dp
    val trackRowWithSnippet = 84.dp
}

/** Timing curves (UI.md 2.1, 3.8, 5.5). Durations in ms. */
object Motion {
    /** `--ease: cubic-bezier(.3, 0, 0, 1)`. */
    val easeCurve: Easing = CubicBezierEasing(0.3f, 0f, 0f, 1f)
    /** Phone sheets and pushes: `cubic-bezier(.2,.7,.2,1)`. */
    val sheetCurve: Easing = CubicBezierEasing(0.2f, 0.7f, 0.2f, 1f)

    fun <T> ease(durationMs: Int): TweenSpec<T> = tween(durationMs, easing = easeCurve)
    fun <T> sheet(durationMs: Int): TweenSpec<T> = tween(durationMs, easing = sheetCurve)

    /** Sheet in (0.2 s), drawer in (0.25 s), now playing in (0.3 s). */
    fun <T> sheetIn(): TweenSpec<T> = sheet(200)
    fun <T> drawerIn(): TweenSpec<T> = sheet(250)
    fun <T> nowPlayingIn(): TweenSpec<T> = sheet(300)
    /** The one dismiss used for every sheet: slide down 0.25 s ease-in (DECISIONS). */
    const val SHEET_OUT_MS = 250
    fun <T> sheetOut(): TweenSpec<T> = tween(SHEET_OUT_MS, easing = FastOutLinearInEasing)
    /** Snap back after a drag that did not dismiss. */
    fun <T> snapBack(): TweenSpec<T> = tween(200, easing = LinearOutSlowInEasing)
    /** Image fade-in (Home FadeImg). */
    fun <T> imageFade(): TweenSpec<T> = tween(150, easing = LinearOutSlowInEasing)
    /** Scrim fade. */
    fun <T> scrim(): TweenSpec<T> = tween(200, easing = LinearEasing)
}

/** Gesture thresholds (UI.md 2.8). Distances in dp. */
object Gestures {
    const val LONG_PRESS_MS = 450L
    const val LONG_PRESS_SLOP = 10f
    /** Sheet drag-to-dismiss: dy > 100, or dy > 40 within 300 ms. */
    const val SHEET_DISMISS_DISTANCE = 100f
    const val SHEET_FLICK_DISTANCE = 40f
    const val SHEET_FLICK_MS = 300L
    /** Now playing swipe-down: dy > 140, or dy > 60 within 300 ms. */
    const val NOW_PLAYING_DISMISS_DISTANCE = 140f
    const val NOW_PLAYING_FLICK_DISTANCE = 60f
    /** Mini player skip swipe: |dx| > 60, |dy| < 40, within 600 ms. */
    const val SKIP_DISTANCE = 60f
    const val SKIP_MAX_VERTICAL = 40f
    const val SKIP_MS = 600L

    /** dy > 100, or dy > 40 within 300 ms (App.jsx:1481-1512). */
    fun sheetShouldDismiss(dy: Float, elapsedMs: Long): Boolean =
        dy > SHEET_DISMISS_DISTANCE || (elapsedMs < SHEET_FLICK_MS && dy > SHEET_FLICK_DISTANCE)
}
