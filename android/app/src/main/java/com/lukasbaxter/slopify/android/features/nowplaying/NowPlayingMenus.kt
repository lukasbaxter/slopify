package com.lukasbaxter.slopify.android.features.nowplaying

import com.lukasbaxter.slopify.android.app.AppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.session.SleepState
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.TrackMenu
import com.lukasbaxter.slopify.android.design.components.TrackMenuBuilder
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.sheets.MenuHeader
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The ⋯ track sheet of now playing (FullScreen.jsx:221-240; UI.md 3.2.7) and the queue row
 * sheet (UI.md 3.3.4). The ⋯ sheet is the shared [TrackMenu] in its now playing style plus the
 * sleep timer. Actions run after the sheet has closed.
 */
internal class NowPlayingMenus(
    private val app: AppModel,
    private val builder: TrackMenuBuilder,
    private val scope: CoroutineScope,
    /** Optimistic sleep state (the server echo replaces it). */
    private val sleep: SleepState? = null,
    private val now: () -> Double = { System.currentTimeMillis().toDouble() },
    private val setSleep: (NowPlayingSleepPick) -> Unit = {},
) {
    fun nowPlaying(t: Track): MenuSheet =
        builder.sheet(t, style = TrackMenu.Style.NowPlaying, header = header(t), trailing = listOf(sleepItem()))

    /** Long-press on a queue row. `removable` is false on the Now playing row. */
    fun queueRow(t: Track, index: Int, removable: Boolean): MenuSheet {
        val library = app.library
        if (library.playlists.isEmpty()) scope.launch { library.refreshPlaylists() }
        val liked = app.likes.isLiked(t.id)
        val items = mutableListOf<MenuItem>()
        if (removable) items += MenuItem(L("Remove from queue")) { app.player.removeFromQueue(index) }
        items += MenuItem(if (liked) L("Remove from Liked Songs") else L("Add to Liked Songs")) { builder.like(t) }
        if (library.playlists.isNotEmpty()) {
            items += MenuItem(L("Add to playlist"), sub = library.playlists.map { p -> MenuItem(p.name) { scope.launch { library.add(listOf(t.id), p) } } })
        }
        items += MenuItem.separator
        t.artistIds.firstOrNull()?.let { id -> items += MenuItem(L("Go to artist")) { app.nav.open(Route.Artist(id)) } }
        if (t.albumId.isNotEmpty()) items += MenuItem(L("Go to album")) { app.nav.open(Route.Album(t.albumId)) }
        return MenuSheet(header(t), MenuItem.tidy(items))
    }

    private fun sleepItem(): MenuItem = nowPlayingSleepItem(sleep, now(), setSleep)

    companion object {
        fun header(t: Track): MenuHeader = MenuHeader(MenuHeader.Art.Cover(NowPlayingCover.source(t)), t.title, t.creditLine)
    }
}

internal sealed interface NowPlayingSleepPick {
    data class Minutes(val minutes: Int) : NowPlayingSleepPick
    data object EndOfTrack : NowPlayingSleepPick
    data object Off : NowPlayingSleepPick
}

/** "Sleep timer ▸": 5-45 minutes, 1 hour, end of track, and Turn off while one is set. */
internal fun nowPlayingSleepItem(sleep: SleepState?, now: Double, setSleep: (NowPlayingSleepPick) -> Unit): MenuItem {
    val label = NowPlayingMath.sleepLabel(sleep?.at, sleep?.endOfTrack == true, now)
    val sub = mutableListOf<MenuItem>()
    for (m in listOf(5, 10, 15, 30, 45)) sub += MenuItem(L("{n} minutes", "n" to m)) { setSleep(NowPlayingSleepPick.Minutes(m)) }
    sub += MenuItem(L("1 hour")) { setSleep(NowPlayingSleepPick.Minutes(60)) }
    sub += MenuItem(L("End of track")) { setSleep(NowPlayingSleepPick.EndOfTrack) }
    if (sleep != null) {
        sub += MenuItem.separator
        sub += MenuItem(L("Turn off timer")) { setSleep(NowPlayingSleepPick.Off) }
    }
    return MenuItem(label, Icon.Moon, sub = sub)
}
