package com.lukasbaxter.slopify.android.app

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.core.auth.AccountState
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.features.home.HomeView
import com.lukasbaxter.slopify.android.features.library.LibraryView
import com.lukasbaxter.slopify.android.features.nowplaying.MiniPlayer
import com.lukasbaxter.slopify.android.features.nowplaying.NowPlayingView
import com.lukasbaxter.slopify.android.features.nowplaying.QueueView
import com.lukasbaxter.slopify.android.features.search.SearchView
import com.lukasbaxter.slopify.android.features.signin.SignInFlow

/** Signed in: the shell. Otherwise sign-in (password change included). */
@Composable
fun RootView() {
    val app = LocalAppModel.current
    val state by app.account.state.collectAsStateWithLifecycle()
    when (state) {
        AccountState.SignedIn -> MainShell()
        AccountState.SignedOut, AccountState.PasswordChange -> SignInFlow()
    }
}

/**
 * Phone shell placeholder (UI.md 2.3): three tab stacks, mini player above the tab bar, now
 * playing / queue as full-screen layers. The design and feature tasks replace the visuals;
 * the Navigator wiring stays.
 */
@Composable
fun MainShell() {
    val nav = LocalAppModel.current.nav
    val s by nav.state.collectAsStateWithLifecycle()
    BackHandler(enabled = s.queueOpen || s.nowPlayingOpen || s.drawerOpen || s.deviceSheetOpen || s.top != null) { nav.back() }
    when {
        s.queueOpen -> QueueView()
        s.nowPlayingOpen -> NowPlayingView()
        else -> Scaffold(
            bottomBar = {
                Column {
                    MiniPlayer()
                    NavigationBar {
                        for (t in Tab.entries) {
                            NavigationBarItem(
                                selected = s.tab == t,
                                onClick = { nav.select(t) },
                                // TODO(design): tab glyphs (UI.md 2.4).
                                icon = {},
                                label = { Text(L(tabLabel(t))) },
                            )
                        }
                    }
                }
            },
        ) { pad ->
            Box(Modifier.fillMaxSize().padding(pad)) {
                val top = s.top
                if (top != null) RouteDestination(top.route) else when (s.tab) {
                    Tab.Home -> HomeView()
                    Tab.Search -> SearchView()
                    Tab.Library -> LibraryView()
                }
            }
        }
    }
}

/** Web locale keys of the tab labels. */
private fun tabLabel(t: Tab) = when (t) {
    Tab.Home -> "Home"
    Tab.Search -> "Search"
    Tab.Library -> "Your Library"
}
