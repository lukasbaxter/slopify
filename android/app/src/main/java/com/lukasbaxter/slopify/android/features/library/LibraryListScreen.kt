package com.lukasbaxter.slopify.android.features.library

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.app.Tab
import com.lukasbaxter.slopify.android.core.api.album
import com.lukasbaxter.slopify.android.core.api.likes
import com.lukasbaxter.slopify.android.core.api.mix
import com.lukasbaxter.slopify.android.core.api.playlist
import com.lukasbaxter.slopify.android.core.api.unlike
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.ItemKind
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.storage.KeyValueStore
import com.lukasbaxter.slopify.android.core.storage.SharedPrefsStore
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.Chip
import com.lukasbaxter.slopify.android.design.components.ChipRow
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.TrackMenu
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.components.shellContentPadding
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.image.Avatar
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.sheets.ConfirmDialog
import com.lukasbaxter.slopify.android.design.sheets.ConfirmDialogHost
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.OverlayCover
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.player.StreamPolicy
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

/** In memory only (UI.md 5.2.4): survives tab switches, not relaunches. */
private object LibraryViewMemory {
    var grid = false
}

/** The drag's shift animation (`cubic-bezier(.2,0,0,1) 180ms`). */
private val dragEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)

/**
 * "Your Library" (UI.md 5.2, Sidebar.jsx on the phone; ios LibraryView.swift): header with find /
 * create, filter chips, the static "Recents" sort row with the grid/list toggle, then the list.
 * Tree mode (no filter, query or offline) shows folders and lets rows be dragged into a new order.
 */
@Composable
internal fun LibraryScreen() {
    val ctx = rememberLibraryContext()
    val app = ctx.app
    val store = ctx.store
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val context = LocalContext.current
    val st by store.state.collectAsStateWithLifecycle()
    val prefs by app.account.prefs.collectAsStateWithLifecycle()
    val user by app.account.user.collectAsStateWithLifecycle()
    val offline by app.connectivity.offline.collectAsStateWithLifecycle()
    val likes by app.likes.state.collectAsStateWithLifecycle()
    val navState by app.nav.state.collectAsStateWithLifecycle()
    val kv = remember(context) { SharedPrefsStore(context) }

    var filter by remember { mutableStateOf<LibraryFilter?>(null) }
    var searching by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var grid by remember { mutableStateOf(LibraryViewMemory.grid) }
    var openFolders by remember { mutableStateOf(LibraryOpenFolders.load(kv)) }
    // While a folder is dragged every folder shows shut.
    var shut by remember { mutableStateOf(false) }
    var settled by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf<MenuSheet?>(null) }
    var naming by remember { mutableStateOf<LibraryNaming?>(null) }
    var confirm by remember { mutableStateOf<ConfirmDialog?>(null) }
    var photoFolder by remember { mutableStateOf<String?>(null) }
    val drag = remember { LibraryDragController() }
    val listState = rememberLazyListState()
    val gridScroll = rememberScrollState()
    val gridFrames = remember { HashMap<String, Rect>() }
    val gridContent = remember { arrayOfNulls<LayoutCoordinates>(1) }
    var listWidthPx by remember { mutableIntStateOf(0) }
    val findFocus = remember { FocusRequester() }

    // TODO(lead): offline store: kept collections (ids, `__liked__`) and per-collection summaries.
    val downloaded = emptySet<String>()
    val pinnedList = LibraryContext.pinnedOf(prefs)
    val pinned = pinnedList.toSet()
    val arrangement = remember(st, pinnedList) { st.arrangement(pinnedList) }
    val flat = LibraryArrangement.isFlat(filter, query, offline)
    val shown = arrangement.shown(filter, query, offline, downloaded, openFolders, shut)
    val likedName = L("Liked Songs")
    val showLiked = LibraryArrangement.showLiked(filter, query, likedName, offline, LibraryRowModel.LIKED_ID in downloaded)
    val likedCountKnown = likes.tracks.isNotEmpty() || !st.loading

    fun rowModel(e: LibraryEntry) = LibraryRowModel(
        e, LibraryText.subtitle(e, arrangement.kids[e.id]?.size ?: 0),
        pinned = e.kind != LibraryEntry.Kind.Folder && e.id in pinned,
        folderOpen = e.kind == LibraryEntry.Kind.Folder && e.id in openFolders && !shut,
    )
    val models = shown.map(::rowModel)
    val likedModel = LibraryRowModel(null, LibraryText.likedSubtitle(if (likedCountKnown) likes.tracks.size else null), pinned = true)
    val empty = LibraryEmptyState.pick(offline, showLiked, shown.size, query, filter, st.loading, settled, likedCountKnown)

    LaunchedEffect(Unit) { store.refresh() }
    LaunchedEffect(Unit) { delay(1500); settled = true }
    LaunchedEffect(offline) { if (offline && filter == LibraryFilter.Artist) filter = null }
    LaunchedEffect(searching) { if (searching) findFocus.requestFocus() }
    // Tapping the lit Library tab scrolls the list to the top (DECISIONS).
    val topTick = navState.scrollToTop[Tab.Library] ?: 0
    var seenTick by remember { mutableIntStateOf(topTick) }
    LaunchedEffect(topTick) {
        if (topTick == seenTick) return@LaunchedEffect
        seenTick = topTick
        if (grid) gridScroll.animateScrollTo(0) else listState.animateScrollToItem(0)
    }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val id = photoFolder
        photoFolder = null
        if (uri != null && id != null) ctx.scope.launch { ctx.jpeg(uri)?.let { store.setFolderCover(id, it) } }
    }

    // Menus (5.2.9)

    fun likedMenu(): MenuSheet {
        suspend fun liked(): List<Track>? = attempt { app.account.api.likes(full = true).items }
        return MenuSheet(items = listOf(
            MenuItem(L("Add to queue")) { ctx.scope.launch { liked()?.let { app.player.addToQueue(it) } } },
            MenuItem(L("Play")) { ctx.scope.launch { liked()?.takeIf { it.isNotEmpty() }?.let { app.player.play(it, 0, "liked") } } },
        ))
    }

    /** The tracks of a library entry (Sidebar.jsx `playEntry`): album songs, artist mix, playlist songs. */
    suspend fun tracksOf(e: LibraryEntry): List<Track> {
        val api = app.account.api
        return when (e.kind) {
            LibraryEntry.Kind.Album -> attempt { api.album(e.id).tracks } ?: emptyList()
            LibraryEntry.Kind.Artist -> StreamPolicy.dropDisliked(attempt { api.mix(e.id, 100, "radio").items } ?: emptyList(), app.account.prefs.value)
            LibraryEntry.Kind.Playlist -> attempt { api.playlist(e.id).tracks } ?: emptyList()
            LibraryEntry.Kind.Folder -> emptyList()
        }
    }

    fun entryMenu(e: LibraryEntry): MenuSheet {
        val isPinned = e.id in ctx.pinned()
        val queue = MenuItem(L("Add to queue")) { ctx.scope.launch { tracksOf(e).takeIf { it.isNotEmpty() }?.let { app.player.addToQueue(it) } } }
        val play = MenuItem(L("Play")) { ctx.scope.launch { tracksOf(e).takeIf { it.isNotEmpty() }?.let { app.player.play(it, 0, e.id) } } }
        val deleteConfirm = { onYes: () -> Unit ->
            confirm = ConfirmDialog(L("Delete \"{name}\"?", "name" to e.name), L("Delete"), destructive = true, onConfirm = onYes)
        }
        return when (e.kind) {
            LibraryEntry.Kind.Folder -> MenuSheet(items = listOf(
                MenuItem(L("Rename"), Icon.Edit) { naming = LibraryNaming(LibraryNaming.Kind.Rename(e.id), e.name) },
                MenuItem(L("Choose photo"), Icon.Photo) {
                    photoFolder = e.id
                    photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                MenuItem(L("Delete"), Icon.Trash, danger = true) {
                    deleteConfirm { store.deleteFolder(e.id, store.state.value.arrangement(ctx.pinned())) }
                },
            ))
            LibraryEntry.Kind.Album -> {
                val items = mutableListOf(queue, play, MenuItem.separator, MenuItem(if (isPinned) L("Unpin album") else L("Pin album")) { ctx.togglePin(e.id) })
                e.album?.artistId?.let { artistId -> items += MenuItem(L("Go to artist")) { app.nav.push(Route.Artist(artistId)) } }
                items += MenuItem(L("Share")) { ctx.share(TrackMenu.ShareKind.Album, e.id, e.name, e.album?.artist) }
                items += MenuItem(L("Remove from Your Library")) {
                    ctx.scope.launch {
                        app.likes.toggle(e.id, ItemKind.Album)
                        store.refreshAlbums()
                        ToastCenter.shared.show(L("Removed from Your Library"))
                    }
                }
                MenuSheet(items = items)
            }
            LibraryEntry.Kind.Artist -> MenuSheet(items = listOf(
                queue, play, MenuItem.separator,
                MenuItem(if (isPinned) L("Unpin artist") else L("Pin artist")) { ctx.togglePin(e.id) },
                MenuItem(L("Share")) { ctx.share(TrackMenu.ShareKind.Artist, e.id, e.name, null) },
                MenuItem(L("Unfollow")) {
                    ctx.scope.launch {
                        if (app.likes.isLiked(e.id)) app.likes.toggle(e.id, ItemKind.Artist) else attempt { app.account.api.unlike(e.id) }
                        store.refreshArtists()
                        store.libraryChanged()
                    }
                },
            ))
            // TODO(lead): "Regenerate" (AI playlists) needs the Generate dialog (UI.md 6.4); left out until it exists.
            LibraryEntry.Kind.Playlist -> MenuSheet(items = listOf(
                queue, play, MenuItem.separator,
                MenuItem(if (isPinned) L("Unpin playlist") else L("Pin playlist")) { ctx.togglePin(e.id) },
                MenuItem(L("Edit details")) {
                    store.pendingEditDetails.value = e.id
                    app.nav.push(Route.Playlist(e.id))
                },
                MenuItem(L("Delete"), Icon.Trash, danger = true) {
                    deleteConfirm { e.playlist?.let { p -> ctx.scope.launch { store.deletePlaylist(p) } } }
                },
            ))
        }
    }

    // Create (5.2.10). TODO(lead): "Generated playlist (AI)" opens the Generate dialog (UI.md 6.4); left out until it exists.
    fun openCreate() {
        menu = MenuSheet(items = listOf(
            MenuItem(L("Playlist"), Icon.Playlist) { naming = LibraryNaming(LibraryNaming.Kind.Playlist) },
            MenuItem(L("Folder"), Icon.Folder) { naming = LibraryNaming(LibraryNaming.Kind.Folder) },
        ))
    }

    fun submitNaming(n: LibraryNaming, name: String) {
        val a = store.state.value.arrangement(ctx.pinned())
        when (val k = n.kind) {
            LibraryNaming.Kind.Playlist -> ctx.scope.launch { store.createPlaylist(name) }
            LibraryNaming.Kind.Folder -> store.createFolder(name, a)
            is LibraryNaming.Kind.Rename -> if (a.byId[k.id]?.name != name) store.renameFolder(k.id, name, a)
        }
    }

    fun open(e: LibraryEntry) {
        when (e.kind) {
            LibraryEntry.Kind.Playlist -> app.nav.push(Route.Playlist(e.id))
            LibraryEntry.Kind.Album -> app.nav.push(Route.Album(e.id))
            LibraryEntry.Kind.Artist -> app.nav.push(Route.Artist(e.id))
            LibraryEntry.Kind.Folder -> {
                openFolders = if (e.id in openFolders) openFolders - e.id else openFolders + e.id
                LibraryOpenFolders.save(openFolders, kv)
            }
        }
    }

    // Drag (tree mode only): the rows, folders shutting for a folder drag, what a drop or hold does.

    fun currentShown(): List<LibraryEntry> =
        store.state.value.arrangement(ctx.pinned()).shown(filter, query, ctx.offline, downloaded, openFolders, shut)

    SideEffect {
        drag.rows = rows@{
            if (LibraryArrangement.isFlat(filter, query, ctx.offline)) return@rows emptyList()
            val list = currentShown()
            if (grid) return@rows list.mapNotNull { e -> gridFrames[e.id]?.let { LibraryDrag.Row(e.id, e.kind == LibraryEntry.Kind.Folder, it) } }
            val row = LibraryLayoutMetrics.listRow.value
            val width = maxOf(0f, with(density) { listWidthPx.toDp().value } - 2 * Spacing.gutter.value)
            val y0 = if (LibraryArrangement.showLiked(filter, query, likedName, ctx.offline, false)) row else 0f
            list.mapIndexed { i, e -> LibraryDrag.Row(e.id, e.kind == LibraryEntry.Kind.Folder, Rect(Spacing.gutter.value, y0 + i * row, Spacing.gutter.value + width, y0 + (i + 1) * row)) }
        }
        drag.canEnter = { id -> store.state.value.arrangement(emptyList()).byId[id]?.kind != LibraryEntry.Kind.Folder }
        drag.willLift = { id ->
            if (store.state.value.arrangement(emptyList()).byId[id]?.kind == LibraryEntry.Kind.Folder && openFolders.isNotEmpty() && !shut) {
                shut = true
                true
            } else false
        }
        drag.coveredBottom = Shell.contentBottom.value - 24
        drag.origin = {
            if (grid) -gridScroll.value / density.density
            else {
                // Every item before the rows is one 80 dp row (Liked Songs), so the first visible one places them all.
                val info = listState.layoutInfo
                val first = info.visibleItemsInfo.firstOrNull()
                val rowPx = with(density) { LibraryLayoutMetrics.listRow.roundToPx() }
                if (first == null) 0f else (first.offset - info.viewportStartOffset - first.index * rowPx) / density.density
            }
        }
        drag.scrollBy = { px -> if (grid) gridScroll.dispatchRawDelta(px) else listState.dispatchRawDelta(px) }
        drag.onFinish = { outcome ->
            // The arrangement as it is now (folders may have shut for the drag).
            val a = store.state.value.arrangement(ctx.pinned())
            val now = a.shown(filter, query, ctx.offline, downloaded, openFolders, shut)
            when (outcome) {
                is LibraryDragController.Outcome.Hold -> {
                    shut = false
                    a.byId[outcome.id]?.let { menu = entryMenu(it) }
                }
                is LibraryDragController.Outcome.Drop -> {
                    val d = a.dropping(a.draft(store.state.value.layout), outcome.id, outcome.to, outcome.into, outcome.rows, now, openFolders, shut)
                    shut = false
                    store.saveArrangement(d)
                }
                null -> shut = false
            }
        }
    }

    Column(Modifier.fillMaxSize().background(theme.bgBase)) {
        // Header (5.1, 5.2.2)
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().heightIn(min = Shell.header).padding(horizontal = Spacing.gutter),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.pressable(PressFeedback.Fade) { app.nav.setDrawerOpen(true) }) { Avatar(user?.id, user?.name, size = 32.dp) }
            Text(L("Your Library"), style = TextStyles.pageTitle, color = theme.fg, maxLines = 1, modifier = Modifier.weight(1f))
            Row(Modifier.offset(x = Spacing.gutter - 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                LibraryHeaderButton(Icon.LibSearch, L("Find in Your Library"), on = searching) { searching = !searching; query = "" }
                LibraryHeaderButton(Icon.LibPlus, L("Create playlist"), on = false) { openCreate() }
            }
        }
        // Chips (5.2.3)
        ChipRow(Modifier.padding(vertical = 8.dp)) {
            if (filter != null) {
                val clear = L("Clear filter")
                Box(
                    Modifier.size(32.dp).pressable(PressFeedback.Fade) { filter = null }.background(theme.chip, CircleShape)
                        .semantics { contentDescription = clear },
                    contentAlignment = Alignment.Center,
                ) { Text("×", fontSize = 18.sp, color = theme.fg) }
            }
            for (f in LibraryFilter.entries) {
                if (offline && f == LibraryFilter.Artist) continue
                if (filter == null || filter == f) Chip(filterLabel(f), on = filter == f, small = true) { filter = if (filter == f) null else f }
            }
        }
        if (searching) {
            // Find row (5.2.5)
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter).padding(top = 4.dp, bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    Modifier.weight(1f).height(36.dp).background(theme.chip, RoundedCornerShape(Radius.art)).padding(start = 10.dp, end = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconView(Icon.LibSearch, size = 20.dp, tint = theme.fgSub)
                    Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                        if (query.isEmpty()) Text(L("Find in Your Library"), fontSize = 16.sp, color = theme.fgSub, maxLines = 1)
                        BasicTextField(
                            query, { query = it },
                            singleLine = true,
                            textStyle = TextStyle(fontSize = 16.sp, color = theme.fg),
                            cursorBrush = SolidColor(theme.fg),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
                            modifier = Modifier.fillMaxWidth().focusRequester(findFocus),
                        )
                    }
                }
                Text(
                    L("Cancel"), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = theme.fg,
                    modifier = Modifier.pressable(PressFeedback.Fade) { searching = false; query = "" }.padding(horizontal = 4.dp, vertical = 9.dp),
                )
            }
        } else {
            // Sort row (5.2.4)
            Row(
                Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(horizontal = Spacing.gutter, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconView(Icon.Sort, size = 16.dp, tint = theme.fg)
                Text(L("Recents"), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = theme.fg, modifier = Modifier.weight(1f))
                val label = if (grid) L("List view") else L("Grid view")
                Box(
                    Modifier.offset(x = 10.dp).size(40.dp).pressable(PressFeedback.Fade) { grid = !grid; LibraryViewMemory.grid = grid }
                        .semantics { contentDescription = label },
                    contentAlignment = Alignment.Center,
                ) { IconView(if (grid) Icon.List else Icon.Grid, size = 20.dp, tint = theme.fg) }
            }
        }

        // List (5.2.6 - 5.2.13)
        Box(Modifier.weight(1f).fillMaxWidth().onSizeChanged { listWidthPx = it.width }) {
            val likedRow: @Composable (Modifier, @Composable () -> Unit) -> Unit = { m, content ->
                Box(m.pressable(PressFeedback.Row, onLongPress = { menu = likedMenu() }) { app.nav.push(Route.LikedSongs) }) { content() }
            }
            val entryRow: @Composable (LibraryRowModel, Modifier, @Composable () -> Unit) -> Unit = { m, mod, content ->
                val e = m.entry!!
                if (flat) {
                    Box(mod.pressable(PressFeedback.Row, onLongPress = { menu = entryMenu(e) }) { open(e) }) { content() }
                } else {
                    LibraryDragSlot(drag, e.id, mod.pressable(PressFeedback.Row) { open(e) }) { content() }
                }
            }
            if (grid) {
                val cells: List<LibraryRowModel?> = (if (showLiked) listOf(null) else emptyList()) + models
                Box(Modifier.fillMaxSize().libraryDragHost(drag).verticalScroll(gridScroll)) {
                    // Not lazy: a drag measures every cell at the lift.
                    Column(
                        Modifier.fillMaxWidth().onGloballyPositioned { gridContent[0] = it }
                            .padding(horizontal = Spacing.gutter).padding(top = 8.dp, bottom = shellContentPadding().calculateBottomPadding()),
                        verticalArrangement = Arrangement.spacedBy(LibraryLayoutMetrics.gridGap),
                    ) {
                        for (pair in cells.chunked(2)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(LibraryLayoutMetrics.gridGap), verticalAlignment = Alignment.Top) {
                                for (i in 0 until 2) {
                                    val m = pair.getOrNull(i)
                                    val cellMod = Modifier.weight(1f)
                                    when {
                                        i >= pair.size -> Spacer(cellMod.height(1.dp))
                                        m == null -> likedRow(cellMod) { LibraryGridCell(likedModel) }
                                        else -> {
                                            val measured = cellMod.onGloballyPositioned { c ->
                                                val root = gridContent[0] ?: return@onGloballyPositioned
                                                if (!root.isAttached || !c.isAttached) return@onGloballyPositioned
                                                val r = root.localBoundingBoxOf(c, clipBounds = false)
                                                gridFrames[m.id] = Rect(r.left / density.density, r.top / density.density, r.right / density.density, r.bottom / density.density)
                                            }
                                            entryRow(m, measured) { LibraryGridCell(m) }
                                        }
                                    }
                                }
                            }
                        }
                        empty?.let { LibraryEmptyBlock(it) { openCreate() } }
                    }
                }
            } else {
                LazyColumn(
                    Modifier.fillMaxSize().libraryDragHost(drag),
                    state = listState,
                    contentPadding = shellContentPadding(),
                ) {
                    if (showLiked) item(key = LibraryRowModel.LIKED_ID) {
                        likedRow(Modifier.padding(horizontal = Spacing.gutter)) { LibraryListRow(likedModel) }
                    }
                    items(models, key = { it.id }) { m ->
                        entryRow(m, Modifier.padding(horizontal = Spacing.gutter)) { LibraryListRow(m) }
                    }
                    if (empty != null) item(key = "lib-empty") {
                        Box(Modifier.padding(horizontal = Spacing.gutter)) { LibraryEmptyBlock(empty) { openCreate() } }
                    }
                }
            }
            // The lifted row and the drop line, drawn over the list where the finger is.
            LibraryDragOverlay(drag) { id ->
                val m = models.firstOrNull { it.id == id } ?: return@LibraryDragOverlay
                if (grid) LibraryGridCell(m) else LibraryListRow(m)
            }
        }
    }

    ContextMenuSheet(menu) { menu = null }
    OverlayCover(naming, { naming = null }) { n, close -> LibraryNamingPage(n, close) { nn, name -> submitNaming(nn, name) } }
    ConfirmDialogHost(confirm) { confirm = null }
}

private fun filterLabel(f: LibraryFilter): String = when (f) {
    LibraryFilter.Playlist -> L("Playlists")
    LibraryFilter.Album -> L("Albums")
    LibraryFilter.Artist -> L("Artists")
}

/** 40x40, 24 glyph `--fg`; `--accent-ink` while on. */
@Composable
private fun LibraryHeaderButton(icon: Icon, label: String, on: Boolean, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(
        Modifier.size(40.dp).pressable(PressFeedback.Fade, onTap = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { IconView(icon, size = 24.dp, tint = if (on) theme.accentInk else theme.fg) }
}

/**
 * A row that takes part in a drag: slides aside for the lifted one (animated), hides while it
 * is the lifted one (the overlay draws it under the finger), and shows the folder drop target.
 */
@Composable
internal fun LibraryDragSlot(drag: LibraryDragController, id: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val theme = LocalTheme.current
    val goal by remember(id) { derivedStateOf { drag.offset(id) } }
    val lifted by remember(id) { derivedStateOf { drag.lift?.id == id } }
    val target by remember(id) { derivedStateOf { drag.targetFolder == id } }
    val anim = remember { Animatable(Offset.Zero, Offset.VectorConverter) }
    val active by remember { derivedStateOf { drag.isLifted } }
    LaunchedEffect(goal, active) { if (!active) anim.snapTo(Offset.Zero) else anim.animateTo(goal, tween(180, easing = dragEasing)) }
    Box(
        modifier
            .zIndex(if (lifted) 1f else 0f)
            .graphicsLayer {
                // Read here (draw phase) so a drop puts every row back in the same frame.
                val o = if (drag.isLifted) anim.value else Offset.Zero
                translationX = o.x * density
                translationY = o.y * density
                alpha = if (lifted) 0f else 1f
            }
            .then(if (target) Modifier.background(theme.fg(0.14)).border(2.dp, theme.accentInk) else Modifier),
    ) { content() }
}

/** The lifted row under the finger (`--card-hover`, shadow, 1.02) and the accent drop line with its ring. */
@Composable
internal fun LibraryDragOverlay(drag: LibraryDragController, ghost: @Composable (id: String) -> Unit) {
    val theme = LocalTheme.current
    val lift = drag.lift ?: return
    val origin = drag.liveOrigin
    drag.dropLine?.let { r ->
        Box(Modifier.offset(r.left.dp - 4.dp, (r.top + origin).dp - 3.dp).zIndex(2f)) {
            Box(Modifier.offset(x = 4.dp, y = 3.dp).width(r.width.dp).height(2.dp).background(theme.accentInk, RoundedCornerShape(1.dp)))
            Box(Modifier.size(8.dp).background(theme.page, CircleShape).border(2.dp, theme.accentInk, CircleShape))
        }
    }
    drag.ghost?.let { r ->
        Box(
            Modifier.offset(r.left.dp, (r.top + origin).dp).size(r.width.dp, r.height.dp).zIndex(3f)
                .graphicsLayer { scaleX = 1.02f; scaleY = 1.02f }
                .shadow(12.dp)
                .background(theme.cardHover),
        ) { ghost(lift.id) }
    }
}

/** Which empty block (5.2.13). */
@Composable
private fun LibraryEmptyBlock(s: LibraryEmptyState, onCreate: () -> Unit) {
    val theme = LocalTheme.current
    val (title, line, button) = when (s) {
        LibraryEmptyState.NothingDownloaded -> Triple(L("Nothing downloaded"), L("Download a playlist or album while you have a connection and it shows here."), false)
        LibraryEmptyState.CreateFirst -> Triple(L("Create your first playlist"), L("It's easy, we'll help you."), true)
        is LibraryEmptyState.NoMatch -> Triple(L("Couldn’t find “{query}”", "query" to s.query), L("Try a different playlist, album or artist name."), false)
        LibraryEmptyState.NoArtists -> Triple(L("No artists yet"), L("Follow an artist and they show up here."), false)
        LibraryEmptyState.NoAlbums -> Triple(L("Save your first album"), L("Add an album to Your Library and it shows up here."), false)
    }
    Column(Modifier.fillMaxWidth().padding(top = 24.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = theme.fg)
        Text(line, fontSize = 13.sp, color = theme.fgSub, modifier = Modifier.padding(bottom = 6.dp))
        if (button) {
            Box(
                Modifier.pressable(PressFeedback.Fade, onTap = onCreate).defaultMinSize(minHeight = 32.dp)
                    .background(theme.fg, CircleShape).padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) { Text(L("Create playlist"), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = theme.onFg) }
        }
    }
}

/** Open folders, per device (`slopify.libOpenFolders`, a JSON array of ids). */
object LibraryOpenFolders {
    const val KEY = "slopify.libOpenFolders"
    private val serializer = ListSerializer(String.serializer())

    fun load(kv: KeyValueStore): Set<String> {
        val s = kv.getString(KEY) ?: return emptySet()
        return attempt { SlopifyJson.decodeFromString(serializer, s).toSet() } ?: emptySet()
    }

    fun save(ids: Set<String>, kv: KeyValueStore) = kv.putString(KEY, SlopifyJson.encodeToString(serializer, ids.sorted()))
}
