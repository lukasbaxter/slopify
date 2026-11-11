package com.lukasbaxter.slopify.android.features.home

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.app.SeeAllKind
import com.lukasbaxter.slopify.android.app.Tab
import com.lukasbaxter.slopify.android.core.api.mix
import com.lukasbaxter.slopify.android.core.api.topSongs
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.CardStyle
import com.lukasbaxter.slopify.android.design.components.Chip
import com.lukasbaxter.slopify.android.design.components.MediaCard
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.SectionHeader
import com.lukasbaxter.slopify.android.design.components.SectionStyle
import com.lukasbaxter.slopify.android.design.components.Shelf
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.components.shellContentPadding
import com.lukasbaxter.slopify.android.design.image.Avatar
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.launch
import java.io.File
import java.util.Calendar

// The screens the shell routes to (names as on iOS, ios/Slopify/Features/Home).

/**
 * Home tab root (UI.md 6.1; ios HomeView.swift): floating avatar over a sticky All / Music /
 * Artists chip row, the shortcut grid, then the shelves in the web's order. No greeting on phone,
 * no loading states: sections appear when their data does. Pull to refresh reloads every source.
 */
@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun HomeView() {
    val app = LocalAppModel.current
    val nav = app.nav
    val account = app.account
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val store = homeStore()
    val st by store.state.collectAsStateWithLifecycle()
    val user by account.user.collectAsStateWithLifecycle()
    val saved by account.saved.collectAsStateWithLifecycle()
    val navState by nav.state.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableStateOf(HomeLogic.Filter.All) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    val topInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()

    val key = HomeStore.key(saved?.main, user?.id)
    LaunchedEffect(key) { store.load(account.api, maxAgeMs = 60_000) }

    // Tapping the lit Home tab on its root bumps this: scroll to the top.
    val scrollSignal = navState.scrollToTop[Tab.Home] ?: 0
    val seenSignal = remember { intArrayOf(scrollSignal) }
    LaunchedEffect(scrollSignal) {
        if (scrollSignal != seenSignal[0]) {
            seenSignal[0] = scrollSignal
            list.animateScrollToItem(0)
        }
    }

    val scrollTop by homeScrollTop(list)
    val stuck = with(density) { scrollTop > 8.dp.toPx() }
    val barColor by animateColorAsState(if (stuck) theme.bgBase else theme.bgBase.copy(alpha = 0f), tween(200, easing = LinearEasing), label = "chips")
    val wash = theme.chip
    val page = theme.page

    val pull = rememberPullToRefreshState()
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            scope.launch {
                refreshing = true
                store.load(account.api, maxAgeMs = 0)
                refreshing = false
            }
        },
        modifier = Modifier.fillMaxSize()
            .background(theme.bgBase)
            // The soft wash over the first 250 dp scrolls with the content.
            .drawBehind {
                translate(top = -scrollTop) {
                    drawRect(Brush.verticalGradient(listOf(wash, page), endY = 250.dp.toPx()), size = Size(size.width, 250.dp.toPx()))
                }
            },
        state = pull,
        indicator = {
            PullToRefreshDefaults.Indicator(
                state = pull, isRefreshing = refreshing,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = topInset + 48.dp),
                containerColor = theme.chip, color = theme.fg,
            )
        },
    ) {
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = shellContentPadding()) {
            stickyHeader(key = "chips") {
                Row(
                    Modifier.fillMaxWidth().background(barColor)
                        .padding(top = 8.dp + topInset, end = Spacing.gutter, bottom = 8.dp, start = 56.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Chip(L("All"), on = filter == HomeLogic.Filter.All) { filter = HomeLogic.Filter.All }
                    Chip(L("Music"), on = filter == HomeLogic.Filter.Music) { filter = HomeLogic.Filter.Music }
                    Chip(L("Artists"), on = filter == HomeLogic.Filter.Artists) { filter = HomeLogic.Filter.Artists }
                }
            }
            item(key = "top") { Spacer(Modifier.height(16.dp)) }
            for (s in st.data.sections(filter)) {
                item(key = s.name) { Box(Modifier.padding(bottom = 24.dp)) { HomeSection(s, st.data) } }
            }
            item(key = "bottom") { Spacer(Modifier.height(24.dp)) }
        }
        val label = user?.name ?: L("Account")
        Box(
            Modifier.padding(top = 8.dp + topInset, start = Spacing.gutter)
                .pressable(PressFeedback.Fade) { nav.setDrawerOpen(true) }
                .semantics { contentDescription = label },
        ) { Avatar(user?.id, user?.name, size = 32.dp) }
    }
}

/** An artist's Daily Mix (UI.md 6.3.6): `GET /api/tracks/{artistId}/mix?limit=50&tzo=`, dislikes dropped. */
@Composable
fun DailyMixView(artistId: String, number: Int, seedName: String) {
    homeStore()
    HomeMixPage(
        context = "mix:$artistId",
        title = L("Daily Mix {n}", "n" to number),
        sub = if (seedName.isEmpty()) null else L("{name} and more", "name" to seedName),
        color = homeMixColor(number - 1),
        art = CoverSource.ArtistArt(artistId, null),
        radioSeed = artistId,
    ) { api -> api.mix(artistId, limit = 50).items }
}

/** Your Top Songs {year} (UI.md 6.3.6): `GET /api/top-songs/{year}?tzo=`, shown like a Daily Mix. */
@Composable
fun TopSongsView(year: Int, colorIndex: Int) {
    val st by homeStore().state.collectAsStateWithLifecycle()
    val top = st.data.topYears.firstOrNull { it.year == year }?.top
    HomeMixPage(
        context = "top:$year",
        title = L("Your Top Songs {year}", "year" to year),
        sub = HomeLogic.topSongsSub(year, homeCurrentYear()),
        color = homeMixColor(colorIndex),
        art = top?.let { CoverSource.AlbumArt(it.albumId, it.cover) },
        radioSeed = null,
    ) { api -> api.topSongs(year) }
}

@Composable
fun ReleaseRadarView() {
    homeStore()
    HomeReleaseRadarPage()
}

@Composable
fun SeeAllView(kind: SeeAllKind) {
    homeStore()
    HomeSeeAllPage(kind)
}

// Home body

@Composable
private fun HomeSection(s: HomeLogic.Section, data: HomeSnapshot) {
    val nav = LocalAppModel.current.nav
    when (s) {
        HomeLogic.Section.Shortcuts -> HomeShortcutGrid(data.shortcuts)
        HomeLogic.Section.MadeForYou -> HomeShelf(L("Made For You"), null) {
            Shelf(data.mixSeeds.withIndex().toList(), style = CardStyle.Home) { (i, a) ->
                val label = L("Daily Mix {n}", "n" to i + 1)
                MediaCard(label, L("{name} and more", "name" to a.name), style = CardStyle.Home, onClick = {
                    nav.pushFromHome(Route.DailyMix(a.id, i + 1, a.name))
                }) {
                    HomeMixArt(CoverSource.ArtistArt(a.id, a.image), homeMixColor(i), label, pixelSize = 150.dp)
                }
            }
        }
        HomeLogic.Section.TopSongs -> {
            val year = homeCurrentYear()
            HomeShelf(L("Your Top Songs"), null) {
                Shelf(data.topYears.withIndex().toList(), style = CardStyle.Home) { (i, y) ->
                    val label = L("Your Top Songs {year}", "year" to y.year)
                    MediaCard(label, HomeLogic.topSongsSub(y.year, year), style = CardStyle.Home, onClick = {
                        nav.pushFromHome(Route.TopSongs(y.year, i))
                    }) {
                        HomeMixArt(y.top?.let { CoverSource.AlbumArt(it.albumId, it.cover) }, homeMixColor(i), label, pixelSize = 150.dp)
                    }
                }
            }
        }
        HomeLogic.Section.Recent -> HomeShelf(L("Recently played"), { nav.pushFromHome(Route.SeeAll(SeeAllKind.Albums)) }) {
            Shelf(data.recent, style = CardStyle.Home) { a ->
                MediaCard(CoverSource.of(a), a.name, a.artist.ifEmpty { L("Album") }, style = CardStyle.Home, artSize = 150.dp) {
                    nav.pushFromHome(Route.Album(a.id))
                }
            }
        }
        HomeLogic.Section.JumpBackIn -> HomeShelf(L("Jump back in"), { nav.push(Route.SeeAll(SeeAllKind.Artists)) }) {
            HomeArtistShelf(data.recentArtists)
        }
        HomeLogic.Section.Radar -> HomeShelf(L("Release Radar"), { nav.pushFromHome(Route.ReleaseRadar) }) {
            Shelf(data.radarShelf, style = CardStyle.Home) { r -> HomeRadarCard(r) }
        }
        HomeLogic.Section.TopArtists -> HomeShelf(L("Your top artists"), { nav.push(Route.SeeAll(SeeAllKind.TopArtists)) }) {
            HomeArtistShelf(data.topArtists.take(16))
        }
    }
}

/** 2 columns, gap 8, up to 8 tiles (UI.md 6.1.4). */
@Composable
private fun HomeShortcutGrid(shortcuts: List<HomeLogic.Shortcut>) {
    val nav = LocalAppModel.current.nav
    Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (row in shortcuts.chunked(2)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (s in row) {
                    HomeShortcutTile(s, Modifier.weight(1f)) {
                        when (s) {
                            HomeLogic.Shortcut.Liked -> nav.pushFromHome(Route.LikedSongs)
                            is HomeLogic.Shortcut.AlbumTile -> nav.pushFromHome(Route.Album(s.album.id))
                            is HomeLogic.Shortcut.PlaylistTile -> nav.pushFromHome(Route.Playlist(s.playlist.id))
                        }
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun HomeArtistShelf(list: List<HomeLogic.RankedArtist>) {
    val nav = LocalAppModel.current.nav
    Shelf(list, style = CardStyle.Home) { a ->
        MediaCard(CoverSource.ArtistArt(a.id, a.image), a.name, L("Artist"), round = true, style = CardStyle.Home, artSize = 150.dp) {
            nav.push(Route.Artist(a.id))
        }
    }
}

@Composable
private fun HomeRadarCard(r: Release) {
    val nav = LocalAppModel.current.nav
    val lib = r.inLibrary
    if (lib != null) {
        MediaCard(CoverSource.AlbumArt(lib, null), r.title, HomeLogic.radarShelfSub(r), style = CardStyle.Home, artSize = 150.dp) {
            nav.pushFromHome(Route.Album(lib))
        }
    } else {
        // Not in the library yet: the artist's page, where it can be requested.
        MediaCard(CoverSource.Url(r.image), r.title, HomeLogic.radarShelfSub(r), style = CardStyle.Home, artSize = 150.dp) {
            r.artistId?.let { nav.push(Route.Artist(it)) }
        }
    }
}

/** A Home shelf: 24/700 heading (tappable when it has a see-all target; no "Show all" on Home). */
@Composable
private fun HomeShelf(title: String, seeAll: (() -> Unit)?, rows: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        SectionHeader(title, if (seeAll != null) Modifier.pressable(PressFeedback.None, onTap = seeAll) else Modifier, style = SectionStyle.Home)
        rows()
    }
}

// Helpers

/**
 * The shared store, its kept copies in the app cache, switched to the signed-in account during
 * composition so the first frame already paints the kept copy.
 */
@Composable
private fun homeStore(): HomeStore {
    val context = LocalContext.current
    val account = LocalAppModel.current.account
    val user by account.user.collectAsStateWithLifecycle()
    val saved by account.saved.collectAsStateWithLifecycle()
    val store = HomeStore.shared
    if (store.cacheDir == null) store.cacheDir = File(context.cacheDir, "slopify-home")
    val key = HomeStore.key(saved?.main, user?.id)
    remember(key) { store.use(key) }
    return store
}

/** Pixels scrolled from the top of the list (sticky header included), for the wash and the stuck bar. */
@Composable
private fun homeScrollTop(list: LazyListState) = remember(list) {
    val sizes = HashMap<Int, Int>()
    derivedStateOf {
        for (i in list.layoutInfo.visibleItemsInfo) sizes[i.index] = i.size
        val first = list.firstVisibleItemIndex
        ((0 until first).sumOf { sizes[it] ?: 0 } + list.firstVisibleItemScrollOffset).toFloat()
    }
}

private fun homeMixColor(i: Int): RGB = Theme.Fixed.mixPalette[HomeLogic.mixColorIndex(i)]

private fun homeCurrentYear(): Int = Calendar.getInstance().get(Calendar.YEAR)
