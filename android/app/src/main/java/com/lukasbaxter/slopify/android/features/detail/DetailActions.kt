package com.lukasbaxter.slopify.android.features.detail

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import com.lukasbaxter.slopify.android.app.AppModel
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.TrackMenu
import com.lukasbaxter.slopify.android.design.components.TrackMenuBuilder
import com.lukasbaxter.slopify.android.design.components.rememberTrackMenuBuilder
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialog
import com.lukasbaxter.slopify.android.player.ShuffleMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * What the album and artist pages share (ios DetailActions.swift): the open sheet / dialog, the
 * page error banner, and the actions behind page menus. Track rows use the shared [TrackMenuBuilder].
 */
class DetailActions internal constructor(
    val app: AppModel,
    private val scope: CoroutineScope,
    private val builder: TrackMenuBuilder,
    private val dialog: MutableState<NameDialog?>,
) {
    var menu by mutableStateOf<MenuSheet?>(null)
    var nameDialog: NameDialog?
        get() = dialog.value
        set(v) { dialog.value = v }
    /** The page's error banner (`.banner.error`), tap to dismiss. */
    var error by mutableStateOf<String?>(null)

    private val playlists: List<Playlist> get() = app.library.playlists

    val offline: Boolean get() = app.connectivity.offline.value

    /** The shared track menu; `remove` only on a user playlist's own page. */
    fun openTrackMenu(t: Track) {
        menu = builder.sheet(t)
    }

    /** Go to radio: the seed's radio playlist page (API.md §14.4). */
    fun radio(seedId: String, name: String?) {
        app.nav.open(Route.Radio(seedId, name))
    }

    /** "New playlist" from a page menu, seeded with the first song (shared prompt). */
    private fun newPlaylist(seed: Track?) {
        nameDialog = builder.newPlaylistDialog(seed)
    }

    /** A page menu's "Add to playlist": one request with every song (the store asks about songs already there and toasts the outcome). */
    private fun addTo(p: Playlist, tracks: List<Track>) {
        if (tracks.isEmpty()) return
        scope.launch { app.library.add(tracks, p) }
    }

    /** "Add to playlist" submenu of a page menu: New playlist (seeded with the first song) + the others. */
    fun playlistSub(tracks: List<Track>, excluding: String? = null): List<MenuItem> =
        listOf(MenuItem(L("New playlist"), Icon.Plus) { newPlaylist(tracks.firstOrNull()) }) +
            playlists.filter { it.id != excluding }.map { p -> MenuItem(p.name) { addTo(p, tracks) } }

    fun share(kind: TrackMenu.ShareKind, id: String, title: String, by: String?) = builder.share(kind, id, title, by)

    /** Tell other devices the library changed (album save), as the web does over the session. */
    fun announceLibraryChange() {
        app.libraryChangedHere()
    }

    // Playback with the offline rules (ios OfflineStore.play / playPage).
    // TODO(lead): ask the offline store once it is ported; until then the player's downloaded-file lookup.

    fun has(trackId: String): Boolean = app.player.localFile?.invoke(trackId) != null

    /** A row tap (the current row toggles play / pause). */
    fun playRow(tracks: List<Track>, index: Int, context: String) {
        val p = DetailLogic.playable(tracks, index, offline, ::has)
        if (p == null) {
            ToastCenter.shared.show(L("Offline: only downloaded songs play"))
            return
        }
        app.player.play(p.first, p.second, context)
    }

    /** The page's play button: toggles when this page is the playing context. */
    fun playPage(tracks: List<Track>, context: String) {
        val st = app.player.state.value
        if (st.context == context && st.current != null) { app.player.togglePlay(); return }
        val list = DetailLogic.playablePage(tracks, offline, ::has)
        if (list == null) {
            if (offline && tracks.isNotEmpty()) ToastCenter.shared.show(L("Offline: only downloaded songs play"))
            return
        }
        app.player.play(list, 0, context)
    }

    fun toggleShuffle() {
        val p = app.player
        p.setShuffle(if (p.state.value.shuffle == ShuffleMode.Off) ShuffleMode.On else ShuffleMode.Off)
    }

    /** Page menu items, reduced offline. */
    fun pageItems(items: List<MenuItem>): List<MenuItem> = if (offline) MenuItem.offlineSubset(items) else MenuItem.tidy(items)

    fun launch(block: suspend CoroutineScope.() -> Unit) = scope.launch(block = block)

    companion object {
        fun message(e: Throwable): String = e.message ?: e.toString()
    }
}

/** One [DetailActions] per page. */
@Composable
fun rememberDetailActions(): DetailActions {
    val app = LocalAppModel.current
    val scope = rememberCoroutineScope()
    val dialog = remember { mutableStateOf<NameDialog?>(null) }
    val builder = rememberTrackMenuBuilder { dialog.value = it }
    val actions = remember(app, scope, builder) { DetailActions(app, scope, builder, dialog) }
    return actions
}
