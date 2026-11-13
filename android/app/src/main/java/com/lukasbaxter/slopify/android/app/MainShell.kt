package com.lukasbaxter.slopify.android.app

import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.toSize
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.overlay.ToastLayout
import com.lukasbaxter.slopify.android.design.sheets.DuplicateDialogHost
import com.lukasbaxter.slopify.android.features.account.AccountDrawer
import com.lukasbaxter.slopify.android.features.home.HomeView
import com.lukasbaxter.slopify.android.features.library.LibraryView
import com.lukasbaxter.slopify.android.features.nowplaying.MiniPlayer
import com.lukasbaxter.slopify.android.features.nowplaying.NowPlayingView
import com.lukasbaxter.slopify.android.features.nowplaying.QueueView
import com.lukasbaxter.slopify.android.features.search.SearchView
import kotlinx.coroutines.CancellationException

/**
 * Phone shell (UI.md 2.3; ios MainShell): three tab stacks kept alive side by side, the mini
 * player (always there) above the tab bar, now playing and the queue as full-screen layers,
 * the account drawer. The device sheet is local to the mini player / now playing (as on iOS). Pages draw full screen; the shell passes no insets.
 *
 * Back, top first: sheets and dialogs (design root), the drawer, the queue, now playing, a page's
 * own handler, then the lit tab's stack (predictive: the page follows the gesture).
 */
@Composable
fun MainShell() {
    val nav = LocalAppModel.current.nav
    val s by nav.state.collectAsStateWithLifecycle()
    // "Already added" for every Add to playlist (LibraryStore.add), above any page or layer.
    val duplicate by LocalAppModel.current.library.duplicateQuestion.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val zoom = remember { HomeZoomSources() }
    val stacks = remember { Tab.entries.associateWith { t -> PageStack(t, scope).also { if (t == Tab.Home) it.sources = zoom } } }

    // The stacks follow the navigator outside composition, so a pop never shows a frame without
    // the leaving page.
    LaunchedEffect(nav) {
        var lastTab: Tab? = null
        nav.state.collect { st ->
            for (t in Tab.entries) stacks.getValue(t).sync(st.stack(t), animate = st.tab == t && lastTab == t)
            lastTab = st.tab
        }
    }
    LaunchedEffect(s.nowPlayingOpen) {
        ToastCenter.shared.layout.value = if (s.nowPlayingOpen) ToastLayout.NowPlaying else ToastLayout.Shell(miniPlayer = true)
    }

    val lit = stacks.getValue(s.tab)
    val layerOpen = s.nowPlayingOpen || s.queueOpen || s.drawerOpen || s.deviceSheetOpen
    val current by rememberUpdatedState(lit)
    // Registered first, so every layer and page handler composed later goes before it.
    PredictiveBackHandler(enabled = s.stack(s.tab).isNotEmpty() && !layerOpen) { events ->
        val st = current
        if (!st.beginInteractive()) {
            events.collect { }
            nav.pop()
            return@PredictiveBackHandler
        }
        val top = st.top
        try {
            events.collect { e ->
                if (top?.fromHome == true) st.pullTo(ShellMotion.backRect(st.fullRect, e.progress))
                else st.drag(1 - e.progress)
            }
            nav.pop()
        } catch (e: CancellationException) {
            st.cancelInteractive()
            throw e
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .onSizeChanged { sz -> stacks.values.forEach { it.fullRect = Rect(Offset.Zero, sz.toSize()) } },
    ) {
        TabStack(stacks.getValue(Tab.Home), s.tab == Tab.Home, zoom, nav) { HomeView() }
        TabStack(stacks.getValue(Tab.Search), s.tab == Tab.Search, null, nav) { SearchView() }
        TabStack(stacks.getValue(Tab.Library), s.tab == Tab.Library, null, nav) { LibraryView() }

        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
            MiniPlayer()
            ShellTabBar(s.tab, nav::select)
        }

        ShellLayer(s.nowPlayingOpen, { nav.setNowPlayingOpen(false) }) { NowPlayingView() }
        ShellLayer(s.queueOpen, { nav.setQueueOpen(false) }) { QueueView() }

        // Always composed: the drawer shows itself from `nav.drawerOpen` (and animates out).
        AccountDrawer()
        // Composed on open, so it registers above every page handler.
        if (s.drawerOpen) BackHandler { nav.setDrawerOpen(false) }
    }
    DuplicateDialogHost(duplicate)
}
