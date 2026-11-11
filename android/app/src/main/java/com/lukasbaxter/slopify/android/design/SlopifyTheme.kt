package com.lukasbaxter.slopify.android.design

import android.app.Activity
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.storage.KeyValueStore
import com.lukasbaxter.slopify.android.core.stores.Connectivity
import com.lukasbaxter.slopify.android.design.color.ArtworkColor
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import com.lukasbaxter.slopify.android.design.image.ImageLoader
import com.lukasbaxter.slopify.android.design.image.LocalApiClient
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.overlay.ToastStack
import com.lukasbaxter.slopify.android.design.sheets.LocalOverlayHost
import com.lukasbaxter.slopify.android.design.sheets.OverlayHost
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Theme
import com.lukasbaxter.slopify.android.design.theme.ThemeStore
import com.lukasbaxter.slopify.android.player.Player

/** Once per process, before the first frame: image caches on disk and the bundled locales. */
object Design {
    fun install(context: Context, store: KeyValueStore) {
        ImageLoader.install(context)
        ArtworkColor.install(context)
        Localizer.install(context, store)
    }
}

/**
 * The design root (ios `.themed(themeStore)` + `.environment(\.apiClient)` + the toast window).
 * Also hands shared views the [Player] and [Connectivity] they act on.
 * Puts the [Theme] in [LocalTheme], the API client in [LocalApiClient], draws the page colour,
 * keeps the system bar icons readable, and layers sheets/dialogs, then toasts, over `content`.
 * Without a store (previews) it uses the default theme.
 */
@Composable
fun SlopifyTheme(
    store: ThemeStore? = null,
    api: ApiClient? = null,
    player: Player? = null,
    connectivity: Connectivity? = null,
    toasts: ToastCenter = ToastCenter.shared,
    content: @Composable () -> Unit,
) {
    val theme = store?.theme?.collectAsStateWithLifecycle()?.value ?: Theme.Default
    val overlays = remember { OverlayHost() }
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            val bars = WindowCompat.getInsetsController(window, view)
            bars.isAppearanceLightStatusBars = theme.isLight
            bars.isAppearanceLightNavigationBars = theme.isLight
        }
    }
    // Material 3 is plumbing only (text field cursors, ripples); the look comes from the tokens.
    val scheme = if (theme.isLight) {
        lightColorScheme(primary = theme.accent, onPrimary = theme.onAccent, background = theme.page, surface = theme.page,
            onBackground = theme.fg, onSurface = theme.fg, onSurfaceVariant = theme.fgSub, surfaceContainer = theme.bgElevated, error = theme.danger)
    } else {
        darkColorScheme(primary = theme.accent, onPrimary = theme.onAccent, background = theme.page, surface = theme.page,
            onBackground = theme.fg, onSurface = theme.fg, onSurfaceVariant = theme.fgSub, surfaceContainer = theme.bgElevated, error = theme.danger)
    }
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(
            LocalTheme provides theme,
            LocalApiClient provides api,
            LocalOverlayHost provides overlays,
            LocalContentColor provides theme.fg,
            LocalPlayer provides player,
            LocalConnectivity provides connectivity,
        ) {
            Box(Modifier.fillMaxSize().background(theme.page)) {
                content()
                overlays.Layers()
                ToastStack(toasts)
            }
        }
    }
}
