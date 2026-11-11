package com.lukasbaxter.slopify.android.features.home

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.AppModel
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.components.ActionRow
import com.lukasbaxter.slopify.android.design.components.BigPlayButton
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.ErrorBanner
import com.lukasbaxter.slopify.android.design.components.HeroHeader
import com.lukasbaxter.slopify.android.design.components.HeroOwner
import com.lukasbaxter.slopify.android.design.components.IconButton
import com.lukasbaxter.slopify.android.design.components.PlaceholderNote
import com.lukasbaxter.slopify.android.design.components.SkeletonRows
import com.lukasbaxter.slopify.android.design.components.TrackMenu
import com.lukasbaxter.slopify.android.design.components.TrackMenuBuilder
import com.lukasbaxter.slopify.android.design.components.TrackRow
import com.lukasbaxter.slopify.android.design.components.pageBanner
import com.lukasbaxter.slopify.android.design.components.rememberTrackMenuBuilder
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyph
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyphMode
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuHeader
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialog
import com.lukasbaxter.slopify.android.design.sheets.NameDialogHost
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.player.ShuffleMode
import com.lukasbaxter.slopify.android.player.StreamPolicy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/**
 * Daily Mix / Your Top Songs page (UI.md 6.3.6; ios HomeMixPage.swift): opens at once with
 * skeleton rows, the Home tile composite as cover, mix mark + "Made for you", ⋯ | Shuffle, Play,
 * rows with art.
 *
 * - `context`: player context, `mix:<artistId>` or `top:<year>`.
 * - `radioSeed`: the Daily Mix's artist; null hides "Go to radio".
 */
@Composable
internal fun HomeMixPage(
    context: String,
    title: String,
    sub: String?,
    color: RGB,
    art: CoverSource?,
    radioSeed: String?,
    load: suspend (ApiClient) -> List<Track>,
) {
    val app = LocalAppModel.current
    val player = app.player
    val ps by player.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var tracks by remember(context) { mutableStateOf<List<Track>>(emptyList()) }
    var loading by remember(context) { mutableStateOf(true) }
    var failure by remember(context) { mutableStateOf<HomeMixPageFailure?>(null) }
    var menu by remember { mutableStateOf<MenuSheet?>(null) }
    var dialog by remember { mutableStateOf<NameDialog?>(null) }
    val menus = rememberTrackMenuBuilder { dialog = it }

    val hero = remember(color) { ColorMath.heroTint(color) }
    val isContext = ps.context == context

    LaunchedEffect(context) {
        loading = true
        try {
            val items = load(app.account.api)
            tracks = StreamPolicy.dropDisliked(items, app.account.prefs.value)
            failure = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = HomeMixPageFailure.of(e)
        }
        loading = false
    }

    fun playPage() {
        if (isContext) { player.togglePlay(); return }
        if (tracks.isEmpty()) return
        player.play(tracks, startAt = 0, context = context)
    }

    fun playRow(i: Int) {
        if (ps.current?.id == tracks[i].id) { player.togglePlay(); return }
        player.play(tracks, startAt = i, context = context)
    }

    DetailScaffold(title, heroColor = hero) {
        item(key = "hero") {
            HeroHeader(hero, title, coverSize = 208.dp, cover = {
                HomeMixArt(art, color, title, pixelSize = 208.dp, large = true)
            }) {
                HeroOwner(L("Made for you")) { HomeMixMark(color) }
                Text(HomeLogic.mixStats(sub, tracks.sumOf { it.durationMs }))
            }
        }
        item(key = "actions") {
            ActionRow(hero, leading = {
                IconButton(Icon.Dots24, L("More options")) {
                    menu = homeMixMenu(app, menus, { dialog = it }, scope, title, art, tracks, radioSeed)
                }
            }) {
                val shuffleOn = ps.shuffle != ShuffleMode.Off
                IconButton(if (shuffleOn) L("Disable shuffle") else L("Enable shuffle"), on = shuffleOn, onClick = {
                    player.setShuffle(if (shuffleOn) ShuffleMode.Off else ShuffleMode.On)
                }) { tint ->
                    val mode = when {
                        ps.shuffle == ShuffleMode.Smart -> ShuffleGlyphMode.Smart
                        shuffleOn -> ShuffleGlyphMode.On
                        else -> ShuffleGlyphMode.Off
                    }
                    ShuffleGlyph(mode, size = 24.dp, tint = tint)
                }
                BigPlayButton(isContext && ps.isPlaying, Modifier.padding(start = 4.dp)) { playPage() }
            }
        }
        val f = failure
        if (f is HomeMixPageFailure.Error) item(key = "banner") { ErrorBanner(f.message, Modifier.pageBanner()) }
        when {
            loading && tracks.isEmpty() -> item(key = "skeleton") { SkeletonRows(count = 8, art = true) }
            tracks.isEmpty() -> item(key = "note") {
                PlaceholderNote(
                    when {
                        f == HomeMixPageFailure.Offline -> L("Not available offline. Open it once with a connection, or download it.")
                        f != null -> L("Couldn’t load this — try again.")
                        else -> L("Nothing here yet.")
                    },
                )
            }
            else -> itemsIndexed(tracks, key = { i, _ -> i }) { i, t ->
                TrackRow(
                    t, showArt = true, isCurrent = ps.current?.id == t.id, isPlaying = ps.isPlaying,
                    onMore = { menu = menus.sheet(t) },
                    onArt = { app.nav.push(Route.Album(t.albumId)) },
                    onTouchDown = { player.prewarm(t) },
                ) { playRow(i) }
            }
        }
    }
    ContextMenuSheet(menu) { menu = null }
    NameDialogHost(dialog) { dialog = null }
}

/** Why a mix page has no rows. Offline shows its own note and no banner (Library.jsx `e.offline`). */
internal sealed interface HomeMixPageFailure {
    data object Offline : HomeMixPageFailure
    data class Error(val message: String) : HomeMixPageFailure

    companion object {
        fun of(e: Throwable): HomeMixPageFailure = if (e is ApiError.Offline) Offline else Error(HomeStore.message(e))
    }
}

/** The mix page's ⋯ sheet (UI.md 5.6.1, Mix column; ios HomeMenus.swift). Track rows use the shared builder. */
private fun homeMixMenu(
    app: AppModel,
    menus: TrackMenuBuilder,
    askName: (NameDialog) -> Unit,
    scope: CoroutineScope,
    title: String,
    art: CoverSource?,
    tracks: List<Track>,
    radioSeed: String?,
): MenuSheet {
    val player = app.player
    val items = mutableListOf(
        MenuItem(L("Add to queue"), Icon.Queue, offline = true) { if (tracks.isNotEmpty()) player.addToQueue(tracks) },
    )
    if (radioSeed != null) {
        items += MenuItem(L("Go to radio"), Icon.Radio) { scope.launch { player.startRadio(radioSeed, null) } }
    }
    tracks.firstOrNull()?.let { first ->
        val library = app.library
        if (library.playlists.isEmpty()) scope.launch { library.refreshPlaylists() }
        // One POST with every id, one toast (App.jsx onAddTo); New playlist is seeded with the first song.
        val sub = TrackMenu.playlistSub(
            library.playlists,
            new = { askName(menus.newPlaylistDialog(first)) },
            add = { p -> scope.launch { library.add(tracks.map { it.id }, p) } },
        )
        items += MenuItem(L("Add to playlist"), Icon.Plus, sub = sub)
    }
    val shown = if (app.connectivity.offline.value) MenuItem.offlineSubset(items) else MenuItem.tidy(items)
    val header = MenuHeader(art?.let { MenuHeader.Art.Cover(it) } ?: MenuHeader.Art.Glyph(Icon.MusicNote), title, L("Playlist"))
    return MenuSheet(header, shown)
}
