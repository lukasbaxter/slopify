package com.lukasbaxter.slopify.android.features.detail

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.model.ItemKind
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.ActionRow
import com.lukasbaxter.slopify.android.design.components.BigPlayButton
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.HeroHeader
import com.lukasbaxter.slopify.android.design.components.HeroOwner
import com.lukasbaxter.slopify.android.design.components.IconButton
import com.lukasbaxter.slopify.android.design.components.PlaceholderNote
import com.lukasbaxter.slopify.android.design.components.SkeletonRows
import com.lukasbaxter.slopify.android.design.components.TrackMenu
import com.lukasbaxter.slopify.android.design.components.TrackRow
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyph
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyphMode
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuHeader
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialogHost
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.player.ShuffleMode
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/**
 * Album page (UI.md 6.3.2-6.3.4; Library.jsx detail kind 'Album'; ios AlbumView.swift): hero,
 * action row, the album's songs (no art, no numbers). A song link opens it with that row lit and centred.
 */
@Composable
internal fun DetailAlbumPage(id: String, highlightTrack: String?) {
    val actions = rememberDetailActions()
    val app = actions.app
    val context = LocalContext.current
    val density = LocalDensity.current
    val model = remember(id) { DetailAlbumModel(id) }
    val player by app.player.state.collectAsState()
    val likes by app.likes.state.collectAsState()
    val offline by app.connectivity.offline.collectAsState()
    val user by app.account.user.collectAsState()
    val list = rememberLazyListState()
    var scrolledToHighlight by rememberSaveable(id, highlightTrack) { mutableStateOf(false) }

    LaunchedEffect(id, user?.id) {
        val api = app.account.api
        launch { model.sampleColour(api) }
        model.load(api, user?.id, DetailCache.shared(context))
    }

    val album = model.album
    val tracks = model.tracks
    val pageContext = id
    val here = player.context == pageContext
    val saved = id in likes.albums
    val hero = model.hero

    // Centre the linked song once its row exists (hero = item 0, action row = item 1).
    LaunchedEffect(tracks, highlightTrack) {
        val hl = highlightTrack ?: return@LaunchedEffect
        val i = tracks.indexOfFirst { it.id == hl }
        if (scrolledToHighlight || i < 0) return@LaunchedEffect
        scrolledToHighlight = true
        val viewport = snapshotFlow { list.layoutInfo.viewportSize.height }.first { it > 0 }
        val row = with(density) { Shell.trackRow.toPx() }
        list.animateScrollToItem(i + 2, -((viewport - row) / 2).toInt())
    }

    fun toggleSave() {
        val on = !saved
        actions.launch {
            try {
                app.likes.set(id, ItemKind.Album, on)
                app.library.refreshAlbums()
                ToastCenter.shared.show(if (on) L("Added to Your Library") else L("Removed from Your Library"))
                actions.announceLibraryChange()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ToastCenter.shared.show(L("Could not update: {error}", "error" to DetailActions.message(e)))
            }
        }
    }

    fun openPageMenu() {
        val a = album ?: return
        val leadId = a.artistId?.takeIf { it.isNotEmpty() }
        val items = buildList {
            add(MenuItem(L("Add to queue"), Icon.Queue, offline = true) { app.player.addToQueue(tracks) })
            add(MenuItem(L("Go to radio"), Icon.Radio) { actions.radio(id) })
            if (tracks.isNotEmpty()) add(MenuItem(L("Add to playlist"), Icon.Plus, sub = actions.playlistSub(tracks, excluding = id)))
            if (leadId != null) add(MenuItem(L("Go to artist"), Icon.Artist, offline = true) { app.nav.push(Route.Artist(leadId)) })
            add(MenuItem(if (saved) L("Remove from Your Library") else L("Save to Your Library"), if (saved) Icon.HeartFilled else Icon.Heart) { toggleSave() })
            add(MenuItem(L("Share"), Icon.Share) { actions.share(TrackMenu.ShareKind.Album, id, a.name, if (leadId == null) null else a.artist) })
        }
        val header = MenuHeader(MenuHeader.Art.Cover(CoverSource.of(a)), a.name, if (leadId == null) L("Album") else a.artist)
        actions.menu = MenuSheet(header, actions.pageItems(items))
    }

    Box(Modifier.fillMaxSize()) {
        DetailScaffold(album?.name ?: "", heroColor = hero, state = list) {
            item(key = "hero") {
                HeroHeader(hero, album?.name, cover = {
                    CoverImage(CoverSource.AlbumArt(id, album?.cover), 250.dp, Modifier.fillMaxSize(), placeholder = CoverPlaceholder.Chip)
                }) {
                    val a = album
                    val artistId = a?.artistId?.takeIf { it.isNotEmpty() }
                    if (a != null && artistId != null) {
                        HeroOwner(a.artist, onClick = { app.nav.push(Route.Artist(artistId)) }) {
                            CoverImage(CoverSource.ArtistArt(artistId, null), 20.dp, Modifier.fillMaxSize(), shape = CoverShape.Circle, placeholder = CoverPlaceholder.None)
                        }
                    }
                    if (a != null) Text(DetailLogic.albumStats(a, tracks))
                }
            }
            item(key = "actions") {
                ActionRow(hero, leading = {
                    IconButton(
                        if (saved) Icon.HeartFilled else Icon.Heart,
                        if (saved) L("Remove from Your Library") else L("Save to Your Library"), on = saved,
                    ) { toggleSave() }
                    IconButton(Icon.Dots24, L("More options for {name}", "name" to (album?.name ?: ""))) { openPageMenu() }
                }) {
                    val shuffled = player.shuffle != ShuffleMode.Off
                    IconButton(if (shuffled) L("Disable shuffle") else L("Enable shuffle"), on = shuffled, onClick = actions::toggleShuffle) { tint ->
                        ShuffleGlyph(ShuffleGlyphMode.Off, size = 24.dp, tint = tint)
                    }
                    Spacer(Modifier.width(4.dp))
                    BigPlayButton(here && player.isPlaying) {
                        if (here) app.player.togglePlay() else if (tracks.isNotEmpty()) actions.playPage(tracks, pageContext)
                    }
                }
            }
            if (tracks.isEmpty()) {
                item(key = "empty") {
                    if (model.loading) SkeletonRows(count = 8) else model.emptyNote?.let { PlaceholderNote(it) }
                }
            } else {
                itemsIndexed(tracks, key = { i, t -> "${t.id}-$i" }) { i, t ->
                    val current = player.current?.id == t.id
                    val downloaded = actions.has(t.id)
                    TrackRow(
                        t, isCurrent = current, isPlaying = current && player.isPlaying,
                        isDownloaded = downloaded, isUnavailable = offline && !downloaded,
                        isHighlighted = t.id == highlightTrack,
                        onMore = { actions.openTrackMenu(t) },
                        onTouchDown = { app.player.prewarm(t) },
                    ) { if (current) app.player.togglePlay() else actions.playRow(tracks, i, pageContext) }
                }
            }
        }
        Box(Modifier.align(Alignment.TopCenter)) { DetailErrorBanner(actions.error) { actions.error = null } }
    }
    ContextMenuSheet(actions.menu) { actions.menu = null }
    NameDialogHost(actions.nameDialog) { actions.nameDialog = null }
}
