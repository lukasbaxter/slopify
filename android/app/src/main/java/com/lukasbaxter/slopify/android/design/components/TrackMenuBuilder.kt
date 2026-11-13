package com.lukasbaxter.slopify.android.design.components

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.lukasbaxter.slopify.android.app.AppModel
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.model.ItemKind
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.sheets.MenuHeader
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/**
 * Wires [TrackMenu] to the app (App.jsx onLike, onExclude, onAddTo, onNewPlaylistWithTrack,
 * startMix, syncLyrics, shareItem; ios TrackMenuBuilder.swift).
 *
 *     val builder = rememberTrackMenuBuilder { dialog = it }
 *     var menu by remember { mutableStateOf<MenuSheet?>(null) }
 *     TrackRow(t, onMore = { menu = builder.sheet(t) })
 *     ContextMenuSheet(menu) { menu = null }
 *     NameDialogHost(dialog) { dialog = null }
 */
class TrackMenuBuilder(
    private val app: AppModel,
    private val context: Context,
    private val scope: CoroutineScope,
    /** Presents the "New playlist" name prompt. */
    private val askName: (NameDialog) -> Unit,
) {
    private val library get() = app.library

    /**
     * - `remove`: "Remove from this playlist" (a user playlist's own page).
     * - `downloaded`: kept for offline, so "Add to queue" stays in the offline menu (the player's
     *   downloaded-file lookup is asked too, so lists need not pass it).
     * - `header` / `style` / `trailing`: the now playing ⋯ sheet.
     */
    fun sheet(
        t: Track,
        remove: ((Track) -> Unit)? = null,
        downloaded: Boolean = false,
        style: TrackMenu.Style = TrackMenu.Style.Row,
        header: MenuHeader? = null,
        trailing: List<MenuItem> = emptyList(),
    ): MenuSheet {
        if (library.playlists.isEmpty()) scope.launch { library.refreshPlaylists() }
        val state = TrackMenu.State(
            track = t,
            liked = app.likes.isLiked(t.id),
            excluded = TrackMenu.isExcluded(t.id, app.account.prefs.value),
            downloaded = downloaded || app.player.localFile?.invoke(t.id) != null,
            syncing = app.lyricJobs.isSyncing(t.id),
            offline = app.connectivity.offline.value,
            playlists = library.playlists,
            style = style,
            trailing = trailing,
        )
        return MenuSheet(header ?: TrackMenu.header(t), TrackMenu.items(state, actions(remove)))
    }

    fun actions(remove: ((Track) -> Unit)? = null): TrackMenu.Actions = TrackMenu.Actions(
        addToQueue = { t -> app.player.addToQueue(listOf(t)) },
        newPlaylist = { t -> askName(newPlaylistDialog(t)) },
        addTo = { p, t -> scope.launch { library.add(listOf(t), p) } },
        remove = remove,
        like = { t, _ -> like(t) },
        exclude = { t, on -> exclude(t, on) },
        radio = { t -> app.nav.open(Route.Radio(t.id, t.title)) },
        openArtist = { id -> app.nav.open(Route.Artist(id)) },
        openAlbum = { id -> app.nav.open(Route.Album(id)) },
        syncLyrics = { t -> scope.launch { app.lyricJobs.sync(t, app.account.api) } },
        share = { t -> share(TrackMenu.ShareKind.Track, t.id, t.title, TrackMenu.shareBy(t)) },
    )

    /** "New playlist" (UI.md 5.4.7): prefilled with the seed's album, creates it with the seed. */
    fun newPlaylistDialog(seed: Track?): NameDialog =
        NameDialog(L("New playlist"), TrackMenu.newPlaylistName(seed), L("Create")) { name ->
            val n = name.trim()
            if (n.isNotEmpty()) scope.launch { library.createPlaylist(n, seed) }
        }

    /** App.jsx:1013-1028: optimistic toggle, toast, a reverted toggle says "Not saved". */
    fun like(t: Track) {
        val was = app.likes.isLiked(t.id)
        scope.launch {
            try {
                app.likes.set(t.id, ItemKind.Track, !was)
                ToastCenter.shared.show(if (was) L("Removed from Liked Songs") else L("Added to Liked Songs"))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ToastCenter.shared.show(L("Not saved: {error}", "error" to (e.message ?: e.toString()).take(60)))
            }
        }
    }

    /** App.jsx:1072-1080: `prefs.dislikes`, then the toast. */
    fun exclude(t: Track, excluded: Boolean) {
        val map = TrackMenu.dislikes(app.account.prefs.value, t.id, excluded, System.currentTimeMillis().toDouble())
        scope.launch {
            app.account.patchPrefs(mapOf("dislikes" to map))
            ToastCenter.shared.show(if (excluded) L("Excluded from your taste profile") else L("Included in your taste profile"))
        }
    }

    /** `shareItem` (TrackRow.jsx:38-57): the system share sheet with `{main}/?{kind}={id}`. */
    fun share(kind: TrackMenu.ShareKind, id: String, title: String, by: String?) = share(context, app.account, kind, id, title, by)

    companion object {
        fun share(context: Context, account: Account, kind: TrackMenu.ShareKind, id: String, title: String, by: String?) {
            val main = account.saved.value?.main
            val url = main?.let { TrackMenu.shareUrl(it, kind, id) }
            if (url == null) {
                ToastCenter.shared.show(L("Could not copy the link"))
                return
            }
            ShareSheet.present(context, url, TrackMenu.shareTitle(title, by))
        }
    }
}

/** A [TrackMenuBuilder] for this screen. */
@Composable
fun rememberTrackMenuBuilder(askName: (NameDialog) -> Unit): TrackMenuBuilder {
    val app = LocalAppModel.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    return remember(app, context, scope) { TrackMenuBuilder(app, context, scope, askName) }
}

