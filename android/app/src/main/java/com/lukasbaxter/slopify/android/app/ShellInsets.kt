package com.lukasbaxter.slopify.android.app

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.Dp
import com.lukasbaxter.slopify.android.design.theme.Shell
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map

// The shell draws every page full screen and passes no insets (docs/CONVENTIONS.md "Shell and
// insets"): the mini player and the tab bar float over the bottom of the page.

/** Height of the tab bar including the navigation bar inset. */
@Composable
fun shellTabBarHeight(): Dp = Shell.tabBar + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

/** From the screen bottom to the top of the mini player card (tab bar + gap + card). */
@Composable
fun shellChromeHeight(): Dp = shellTabBarHeight() + Shell.miniPlayerGap + Shell.miniPlayer

/**
 * Runs `action` each time the lit tab `tab` is tapped while on its root (ios
 * `nav.scrollToTop[tab]`): scroll the root list to the top.
 *
 *     ScrollToTopEffect(Tab.Home) { listState.animateScrollToItem(0) }
 */
@Composable
fun ScrollToTopEffect(tab: Tab, action: suspend () -> Unit) {
    val nav = LocalAppModel.current.nav
    val run by rememberUpdatedState(action)
    LaunchedEffect(nav, tab) {
        nav.state.map { it.scrollToTop[tab] ?: 0 }.distinctUntilChanged().drop(1).collect { run() }
    }
}
