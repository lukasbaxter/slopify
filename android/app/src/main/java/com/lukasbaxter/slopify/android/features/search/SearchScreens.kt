package com.lukasbaxter.slopify.android.features.search

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.AppModel
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.app.SeeAllKind
import com.lukasbaxter.slopify.android.app.Tab
import com.lukasbaxter.slopify.android.core.api.track
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.storage.SharedPrefsStore
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.Chip
import com.lukasbaxter.slopify.android.design.components.ChipRow
import com.lukasbaxter.slopify.android.design.components.ErrorBanner
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.RequestPill
import com.lukasbaxter.slopify.android.design.components.SectionHeader
import com.lukasbaxter.slopify.android.design.components.SectionStyle
import com.lukasbaxter.slopify.android.design.components.TrackRow
import com.lukasbaxter.slopify.android.design.components.pageBanner
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.components.rememberTrackMenuBuilder
import com.lukasbaxter.slopify.android.design.components.shellContentPadding
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.image.Avatar
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.image.LikedCover
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialog
import com.lukasbaxter.slopify.android.design.sheets.NameDialogHost
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

/**
 * What outlives the Search root while a page is pushed over it (the shell drops the root from
 * composition): the model, the browse copy and the list position. One per AppModel.
 * TODO(lead): an app-owned scope / per-tab state holder; until then this keeps its own Main scope.
 */
internal class SearchSession(app: AppModel, val browse: SearchBrowseData) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val model = SearchModel(scope, SearchBackend.live(app.account.api, app.connectivity))
    var listIndex = 0
    var listOffset = 0
    var scrollSeen: Int? = null
    /** The account the query belongs to: another sign-in starts from a clean page. */
    var userId: String? = null

    companion object {
        private var current: Pair<AppModel, SearchSession>? = null

        fun of(app: AppModel, context: android.content.Context): SearchSession {
            current?.let { if (it.first === app) return it.second }
            // TODO(lead): expose AppModel's KeyValueStore; this is the same "slopify" prefs file.
            val s = SearchSession(app, SearchBrowseData(SharedPrefsStore(context.applicationContext)))
            current = app to s
            return s
        }

        /** The live browse copy, if the Search tab has been opened (genre page colour). */
        fun browseIfOpen(app: AppModel): SearchBrowseData? = current?.takeIf { it.first === app }?.second?.browse
    }
}

/**
 * The Search tab root (UI.md 6.2): header row, sticky white field with Cancel and the type
 * chips, then Browse tiles, Recent searches, the flat result list or the Everywhere list.
 */
@Composable
fun SearchView() {
    val app = LocalAppModel.current
    val context = LocalContext.current
    val session = remember(app) { SearchSession.of(app, context) }
    val model = session.model
    val s by model.state.collectAsStateWithLifecycle()
    val navState by app.nav.state.collectAsStateWithLifecycle()
    val user by app.account.user.collectAsStateWithLifecycle()
    val saved by app.account.saved.collectAsStateWithLifecycle()
    val prefs by app.account.prefs.collectAsStateWithLifecycle()
    val browse by session.browse.saved.collectAsStateWithLifecycle()
    val player by app.player.state.collectAsStateWithLifecycle()
    val theme = LocalTheme.current
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val list = remember(session) { LazyListState(session.listIndex, session.listOffset) }
    var menu by remember { mutableStateOf<MenuSheet?>(null) }
    var dialog by remember { mutableStateOf<NameDialog?>(null) }
    val builder = rememberTrackMenuBuilder { dialog = it }
    val uiScope = rememberCoroutineScope()

    DisposableEffect(session, list) {
        onDispose { session.listIndex = list.firstVisibleItemIndex; session.listOffset = list.firstVisibleItemScrollOffset }
    }
    LaunchedEffect(user?.id) {
        val id = user?.id
        if (id != null && session.userId != null && session.userId != id) { model.cancel(); model.setType(SearchType.All) }
        if (id != null) session.userId = id
    }
    val browseKey = SearchBrowseData.storageKey(saved?.main, user?.id)
    LaunchedEffect(browseKey) {
        session.browse.use(browseKey)
        if (browseKey != null) session.browse.refresh(app.account.api)
    }
    LaunchedEffect(navState.tab) {
        if (navState.tab != Tab.Search) { model.leftTab(); focusManager.clearFocus() }
    }
    val scrollTick = navState.scrollToTop[Tab.Search] ?: 0
    LaunchedEffect(scrollTick) {
        if (session.scrollSeen != null && session.scrollSeen != scrollTick) list.animateScrollToItem(0)
        session.scrollSeen = scrollTick
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val lifeState by lifecycle.currentStateFlow.collectAsStateWithLifecycle()
    LaunchedEffect(lifeState) { model.hidden = !lifeState.isAtLeast(Lifecycle.State.RESUMED) }

    // Scrolling dismisses the keyboard (blur keeps focus mode).
    val dismissOnScroll = remember(keyboard) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y != 0f) { keyboard?.hide(); focusManager.clearFocus() }
                return Offset.Zero
            }
        }
    }

    val recents = SearchRecent.list(prefs["recentSearches"])
    fun saveRecents(next: List<SearchRecent>) {
        val patch: Map<String, JsonElement> = mapOf("recentSearches" to SearchRecent.json(next))
        session.scope.launch { app.account.patchPrefs(patch) }
    }
    fun rememberHit(item: SearchItem) = saveRecents(SearchRecent.adding(SearchRecent.from(s.query, item), recents))
    fun open(item: SearchItem) {
        rememberHit(item)
        when (item) {
            is SearchItem.Song -> if (item.track.albumId.isNotEmpty()) app.nav.push(Route.Album(item.track.albumId))
            is SearchItem.ArtistHit -> app.nav.push(Route.Artist(item.artist.id))
            is SearchItem.AlbumHit -> app.nav.push(Route.Album(item.album.id))
            is SearchItem.PlaylistHit -> app.nav.push(Route.Playlist(item.playlist.id))
        }
    }
    // The playing song toggles; any other opens its album (DECISIONS 4).
    fun tapSong(t: Track) { if (player.current?.id == t.id) app.player.togglePlay() else open(SearchItem.Song(t)) }
    fun openRecent(x: SearchRecent) {
        when (x.kind) {
            SearchKind.Song -> {
                val art = x.art
                if (art != null && art != x.id) app.nav.push(Route.Album(art))
                else uiScope.launch {
                    try {
                        val t = app.account.api.track(x.id)
                        if (t.albumId.isNotEmpty()) app.nav.push(Route.Album(t.albumId))
                    } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        ToastCenter.shared.show(SearchModel.message(e))
                    }
                }
            }
            SearchKind.Artist -> app.nav.push(Route.Artist(x.id))
            SearchKind.Playlist -> app.nav.push(Route.Playlist(x.id))
            SearchKind.Album -> app.nav.push(Route.Album(x.id))
        }
        saveRecents(SearchRecent.adding(x, recents))
    }
    fun openOrRequest(a: Release) {
        val owned = a.inLibrary
        if (owned != null) app.nav.push(Route.Album(owned)) else if (model.stateOf(a) == null) model.requestLater(a)
    }

    Column(Modifier.fillMaxSize().background(theme.bgBase)) {
        if (!s.focusMode) SearchHeader(user?.id, user?.name) { app.nav.setDrawerOpen(true) }
        SearchBar(
            s, model,
            onCancel = { model.cancel(); keyboard?.hide(); focusManager.clearFocus() },
        )
        LazyColumn(
            Modifier.fillMaxSize().nestedScroll(dismissOnScroll),
            state = list,
            contentPadding = shellContentPadding(),
        ) {
            item(key = "search-top") { Box(Modifier.height(4.dp)) }
            s.error?.let { err -> item(key = "search-error") { ErrorBanner(err, Modifier.pageBanner()) { model.clearError() } } }
            val empty = s.trimmed.isEmpty()
            if (empty && s.focusMode && recents.isNotEmpty()) {
                recentSection(recents, onOpen = ::openRecent, onRemove = { saveRecents(SearchRecent.removing(it, recents)) }, onClear = { saveRecents(emptyList()) })
            }
            if (empty && !s.focusMode) browseSections(browse, app)
            if (s.type == SearchType.Everywhere && !empty) {
                everywhereSection(s, onRow = ::openOrRequest, onRequest = { model.requestLater(it) })
            }
            s.rows?.let { rows ->
                if (rows.isEmpty()) {
                    item(key = "search-none") {
                        SearchEmptyBlock(L("Couldn’t find “{query}”", "query" to s.trimmed), L("Try searching again using a different spelling or keyword."))
                    }
                } else {
                    item(key = "search-rows-top") { Box(Modifier.height(4.dp)) }
                    items(rows, key = { "row:" + it.key }) { item ->
                        when (item) {
                            is SearchItem.Song -> {
                                val t = item.track
                                TrackRow(
                                    t, showArt = true, isCurrent = player.current?.id == t.id,
                                    // TODO(lead): offline store `has` / `unavailable` once ported (iOS app.offline).
                                    isDownloaded = app.player.localFile?.invoke(t.id) != null,
                                    subtitle = SearchItem.songSubtitle(t),
                                    onMore = { menu = builder.sheet(t) },
                                    onArt = { open(item) },
                                    onTouchDown = { app.player.prewarm(t) },
                                ) { tapSong(t) }
                            }
                            else -> SearchRow(
                                searchSource(item), item.name, item.subtitle, Modifier.padding(horizontal = Spacing.gutter),
                                round = item.kind == SearchKind.Artist,
                            ) { open(item) }
                        }
                    }
                }
            }
            item(key = "search-bottom") { Box(Modifier.height(24.dp)) }
        }
    }
    ContextMenuSheet(menu) { menu = null }
    NameDialogHost(dialog) { dialog = null }
}

/** Not focused: avatar + "Search" (UI.md 6.2.2). Focused: folded away. */
@Composable
private fun SearchHeader(userId: String?, name: String?, onAvatar: () -> Unit) {
    val theme = LocalTheme.current
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    Row(
        Modifier.fillMaxWidth().padding(top = top).height(Shell.header).padding(horizontal = Spacing.gutter),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.pressable(PressFeedback.Fade, onTap = onAvatar)) { Avatar(userId, name, size = 32.dp) }
        Text(L("Search"), style = TextStyles.pageTitle, color = theme.fg, maxLines = 1)
    }
}

/** `.contentbar` (UI.md 6.2.3): field (+ Cancel in focus mode), then the type chips. */
@Composable
private fun SearchBar(s: SearchState, model: SearchModel, onCancel: () -> Unit) {
    val theme = LocalTheme.current
    val shift = with(LocalDensity.current) { 8.dp.roundToPx() }
    val top = if (s.focusMode) 8.dp + WindowInsets.statusBars.asPaddingValues().calculateTopPadding() else 4.dp
    Column(Modifier.fillMaxWidth().background(theme.bgBase).padding(top = top, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter), verticalAlignment = Alignment.CenterVertically) {
            SearchInput(s.query, Modifier.weight(1f), onChange = model::setQuery, onFocus = { model.setFocused(true) })
            AnimatedVisibility(
                s.focusMode,
                enter = fadeIn(tween(200)) + slideInHorizontally(tween(200)) { shift },
                exit = fadeOut(tween(0)),
            ) {
                Box(
                    Modifier.padding(start = 12.dp).height(44.dp).pressable(PressFeedback.Fade, onTap = onCancel).padding(start = 4.dp),
                    contentAlignment = Alignment.Center,
                ) { Text(L("Cancel"), fontSize = 16.sp, color = theme.fg) }
            }
        }
        if (s.showsChips) {
            ChipRow {
                for (ty in SearchType.entries) {
                    val bring = remember { BringIntoViewRequester() }
                    val scope = rememberCoroutineScope()
                    Chip(L(ty.key), Modifier.bringIntoViewRequester(bring), on = s.type == ty) {
                        model.setType(ty)
                        scope.launch { bring.bringIntoView() }
                    }
                }
            }
        }
    }
}

/** The white field (UI.md 6.2.3): 44 high, radius 4, black 16/500, magnifier at 12, placeholder `#121212` .85. */
@Composable
private fun SearchInput(text: String, modifier: Modifier, onChange: (String) -> Unit, onFocus: () -> Unit) {
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium, color = Theme.Fixed.searchFieldText)
    Box(
        modifier.height(44.dp).background(Theme.Fixed.searchFieldBackground, RoundedCornerShape(Radius.art))
            .pressable(PressFeedback.None) { focus.requestFocus() },
        contentAlignment = Alignment.CenterStart,
    ) {
        IconView(Icon.SearchTab, Modifier.padding(start = 12.dp), size = 24.dp, tint = Theme.Fixed.searchFieldText)
        BasicTextField(
            text, onChange,
            singleLine = true,
            textStyle = style,
            cursorBrush = SolidColor(Theme.Fixed.searchFieldText),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
            modifier = Modifier.fillMaxWidth().padding(start = 48.dp, end = 16.dp).focusRequester(focus)
                .onFocusChanged { if (it.isFocused) onFocus() },
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (text.isEmpty()) Text(L("What do you want to listen to?"), style = style.copy(color = Theme.Fixed.searchFieldPlaceholder), maxLines = 1)
                    inner()
                }
            },
        )
    }
}

// browse

private fun LazyListScope.browseSections(b: SearchBrowseData.Saved, app: AppModel) {
    item(key = "browse-start-head") { SectionHeader(L("Start browsing"), style = SectionStyle.Search, first = true) }
    item(key = "browse-start") {
        SearchTileGrid(
            listOf<@Composable (Modifier) -> Unit>(
                { m ->
                    SearchBrowseTile(L("Made For You"), Theme.Fixed.madeForYouTile, m, onClick = { app.nav.select(Tab.Home) }) {
                        b.madeForYouCover?.let { SearchTileCover(CoverSource.ArtistArt(it, null)) }
                    }
                },
                { m ->
                    SearchBrowseTile(L("New Releases"), Theme.Fixed.newReleasesTile, m, onClick = { app.nav.push(Route.SeeAll(SeeAllKind.Albums)) }) {
                        b.newReleasesCover?.let { SearchTileCover(CoverSource.AlbumArt(it, null)) }
                    }
                },
                { m ->
                    SearchBrowseTile(L("Charts"), Theme.Fixed.radarHero, m, onClick = { app.nav.push(Route.Charts) }) {
                        b.chartsCover?.let { SearchTileCover(CoverSource.AlbumArt(it, null)) }
                    }
                },
                { m ->
                    SearchBrowseTile(L("Liked Songs"), Theme.Fixed.likedHero, m, onClick = { app.nav.push(Route.LikedSongs) }) {
                        LikedCover(Modifier.fillMaxSize(), heart = 0.5f)
                    }
                },
            ),
        )
    }
    item(key = "browse-all-head") { SectionHeader(L("Browse all"), style = SectionStyle.Search) }
    val tiles = b.tiles ?: return
    tiles.chunked(2).forEachIndexed { row, pair ->
        item(key = "browse-all-$row") {
            SearchTileGrid(
                pair.mapIndexed { j, t ->
                    @Composable { m: Modifier ->
                        SearchBrowseTile(t.name, SearchLogic.tileColor(row * 2 + j), m, onClick = { app.nav.push(Route.Genre(t.name)) }) {
                            t.coverId?.let { SearchTileCover(CoverSource.AlbumArt(it, t.cover)) }
                        }
                    }
                },
                Modifier.padding(top = if (row == 0) 0.dp else 12.dp),
            )
        }
    }
}

/** 2 columns, gap 12 both ways, inside the 16 gutter. */
@Composable
private fun SearchTileGrid(cells: List<@Composable (Modifier) -> Unit>, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(horizontal = Spacing.gutter), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (row in cells.chunked(2)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (c in row) c(Modifier.weight(1f))
                if (row.size == 1) Box(Modifier.weight(1f))
            }
        }
    }
}

// recent searches

private fun LazyListScope.recentSection(
    recents: List<SearchRecent>,
    onOpen: (SearchRecent) -> Unit,
    onRemove: (SearchRecent) -> Unit,
    onClear: () -> Unit,
) {
    item(key = "recent-head") { SectionHeader(L("Recent searches"), style = SectionStyle.Search, first = true) }
    items(recents, key = { "recent:" + it.key }) { x ->
        SearchRow(
            searchSource(x), x.name, x.subtitle, Modifier.padding(horizontal = Spacing.gutter),
            round = x.kind == SearchKind.Artist, onRemove = { onRemove(x) },
        ) { onOpen(x) }
    }
    item(key = "recent-clear") {
        val theme = LocalTheme.current
        Box(Modifier.fillMaxWidth().padding(top = 16.dp), contentAlignment = Alignment.Center) {
            Box(
                Modifier.pressable(PressFeedback.Fade, onTap = onClear)
                    .defaultMinSize(minHeight = 32.dp)
                    .border(1.dp, theme.fgFaint, CircleShape)
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) { Text(L("Clear recent searches"), fontSize = 14.sp, fontWeight = FontWeight.Bold, color = theme.fg) }
        }
    }
}

/** `imageUrl(art || id)`: the album for songs, the item itself otherwise. */
internal fun searchSource(x: SearchRecent): CoverSource {
    val id = x.art ?: x.id
    return when (x.kind) {
        SearchKind.Artist -> CoverSource.ArtistArt(id, null)
        SearchKind.Playlist -> CoverSource.PlaylistArt(id, null)
        SearchKind.Album, SearchKind.Song -> CoverSource.AlbumArt(id, null)
    }
}

internal fun searchSource(item: SearchItem): CoverSource = when (item) {
    is SearchItem.Song -> CoverSource.of(item.track)
    is SearchItem.ArtistHit -> CoverSource.of(item.artist)
    is SearchItem.AlbumHit -> CoverSource.of(item.album)
    is SearchItem.PlaylistHit -> CoverSource.of(item.playlist)
}

@Composable
private fun SearchEmptyBlock(title: String, hint: String) {
    val theme = LocalTheme.current
    Column(
        Modifier.fillMaxWidth().padding(top = 96.dp, start = 24.dp, end = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = theme.fg, textAlign = TextAlign.Center)
        Text(hint, fontSize = 13.sp, color = theme.fgSub, textAlign = TextAlign.Center)
    }
}

// everywhere

private fun LazyListScope.everywhereSection(s: SearchState, onRow: (Release) -> Unit, onRequest: (Release) -> Unit) {
    when (val e = s.everywhere) {
        null, SearchEverywhere.Waiting -> item(key = "ew-note") { SearchNote(L("Searching everywhere…")) }
        SearchEverywhere.Failed -> item(key = "ew-note") { SearchNote(L("Couldn’t search everywhere right now.")) }
        is SearchEverywhere.Loaded -> {
            val albums = e.results.albums
            if (albums.isEmpty()) {
                item(key = "ew-none") {
                    SearchEmptyBlock(L("Couldn’t find “{query}” anywhere", "query" to s.trimmed), L("Try a different spelling, or the artist and album together."))
                }
            } else {
                item(key = "ew-head") {
                    val theme = LocalTheme.current
                    Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp).padding(horizontal = Spacing.gutter)) {
                        Text(L("Everywhere"), style = TextStyles.sectionSearch, color = theme.fg, modifier = Modifier.alignByBaseline())
                        Box(Modifier.weight(1f).size(8.dp))
                        Text(
                            L("{have} of {total} in your library", "have" to albums.count { it.inLibrary != null }, "total" to albums.size),
                            fontSize = 13.sp, color = theme.fgSub, modifier = Modifier.alignByBaseline(),
                        )
                    }
                }
                items(albums.size, key = { "ew:$it" }) { i ->
                    val a = albums[i]
                    SearchReleaseRow(a, s.stateOf(a), onTap = { onRow(a) }, onRequest = { onRequest(a) })
                }
            }
        }
    }
}

@Composable
private fun SearchNote(text: String) {
    val theme = LocalTheme.current
    Text(text, fontSize = 13.sp, color = theme.fgSub, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp))
}

@Composable
private fun SearchReleaseRow(a: Release, state: String?, onTap: () -> Unit, onRequest: () -> Unit) {
    val sub = listOf(a.rtype?.let { L(it) } ?: "", a.year ?: "", a.artist ?: "").filter { it.isNotEmpty() }.joinToString(" • ")
    val src = a.inLibrary?.let { CoverSource.AlbumArt(it, null) } ?: CoverSource.Url(a.image)
    SearchRow(
        src, a.title, sub, Modifier.padding(horizontal = Spacing.gutter), missing = a.inLibrary == null,
        // In-library rows: the web's play button renders invisible on phone, so it is left out.
        action = if (a.inLibrary == null) {
            {
                val ui = SearchRequestState.ui(state)
                RequestPill(ui.label, Modifier.padding(start = 4.dp), busy = ui.busy, onClick = onRequest)
            }
        } else null,
        onTap = onTap,
    )
}
