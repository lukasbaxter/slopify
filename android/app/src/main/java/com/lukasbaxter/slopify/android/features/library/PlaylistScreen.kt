package com.lukasbaxter.slopify.android.features.library

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.api.addToPlaylist
import com.lukasbaxter.slopify.android.core.api.movePlaylistTrack
import com.lukasbaxter.slopify.android.core.api.playlist
import com.lukasbaxter.slopify.android.core.api.playlistRecommended
import com.lukasbaxter.slopify.android.core.api.removeFromPlaylist
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.PlaylistDetail
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.color.ArtworkColor
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.components.ActionRow
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.HeroHeader
import com.lukasbaxter.slopify.android.design.components.HeroOwner
import com.lukasbaxter.slopify.android.design.components.IconButton
import com.lukasbaxter.slopify.android.design.components.PlaceholderNote
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.SkeletonRows
import com.lukasbaxter.slopify.android.design.components.TrackRow
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.components.rememberTrackMenuBuilder
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.image.Avatar
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.image.ImageLoader
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.sheets.ConfirmDialog
import com.lukasbaxter.slopify.android.design.sheets.ConfirmDialogHost
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuHeader
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialog
import com.lukasbaxter.slopify.android.design.sheets.NameDialogHost
import com.lukasbaxter.slopify.android.design.sheets.OverlayCover
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.player.StreamPolicy
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException

/** A playlist row with a key that survives moves (the same song can be in a list twice). */
data class LibraryPlaylistEntry(val track: Track, val key: String = UUID.randomUUID().toString())

private const val SONG_KEY = "song-"

/**
 * A user playlist (UI.md 6.3.2-6.3.4, 6.3.11; ios PlaylistView.swift): hero with the cover and
 * title as "Edit details" buttons, action row, the songs (art, ⋯ with "Remove from this
 * playlist"), Recommended. Songs reorder by hold-to-drag, the same feel as Your Library: hold
 * lifts the row, the others slide aside, the list scrolls near the edges, the drop saves
 * `{from, to}`; hold and let go without moving opens the song menu (DECISIONS: reorder by touch).
 */
@Composable
internal fun PlaylistScreen(id: String) {
    val ctx = rememberLibraryContext()
    val app = ctx.app
    val store = ctx.store
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val st by store.state.collectAsStateWithLifecycle()
    val user by app.account.user.collectAsStateWithLifecycle()
    val offline by app.connectivity.offline.collectAsStateWithLifecycle()
    val player by app.player.state.collectAsStateWithLifecycle()

    var playlist by remember { mutableStateOf<Playlist?>(null) }
    var entries by remember { mutableStateOf<List<LibraryPlaylistEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var failed by remember { mutableStateOf(false) }
    var hero by remember { mutableStateOf<RGB?>(null) }
    var menu by remember { mutableStateOf<MenuSheet?>(null) }
    var nameDialog by remember { mutableStateOf<NameDialog?>(null) }
    var confirm by remember { mutableStateOf<ConfirmDialog?>(null) }
    var editing by remember { mutableStateOf<LibraryEditDetails?>(null) }
    var reco by remember { mutableStateOf<List<Track>>(emptyList()) }
    var recoLoading by remember { mutableStateOf(false) }
    var recoGen by remember { mutableIntStateOf(0) }
    var listWidthPx by remember { mutableIntStateOf(0) }
    val drag = remember { LibraryDragController() }
    val listState = rememberLazyListState()
    val menus = rememberTrackMenuBuilder { nameDialog = it }

    val tracks = entries.map { it.track }
    val name = playlist?.name ?: st.playlists.firstOrNull { it.id == id }?.name
    val heroColor = hero ?: ColorMath.detailHero()
    val topInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    fun coverUrl(): String? = app.account.api.imageUrl(id, 120, bust = playlist?.cover).toString()

    fun apply(d: PlaylistDetail) {
        val keep = entries.map { it.track.id } == d.tracks.map { it.id }
        playlist = d.playlist
        if (!keep) entries = d.tracks.map { LibraryPlaylistEntry(it) }
    }

    suspend fun loadRecommended() {
        if (ctx.offline) return
        recoLoading = true
        try {
            val items = attempt { app.account.api.playlistRecommended(id, 10, recoGen) } ?: emptyList()
            reco = StreamPolicy.dropDisliked(items, app.account.prefs.value)
        } finally {
            recoLoading = false
        }
    }

    suspend fun load() {
        try {
            val d = app.account.api.playlist(id)
            store.remember(d)
            apply(d)
            failed = false
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // TODO(lead): offline store: show the downloaded songs of a playlist never opened in this run.
            failed = entries.isEmpty()
        }
        loading = false
        hero = ColorMath.detailHero(sampled = ArtworkColor.shared.vibrant(coverUrl()))
        if (reco.isEmpty()) loadRecommended()
    }

    fun openEdit() {
        if (playlist == null) return
        editing = LibraryEditDetails(id, playlist?.cover, name ?: "")
    }

    /** Positions are the shown index (API.md gotcha 7). */
    fun remove(e: LibraryPlaylistEntry) {
        val pos = entries.indexOfFirst { it.key == e.key }
        if (pos < 0) return
        entries = entries.filterIndexed { i, _ -> i != pos }
        ctx.scope.launch {
            try {
                app.account.api.removeFromPlaylist(id, listOf(pos))
                ToastCenter.shared.show(L("Removed from playlist"))
                store.refreshPlaylists()
            } catch (x: CancellationException) {
                throw x
            } catch (x: Exception) {
                ToastCenter.shared.show(L("Could not remove: {error}", "error" to (x.message ?: x.toString())))
                load()
            }
        }
    }

    /** Optimistic: move here first (final indexes, the web's splice), then tell the server; toast and reload on failure. */
    fun move(from: Int, to: Int) {
        if (from == to || from !in entries.indices || to !in entries.indices) return
        entries = LibraryText.moved(entries, from, to)
        ctx.scope.launch {
            try {
                app.account.api.movePlaylistTrack(id, from, to)
            } catch (x: CancellationException) {
                throw x
            } catch (x: Exception) {
                ToastCenter.shared.show(L("Could not reorder: {error}", "error" to (x.message ?: x.toString())))
                attempt { app.account.api.playlist(id) }?.let { d -> entries = d.tracks.map { LibraryPlaylistEntry(it) } }
            }
        }
    }

    fun addRecommended(t: Track) {
        reco = reco.filter { it.id != t.id }
        ctx.scope.launch {
            try {
                app.account.api.addToPlaylist(id, listOf(t.id))
                load()
                store.refreshPlaylists()
            } catch (x: CancellationException) {
                throw x
            } catch (x: Exception) {
                ToastCenter.shared.show(L("Could not add: {error}", "error" to (x.message ?: x.toString())))
            }
        }
    }

    fun trackMenu(e: LibraryPlaylistEntry): MenuSheet = menus.sheet(e.track, remove = { remove(e) })

    fun heroMenu(): MenuSheet {
        val list = tracks
        val p = playlist
        val title = name ?: ""
        val items = mutableListOf(
            MenuItem(L("Add to queue"), Icon.Queue, offline = true) { app.player.addToQueue(list) },
            MenuItem(L("Go to radio"), Icon.Radio) { app.nav.open(Route.Radio(id, name)) },
        )
        if (list.isNotEmpty()) {
            val sub = mutableListOf(MenuItem(L("New playlist"), Icon.Plus) { nameDialog = menus.newPlaylistDialog(list.first()) })
            sub += store.state.value.playlists.filter { it.id != id }.map { other -> MenuItem(other.name) { ctx.scope.launch { store.add(list.map { it.id }, other) } } }
            items += MenuItem(L("Add to playlist"), Icon.Plus, sub = sub)
        }
        // "Download as zip" is out (DECISIONS 5). TODO(lead): offline store "Download" rows.
        items += MenuItem.separator
        // TODO(lead): "Regenerate" for AI playlists needs the Generate dialog (UI.md 6.4).
        items += MenuItem(L("Edit details"), Icon.Edit) { openEdit() }
        items += MenuItem(L("Delete"), Icon.Trash, danger = true) {
            confirm = ConfirmDialog(L("Delete \"{name}\"?", "name" to title), L("Delete"), destructive = true) {
                if (p != null) ctx.scope.launch { if (store.deletePlaylist(p)) app.nav.pop() }
            }
        }
        val header = MenuHeader(MenuHeader.Art.Cover(CoverSource.PlaylistArt(id, p?.cover)), title, L("Playlist"))
        return MenuSheet(header, if (ctx.offline) MenuItem.offlineSubset(items) else MenuItem.tidy(items))
    }

    LaunchedEffect(id) {
        store.state.value.details[id]?.let(::apply)
        load()
        // "Edit details" from Your Library: open the dialog 300 ms after the page (App.jsx:1658).
        if (store.pendingEditDetails.value == id) {
            store.pendingEditDetails.value = null
            delay(300)
            openEdit()
        }
    }
    // Songs added here from another screen: reload.
    val revision = st.revision[id] ?: 0
    var seenRevision by remember { mutableIntStateOf(revision) }
    LaunchedEffect(revision) {
        if (revision == seenRevision) return@LaunchedEffect
        seenRevision = revision
        load()
    }

    // Hold to drag: fixed 64 dp rows, so the lazy list needs no measuring.
    SideEffect {
        drag.rows = {
            val w = listWidthPx / density.density
            entries.mapIndexed { i, e -> LibraryDrag.Row(e.key, false, Rect(0f, i * Shell.trackRow.value, w, (i + 1) * Shell.trackRow.value)) }
        }
        drag.canEnter = { false }
        drag.coveredTop = Shell.topBar.value + topInset.value
        drag.coveredBottom = Shell.contentBottom.value - 24
        drag.origin = origin@{
            val info = listState.layoutInfo
            val rowPx = with(density) { Shell.trackRow.roundToPx() }
            val keys = entries.mapIndexed { i, e -> (SONG_KEY + e.key) to i }.toMap()
            val item = info.visibleItemsInfo.firstOrNull { it.key in keys } ?: return@origin null
            (item.offset - info.viewportStartOffset - keys.getValue(item.key as String) * rowPx) / density.density
        }
        drag.scrollBy = { px -> listState.dispatchRawDelta(px) }
        drag.onFinish = { outcome ->
            val canMove = entries.size > 1 && !ctx.offline
            when (outcome) {
                is LibraryDragController.Outcome.Hold -> entries.firstOrNull { it.key == outcome.id }?.let { menu = trackMenu(it) }
                is LibraryDragController.Outcome.Drop -> {
                    val from = outcome.rows.indexOf(outcome.id)
                    if (canMove && from >= 0) move(from, outcome.to)
                }
                null -> Unit
            }
        }
    }

    Box(Modifier.fillMaxSize().onSizeChanged { listWidthPx = it.width }) {
        DetailScaffold(name ?: "", Modifier.libraryDragHost(drag), heroColor = heroColor, state = listState) {
            item(key = "pl-hero") {
                val choose = L("Choose photo")
                HeroHeader(heroColor, name, onTitleTap = { openEdit() }, cover = {
                    CoverImage(
                        CoverSource.PlaylistArt(id, playlist?.cover), 250.dp,
                        Modifier.fillMaxSize().pressable(PressFeedback.None) { openEdit() }.semantics { contentDescription = choose },
                        shape = CoverShape.Rounded(Radius.art), placeholder = CoverPlaceholder.CardHover,
                    )
                }) {
                    HeroOwner(user?.name ?: L("You"), onClick = { app.nav.push(Route.Profile) }) { Avatar(user?.id, user?.name, size = 20.dp, drawer = true) }
                    if (!loading || entries.isNotEmpty()) Text(LibraryText.playlistStats(tracks))
                }
            }
            item(key = "pl-actions") {
                ActionRow(heroColor, leading = {
                    // TODO(lead): offline store download button (OfflineDownloadButton).
                    IconButton(Icon.Dots24, L("More options")) { menu = heroMenu() }
                }) {
                    LibraryPageButtons(ctx, player, id) { ctx.playPage(tracks, id) }
                }
            }
            when {
                entries.isEmpty() && loading -> item(key = "pl-skeleton") { SkeletonRows(count = 8, art = true) }
                entries.isEmpty() -> item(key = "pl-empty") {
                    PlaceholderNote(
                        if (failed) {
                            if (offline) L("Not available offline. Open it once with a connection, or download it.") else L("Couldn’t load this — try again.")
                        } else L("This playlist is empty."),
                    )
                }
                else -> itemsIndexed(entries, key = { _, e -> SONG_KEY + e.key }) { i, e ->
                    LibraryDragSlot(drag, e.key) { PlaylistSongRow(e, player.current?.id == e.track.id, player.isPlaying, offline, ctx, onMore = {
                        // The row's own 450 ms press fires while a hold-to-drag owns the finger: the drag decides.
                        if (!drag.holding) menu = trackMenu(e)
                    }) { ctx.play(tracks, i, id) } }
                }
            }
            // Recommended (6.3.4)
            if (!loading && !offline && (recoLoading || reco.isNotEmpty())) {
                item(key = "pl-reco-head") {
                    Column(Modifier.padding(top = 24.dp + 16.dp).padding(horizontal = Spacing.gutter).padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(L("Recommended"), style = TextStyles.sectionDetail, color = theme.fg)
                        Text(L("Based on what’s in this playlist"), fontSize = 13.sp, color = theme.fgSub)
                    }
                }
                if (recoLoading && reco.isEmpty()) {
                    item(key = "pl-reco-loading") { PlaceholderNote(L("Finding songs…")) }
                } else {
                    itemsIndexed(reco, key = { _, t -> "reco-" + t.id }) { i, t ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.weight(1f)) {
                                TrackRow(
                                    t, showArt = true, isCurrent = player.current?.id == t.id,
                                    onArt = { app.nav.push(Route.Album(t.albumId)) },
                                    onTouchDown = { app.player.prewarm(t) },
                                ) { ctx.play(reco, i, id) }
                            }
                            Box(
                                Modifier.padding(end = Spacing.gutter)
                                    .pressable(PressFeedback.Fade) { addRecommended(t) }
                                    .defaultMinSize(minHeight = 32.dp)
                                    .border(1.dp, theme.fgDim, CircleShape)
                                    .padding(horizontal = 16.dp),
                                contentAlignment = Alignment.Center,
                            ) { Text(L("Add"), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = theme.fg) }
                        }
                    }
                    item(key = "pl-reco-refresh") {
                        Text(
                            L("Refresh"), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = theme.fg,
                            modifier = Modifier.pressable(PressFeedback.Fade) { recoGen += 1; ctx.scope.launch { loadRecommended() } }
                                .padding(vertical = 14.dp, horizontal = 16.dp),
                        )
                    }
                }
            }
        }
        LibraryDragOverlay(drag) { key ->
            val e = entries.firstOrNull { it.key == key } ?: return@LibraryDragOverlay
            PlaylistSongRow(e, player.current?.id == e.track.id, player.isPlaying, offline, ctx, onMore = {}) {}
        }
    }

    ContextMenuSheet(menu) { menu = null }
    NameDialogHost(nameDialog) { nameDialog = null }
    ConfirmDialogHost(confirm) { confirm = null }
    OverlayCover(editing, { editing = null }) { e, close ->
        LibraryEditDetailsDialog(e, ctx::jpeg, close) { newName, jpeg ->
            val p = playlist ?: return@LibraryEditDetailsDialog
            ctx.scope.launch {
                if (store.edit(p, newName, jpeg)) {
                    if (jpeg != null) coverUrl()?.let { ImageLoader.shared.evict(it) }
                    load()
                }
            }
        }
    }
}

@Composable
private fun PlaylistSongRow(e: LibraryPlaylistEntry, current: Boolean, playing: Boolean, offline: Boolean, ctx: LibraryContext, onMore: () -> Unit, onTap: () -> Unit) {
    val held = ctx.player.localFile?.invoke(e.track.id) != null
    Box(Modifier.fillMaxWidth().height(Shell.trackRow)) {
        TrackRow(
            e.track, showArt = true, isCurrent = current, isPlaying = playing,
            isDownloaded = held, isUnavailable = offline && !held,
            onMore = onMore,
            onArt = { if (e.track.albumId.isNotEmpty()) ctx.nav.push(Route.Album(e.track.albumId)) },
            onTouchDown = { ctx.player.prewarm(e.track) },
            onTap = onTap,
        )
    }
}
