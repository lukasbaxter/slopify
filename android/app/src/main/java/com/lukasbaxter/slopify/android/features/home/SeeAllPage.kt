package com.lukasbaxter.slopify.android.features.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Navigator
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.app.SeeAllKind
import com.lukasbaxter.slopify.android.app.Tab
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.CardGrid
import com.lukasbaxter.slopify.android.design.components.CardStyle
import com.lukasbaxter.slopify.android.design.components.Chip
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.LocalDetailTopInset
import com.lukasbaxter.slopify.android.design.components.MediaCard
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme

/**
 * See-all pages (UI.md 6.3.10; ios SeeAllView.swift): Albums, Artists, Your top artists. A sticky
 * All / Music / Artists chip row under the top bar, an inline heading and a two-column grid of
 * Home-style cards.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun HomeSeeAllPage(kind: SeeAllKind) {
    val app = LocalAppModel.current
    val nav = app.nav
    val theme = LocalTheme.current
    val store = HomeStore.shared
    val st by store.state.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) {
        store.load(app.account.api, maxAgeMs = 60_000)
    }

    val title = homeSeeAllTitle(kind)
    // The bar mixes the page's default `--hero` (#3d3c3c), as on the web.
    DetailScaffold(title, heroColor = Theme.Fixed.defaultHero) {
        stickyHeader(key = "chips") { SeeAllChips(kind) { homeSeeAllSelect(nav, kind, it) } }
        item(key = "heading") {
            Text(title, style = TextStyles.titleSm, color = theme.fg, modifier = Modifier.padding(horizontal = Spacing.gutter).padding(bottom = 16.dp))
        }
        item(key = "grid") {
            when (kind) {
                SeeAllKind.Albums -> CardGrid(st.data.albums) { a ->
                    MediaCard(CoverSource.of(a), a.name, a.artist, style = CardStyle.Home, artSize = 175.dp) { nav.push(Route.Album(a.id)) }
                }
                SeeAllKind.Artists -> CardGrid(st.data.artists) { a ->
                    MediaCard(CoverSource.of(a), a.name, L("Artist"), round = true, style = CardStyle.Home, artSize = 175.dp) { nav.push(Route.Artist(a.id)) }
                }
                SeeAllKind.TopArtists -> CardGrid(st.data.topArtists) { a ->
                    MediaCard(CoverSource.ArtistArt(a.id, a.image), a.name, L("Artist"), round = true, style = CardStyle.Home, artSize = 175.dp) {
                        nav.push(Route.Artist(a.id))
                    }
                }
            }
        }
    }
}

internal fun homeSeeAllTitle(k: SeeAllKind): String = when (k) {
    SeeAllKind.Albums -> L("Albums")
    SeeAllKind.Artists -> L("Artists")
    SeeAllKind.TopArtists -> L("Your top artists")
}

/** All → Home root; Music / Artists swap this page for the other list (the web replaces, not pushes). */
internal fun homeSeeAllSelect(nav: Navigator, current: SeeAllKind, target: SeeAllKind?) {
    if (target == null) {
        // On Home this pops to the root; from another tab it switches and lands on the root.
        nav.select(Tab.Home)
        return
    }
    if (target == current) return
    nav.pop()
    nav.push(Route.SeeAll(target))
}

/** The sticky chip row: padding `56 + inset` 16 8, `--bg-base`. Music is on for Albums, Artists for Artists, none for top artists. */
@Composable
private fun SeeAllChips(kind: SeeAllKind, select: (SeeAllKind?) -> Unit) {
    val theme = LocalTheme.current
    val topInset = LocalDetailTopInset.current
    Row(
        Modifier.fillMaxWidth().background(theme.bgBase)
            .padding(top = Shell.topBar + topInset, start = Spacing.gutter, end = Spacing.gutter, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Chip(L("All")) { select(null) }
        Chip(L("Music"), on = kind == SeeAllKind.Albums) { select(SeeAllKind.Albums) }
        Chip(L("Artists"), on = kind == SeeAllKind.Artists) { select(SeeAllKind.Artists) }
    }
}
