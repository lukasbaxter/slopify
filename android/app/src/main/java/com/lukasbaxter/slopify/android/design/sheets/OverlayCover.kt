package com.lukasbaxter.slopify.android.design.sheets

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import com.lukasbaxter.slopify.android.design.theme.LocalTheme

/**
 * Full-screen layers drawn by the design root above the whole app (tab bar, mini player, now
 * playing) and below the toasts, so sheets and dialogs run the web's own scrim fade and slide
 * (ios Design/Sheets/OverlayCover.swift, which uses a transparent fullScreenCover). Later
 * layers draw on top.
 */
class OverlayHost {
    internal class Entry(content: @Composable () -> Unit) {
        var content by mutableStateOf(content)
    }

    internal val entries = mutableStateListOf<Entry>()

    /** Draw every layer; the design root calls it once, full screen. */
    @Composable
    fun Layers() {
        for (e in entries) Box(Modifier.fillMaxSize()) { e.content() }
    }
}

val LocalOverlayHost = staticCompositionLocalOf<OverlayHost?> { null }

/**
 * Shows `content` as a top layer while this is composed. The caller's theme (islands, ink)
 * goes with it. Without a host (previews) it draws in place.
 */
@Composable
fun OverlayLayer(content: @Composable () -> Unit) {
    val host = LocalOverlayHost.current
    val theme by rememberUpdatedState(LocalTheme.current)
    val latest by rememberUpdatedState(content)
    val entry = remember { OverlayHost.Entry { CompositionLocalProvider(LocalTheme provides theme) { latest() } } }
    if (host == null) {
        Box(Modifier.fillMaxSize()) { entry.content() }
        return
    }
    DisposableEffect(host, entry) {
        host.entries.add(entry)
        onDispose { host.entries.remove(entry) }
    }
}

/**
 * Presents `content` for `item` above everything while `item` is non-null. `close(then)` (given
 * to the content) dismisses: `onDismiss` runs (the caller clears `item`), then `then`. Setting
 * `item` to null from outside removes the layer at once.
 */
@Composable
fun <T : Any> OverlayCover(
    item: T?,
    onDismiss: () -> Unit,
    content: @Composable (item: T, close: (then: (() -> Unit)?) -> Unit) -> Unit,
) {
    val current = item ?: return
    val dismiss by rememberUpdatedState(onDismiss)
    OverlayLayer {
        key(current) {
            content(current) { then ->
                dismiss()
                then?.invoke()
            }
        }
    }
}
