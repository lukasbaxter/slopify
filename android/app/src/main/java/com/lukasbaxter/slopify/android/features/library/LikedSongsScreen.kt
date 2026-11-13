package com.lukasbaxter.slopify.android.features.library

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.components.ActionRow
import com.lukasbaxter.slopify.android.design.components.BigPlayButton
import com.lukasbaxter.slopify.android.design.components.DetailBarStyle
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.HeroHeader
import com.lukasbaxter.slopify.android.design.components.HeroOwner
import com.lukasbaxter.slopify.android.design.components.IconButton
import com.lukasbaxter.slopify.android.design.components.LocalDetailTopInset
import com.lukasbaxter.slopify.android.design.components.PlaceholderNote
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.SkeletonRows
import com.lukasbaxter.slopify.android.design.components.TrackRow
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.components.rememberTrackMenuBuilder
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyph
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyphMode
import com.lukasbaxter.slopify.android.design.image.Avatar
import com.lukasbaxter.slopify.android.design.image.LikedCover
import com.lukasbaxter.slopify.android.design.sheets.ConfirmDialog
import com.lukasbaxter.slopify.android.design.sheets.ConfirmDialogHost
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuHeader
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialog
import com.lukasbaxter.slopify.android.design.sheets.NameDialogHost
import com.lukasbaxter.slopify.android.design.theme.HeroIsland
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.player.PlayerState
import com.lukasbaxter.slopify.android.player.ShuffleMode
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val LIKED_CONTEXT = "liked"

/**
 * Liked Songs (UI.md 6.3.5; ios LikedSongsView.swift): a pinned find bar (with the back
 * chevron) over the page, the 180 Liked tile hero, ⋯ | shuffle, play, then the liked songs newest
 * first (or sorted). Rows follow the likes store live; songs liked elsewhere are fetched in.
 */
@Composable
internal fun LikedSongsScreen() {
    val ctx = rememberLibraryContext()
    val app = ctx.app
    val store = ctx.store
    val st by store.state.collectAsStateWithLifecycle()
    val likes by app.likes.state.collectAsStateWithLifecycle()
    val user by app.account.user.collectAsStateWithLifecycle()
    val offline by app.connectivity.offline.collectAsStateWithLifecycle()
    val player by app.player.state.collectAsStateWithLifecycle()

    var find by remember { mutableStateOf("") }
    var debounced by remember { mutableStateOf("") }
    var sort by remember { mutableStateOf(LibraryText.LikedSort.Recent) }
    var menu by remember { mutableStateOf<MenuSheet?>(null) }
    var nameDialog by remember { mutableStateOf<NameDialog?>(null) }
    var confirm by remember { mutableStateOf<ConfirmDialog?>(null) }
    var loading by remember { mutableStateOf(true) }
    val menus = rememberTrackMenuBuilder { nameDialog = it }

    // Liked-at times: the store's fetch until the likes store reports, then the likes store.
    val likedAt = if (likes.loaded || likes.tracks.isNotEmpty()) likes.tracks else st.likedAt
    val rows = remember(likedAt, st.likedRows, sort) { LibraryText.likedOrder(likedAt, st.likedRows, sort) }
    val shown = if (debounced.isBlank()) rows else rows.filter { LibraryText.matches(it, debounced) }
    val hero = ColorMath.detailHero(isLiked = true)
    val topInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    // `10 + inset` + 36 field + 8, then the hero's own 16.
    val findBarHeight = 10.dp + topInset + 36.dp + 8.dp

    LaunchedEffect(Unit) {
        store.loadLiked()
        loading = false
    }
    LaunchedEffect(likedAt.keys, st.likedRows.keys) {
        val missing = likedAt.keys.filter { it !in st.likedRows }
        if (missing.isNotEmpty() && !loading) store.fillLiked(missing)
    }
    LaunchedEffect(find) {
        delay(80)
        debounced = find
    }

    fun heroMenu(tracks: List<Track>): MenuSheet {
        val items = mutableListOf(MenuItem(L("Add to queue"), Icon.Queue, offline = true) { app.player.addToQueue(tracks) })
        if (tracks.isNotEmpty()) {
            val sub = mutableListOf(MenuItem(L("New playlist"), Icon.Plus) { nameDialog = menus.newPlaylistDialog(tracks.first()) })
            sub += store.state.value.playlists.map { p -> MenuItem(p.name) { ctx.scope.launch { store.add(tracks, p) } } }
            items += MenuItem(L("Add to playlist"), Icon.Plus, sub = sub)
        }
        // TODO(lead): offline store: "Download" / "Remove download" rows (OfflineCollectionActions).
        val header = MenuHeader(MenuHeader.Art.Liked, L("Liked Songs"), L("Playlist"))
        return MenuSheet(header, if (ctx.offline) MenuItem.offlineSubset(items) else items)
    }

    fun sortMenu(): MenuSheet = MenuSheet(
        MenuHeader(MenuHeader.Art.Glyph(Icon.Playlist), L("Sort by"), sort.label),
        LibraryText.LikedSort.entries.map { s -> MenuItem(s.label, if (s == sort) Icon.Check else null) { sort = s } },
    )

    Box {
        DetailScaffold(L("Liked Songs"), heroColor = hero, barStyle = DetailBarStyle.Hidden) {
            item(key = "liked-bar-space") { Spacer(Modifier.fillMaxWidth().height(findBarHeight).background(hero.color)) }
            item(key = "liked-hero") {
                CompositionLocalProvider(LocalDetailTopInset provides 16.dp - Shell.topBar) {
                    HeroHeader(hero, L("Liked Songs"), coverSize = 180.dp, cover = { LikedCover() }) {
                        HeroOwner(user?.name ?: L("You"), onClick = { app.nav.push(Route.Profile) }) { Avatar(user?.id, user?.name, size = 20.dp, drawer = true) }
                        Text(LibraryText.likedStats(likedAt.size))
                    }
                }
            }
            item(key = "liked-actions") {
                ActionRow(hero, leading = {
                    IconButton(Icon.Dots24, L("More options")) { menu = heroMenu(rows) }
                }) {
                    LibraryPageButtons(ctx, player, LIKED_CONTEXT) { ctx.playPage(shown, LIKED_CONTEXT) }
                }
            }
            when {
                rows.isEmpty() && loading && !st.likedLoaded -> item(key = "liked-skeleton") { SkeletonRows(count = 8, art = true) }
                rows.isEmpty() -> item(key = "liked-empty") { PlaceholderNote(L("Songs you like will appear here. Save songs by tapping the heart icon.")) }
                shown.isEmpty() -> item(key = "liked-nomatch") { PlaceholderNote(L("No matches for “{query}” in here.", "query" to debounced.trim())) }
                else -> itemsIndexed(shown, key = { _, t -> "liked-" + t.id }) { i, t ->
                    val held = app.player.localFile?.invoke(t.id) != null
                    Box(Modifier.height(Shell.trackRow)) {
                        TrackRow(
                            t, showArt = true,
                            isCurrent = player.current?.id == t.id, isPlaying = player.isPlaying,
                            isDownloaded = held, isUnavailable = offline && !held,
                            onMore = { menu = menus.sheet(t) },
                            onArt = { if (t.albumId.isNotEmpty()) app.nav.push(Route.Album(t.albumId)) },
                            onTouchDown = { app.player.prewarm(t) },
                        ) { ctx.play(shown, i, LIKED_CONTEXT) }
                    }
                }
            }
        }
        LikedFindBar(find, { find = it }, hero.color, topInset, onSort = { menu = sortMenu() }) { app.nav.pop() }
    }

    ContextMenuSheet(menu) { menu = null }
    NameDialogHost(nameDialog) { nameDialog = null }
    ConfirmDialogHost(confirm) { confirm = null }
}

/** The pinned find bar: back chevron, "Find in Liked Songs" field, Sort pill, on the hero colour. */
@Composable
private fun LikedFindBar(
    find: String,
    onFind: (String) -> Unit,
    color: androidx.compose.ui.graphics.Color,
    topInset: androidx.compose.ui.unit.Dp,
    onSort: () -> Unit,
    onBack: () -> Unit,
) = HeroIsland {
    val theme = LocalTheme.current
    Row(
        Modifier.fillMaxWidth().background(color).padding(top = 10.dp + topInset, bottom = 8.dp, end = Spacing.gutter),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val back = L("Go back")
        Box(
            Modifier.padding(start = Spacing.gutter - 8.dp).size(48.dp).pressable(PressFeedback.Fade, onTap = onBack).semantics { contentDescription = back },
            contentAlignment = Alignment.Center,
        ) { IconView(Icon.BackChevron, size = 18.dp, tint = theme.fg) }
        Row(
            Modifier.weight(1f).height(36.dp).background(theme.fg(0.14), RoundedCornerShape(Radius.art)).padding(horizontal = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconView(Icon.Magnifier, size = 16.dp, tint = theme.fg)
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                if (find.isEmpty()) Text(L("Find in Liked Songs"), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fg(0.75), maxLines = 1)
                BasicTextField(
                    find, onFind,
                    singleLine = true,
                    textStyle = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fg),
                    cursorBrush = SolidColor(theme.fg),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (find.isNotEmpty()) {
                val clear = L("Clear")
                Box(Modifier.pressable(PressFeedback.Fade) { onFind("") }.semantics { contentDescription = clear }) {
                    IconView(Icon.Close, size = 20.dp, tint = theme.fg)
                }
            }
        }
        Spacer(Modifier.size(8.dp))
        Box(
            Modifier.pressable(PressFeedback.Fade, onTap = onSort).height(36.dp).background(theme.fg(0.14), CircleShape).padding(horizontal = 16.dp),
            contentAlignment = Alignment.Center,
        ) { Text(L("Sort"), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = theme.fg) }
    }
}

/** Shuffle toggle and the big play button of a list page's action row. */
@Composable
internal fun RowScope.LibraryPageButtons(ctx: LibraryContext, player: PlayerState, context: String, onPlay: () -> Unit) {
    val mode = when (player.shuffle) {
        ShuffleMode.Smart -> ShuffleGlyphMode.Smart
        ShuffleMode.On -> ShuffleGlyphMode.On
        ShuffleMode.Off -> ShuffleGlyphMode.Off
    }
    IconButton(
        if (player.shuffle == ShuffleMode.Off) L("Enable shuffle") else L("Disable shuffle"),
        on = player.shuffle != ShuffleMode.Off, onClick = { ctx.toggleShuffle() },
    ) { tint -> ShuffleGlyph(mode, size = 24.dp, tint = tint) }
    BigPlayButton(player.context == context && player.isPlaying, Modifier.padding(start = 4.dp), onClick = onPlay)
}
