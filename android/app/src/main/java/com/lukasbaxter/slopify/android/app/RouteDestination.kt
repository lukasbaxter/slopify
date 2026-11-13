package com.lukasbaxter.slopify.android.app

import androidx.compose.runtime.Composable
import com.lukasbaxter.slopify.android.features.account.DownloadsView
import com.lukasbaxter.slopify.android.features.account.HistoryView
import com.lukasbaxter.slopify.android.features.account.ProfileView
import com.lukasbaxter.slopify.android.features.account.ScrobblingView
import com.lukasbaxter.slopify.android.features.account.SettingsView
import com.lukasbaxter.slopify.android.features.detail.AlbumView
import com.lukasbaxter.slopify.android.features.detail.ArtistView
import com.lukasbaxter.slopify.android.features.home.DailyMixView
import com.lukasbaxter.slopify.android.features.home.RadioView
import com.lukasbaxter.slopify.android.features.home.ReleaseRadarView
import com.lukasbaxter.slopify.android.features.home.SeeAllView
import com.lukasbaxter.slopify.android.features.home.TopSongsView
import com.lukasbaxter.slopify.android.features.library.FolderView
import com.lukasbaxter.slopify.android.features.library.LikedSongsView
import com.lukasbaxter.slopify.android.features.library.PlaylistView
import com.lukasbaxter.slopify.android.features.search.GenreView
import com.lukasbaxter.slopify.android.features.search.SearchBrowsePage

/** Route -> screen. Exhaustive: a new Route does not compile until it has a screen. */
@Composable
fun RouteDestination(route: Route) {
    when (route) {
        is Route.Album -> AlbumView(route.id, route.highlightTrack)
        is Route.Artist -> ArtistView(route.id)
        is Route.Playlist -> PlaylistView(route.id)
        Route.LikedSongs -> LikedSongsView()
        is Route.DailyMix -> DailyMixView(route.artistId, route.number, route.seedName)
        is Route.TopSongs -> TopSongsView(route.year, route.colorIndex)
        is Route.Radio -> RadioView(route.seedId, route.nameHint)
        is Route.Genre -> GenreView(route.name)
        Route.Charts -> SearchBrowsePage(charts = true)
        is Route.Folder -> FolderView(route.id)
        Route.ReleaseRadar -> ReleaseRadarView()
        is Route.SeeAll -> SeeAllView(route.kind)
        Route.Profile -> ProfileView()
        Route.History -> HistoryView()
        Route.Downloads -> DownloadsView()
        Route.Settings -> SettingsView()
        Route.Scrobbling -> ScrobblingView()
    }
}
