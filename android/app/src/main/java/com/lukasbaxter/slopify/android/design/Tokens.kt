package com.lukasbaxter.slopify.android.design

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

// STUB. The design task owns this package and replaces it with the real tokens
// (ios/Slopify/Design/Theme, UI.md). Feature code reads colours, type and spacing only from here.

/** The default theme's base colours (ios ThemeColors.default). */
object SlopifyColors {
    val accent = Color(0xFF1ED760)
    val page = Color(0xFF121212)
    val surface = Color(0xFF1F1F1F)
    val fg = Color(0xFFFFFFFF)
    val fgSub = Color(0xFFA7A7A7)
}

object SlopifySpacing {
    val gutter = 16.dp
    val small = 8.dp
}

/** User-facing text by its web locale key (web/src/locales). Stub: the key is the English text. */
fun L(key: String): String = key

/** Material 3 only as plumbing; the look comes from the tokens above. */
@Composable
fun SlopifyTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = SlopifyColors.accent,
            background = SlopifyColors.page,
            surface = SlopifyColors.page,
            surfaceContainer = SlopifyColors.surface,
            onBackground = SlopifyColors.fg,
            onSurface = SlopifyColors.fg,
            onSurfaceVariant = SlopifyColors.fgSub,
        ),
        content = content,
    )
}
