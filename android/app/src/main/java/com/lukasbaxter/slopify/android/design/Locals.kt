package com.lukasbaxter.slopify.android.design

import androidx.compose.runtime.staticCompositionLocalOf
import com.lukasbaxter.slopify.android.core.stores.Connectivity
import com.lukasbaxter.slopify.android.player.Player

/**
 * The player shared views act on (TrackRow's swipe to queue). Provided by [SlopifyTheme];
 * null in previews and tests, which turns the swipe off.
 */
val LocalPlayer = staticCompositionLocalOf<Player?> { null }

/** App-wide offline state for shared views (TrackRow's offline rule). Null in previews. */
val LocalConnectivity = staticCompositionLocalOf<Connectivity?> { null }
