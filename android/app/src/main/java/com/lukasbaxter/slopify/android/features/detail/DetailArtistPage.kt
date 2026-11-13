package com.lukasbaxter.slopify.android.features.detail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.api.like
import com.lukasbaxter.slopify.android.core.api.unlike
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.ActionRow
import com.lukasbaxter.slopify.android.design.components.BigPlayButton
import com.lukasbaxter.slopify.android.design.components.DetailBarStyle
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.FollowPill
import com.lukasbaxter.slopify.android.design.components.IconButton
import com.lukasbaxter.slopify.android.design.components.LocalDetailTopInset
import com.lukasbaxter.slopify.android.design.components.MediaCard
import com.lukasbaxter.slopify.android.design.components.PlaceholderNote
import com.lukasbaxter.slopify.android.design.components.SectionHeader
import com.lukasbaxter.slopify.android.design.components.SectionStyle
import com.lukasbaxter.slopify.android.design.components.Shelf
import com.lukasbaxter.slopify.android.design.components.SkeletonTitle
import com.lukasbaxter.slopify.android.design.components.TrackMenu
import com.lukasbaxter.slopify.android.design.components.TrackRow
import com.lukasbaxter.slopify.android.design.components.reportsHeroHeight
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyph
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyphMode
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.image.LocalApiClient
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuHeader
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialogHost
import com.lukasbaxter.slopify.android.design.theme.HeroIsland
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.Theme
import com.lukasbaxter.slopify.android.player.ShuffleMode
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/**
 * Artist page (UI.md 6.3.7; Library.jsx detail kind 'Artist'; ios ArtistView.swift): banner
 * hero, Follow / ⋯ | Shuffle / Play, then Popular, Popular releases or Discography, Appears On,
 * Fans also like.
 */
@Composable
internal fun DetailArtistPage(id: String) {
    val actions = rememberDetailActions()
    val app = actions.app
    val context = LocalContext.current
    val model = remember(id) { DetailArtistModel(id) }
    val player by app.player.state.collectAsState()
    val likes by app.likes.state.collectAsState()
    val offline by app.connectivity.offline.collectAsState()
    val user by app.account.user.collectAsState()
    var popularExpanded by rememberSaveable(id) { mutableStateOf(false) }
    var discoOpen by rememberSaveable(id) { mutableStateOf(false) }

    LaunchedEffect(id, user?.id) {
        val api = app.account.api
        launch { model.sampleColour(api) }
        model.load(api, user?.id, DetailCache.shared(context))
    }

    // While a request is on its way, look again every 5 s for up to 30 minutes.
    val pending = model.hasPending
    LaunchedEffect(pending) {
        if (!pending) return@LaunchedEffect
        repeat(30 * 60 / 5) {
            delay(5_000)
            if (!model.hasPending) return@LaunchedEffect
            model.refreshDiscography(app.account.api)
        }
    }

    val following = model.followOverride ?: (id in likes.artists || model.followed)
    val here = player.context == model.context

    /** Optimistic follow; reverts and shows the banner on failure (Library.jsx toggleFollow). */
    fun toggleFollow() {
        val on = !following
        model.followOverride = on
        val api = app.account.api
        actions.launch {
            try {
                if (on) api.like(id) else api.unlike(id)
                app.likes.refresh()
                app.library.refreshArtists()
                // The page's own copy says what the server now holds, so the pill does not flip back.
                model.followed = on
                model.followOverride = null
                actions.announceLibraryChange()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                model.followOverride = !on
                actions.error = DetailActions.message(e)
            }
        }
    }

    fun openPageMenu() {
        val a = model.artist ?: return
        val tracks = model.tracks
        val items = buildList {
            add(MenuItem(L("Add to queue"), Icon.Queue, offline = true) { app.player.addToQueue(tracks) })
            add(MenuItem(if (following) L("Unfollow") else L("Follow"), Icon.Follow) { toggleFollow() })
            add(MenuItem(L("Go to radio"), Icon.Radio) { actions.radio(id, a.name) })
            if (tracks.isNotEmpty()) add(MenuItem(L("Add to playlist"), Icon.Plus, sub = actions.playlistSub(tracks)))
            add(MenuItem(L("Share"), Icon.Share) { actions.share(TrackMenu.ShareKind.Artist, id, a.name, null) })
        }
        val header = MenuHeader(MenuHeader.Art.Cover(CoverSource.of(a), round = true), a.name, L("Artist"))
        actions.menu = MenuSheet(header, actions.pageItems(items))
    }

    fun openAlbum(albumId: String) = app.nav.push(Route.Album(albumId))
    fun reloadDiscography() { actions.launch { model.loadDiscography(app.account.api) } }
    fun request(e: DetailLogic.Entry) {
        actions.launch {
            try { model.request(e, app.account.api) } catch (x: CancellationException) { throw x } catch (x: Exception) { actions.error = DetailActions.message(x) }
        }
    }

    Box(Modifier.fillMaxSize()) {
        if (offline && !model.loading && model.artist == null) {
            DetailScaffold("") { item(key = "offline") { OfflineEmpty() } }
        } else {
            val hero = model.hero
            DetailScaffold(model.artist?.name ?: "", heroColor = hero, barStyle = DetailBarStyle.Artist) {
                item(key = "hero") { ArtistHero(model, hero) }
                item(key = "actions") {
                    ActionRow(hero, artist = true, leading = {
                        val label = if (following) L("Unfollow") else L("Follow")
                        FollowPill(following, Modifier.semantics { contentDescription = label }) { toggleFollow() }
                        Spacer(Modifier.width(4.dp))
                        IconButton(Icon.Dots24, L("More options for {name}", "name" to (model.artist?.name ?: ""))) { openPageMenu() }
                    }) {
                        val shuffled = player.shuffle != ShuffleMode.Off
                        IconButton(if (shuffled) L("Disable shuffle") else L("Enable shuffle"), on = shuffled, onClick = actions::toggleShuffle) { tint ->
                            ShuffleGlyph(ShuffleGlyphMode.Off, size = 24.dp, tint = tint)
                        }
                        Spacer(Modifier.width(4.dp))
                        BigPlayButton(here && player.isPlaying) {
                            if (here) app.player.togglePlay() else if (model.tracks.isNotEmpty()) actions.playPage(model.tracks, model.context)
                        }
                    }
                }
                item(key = "top-space") { Spacer(Modifier.padding(top = 8.dp)) }
                popularSection(model, actions, player.current?.id, player.isPlaying, offline, popularExpanded) { popularExpanded = !popularExpanded }
                if (discoOpen) {
                    item(key = "discography") {
                        DetailDiscographySection(model, offline, ::openAlbum, ::request, ::reloadDiscography)
                    }
                } else {
                    releasesSection(model, offline, ::openAlbum, ::request, ::reloadDiscography) { discoOpen = true }
                }
                appearsOnSection(model.appearsOn, ::openAlbum)
                similarSection(model) { app.nav.push(Route.Artist(it)) }
                // "About" needs `Overview`, which the API does not send (Spec issues).
            }
        }
        Box(Modifier.align(Alignment.TopCenter)) { DetailErrorBanner(actions.error) { actions.error = null } }
    }
    ContextMenuSheet(actions.menu) { actions.menu = null }
    NameDialogHost(actions.nameDialog) { actions.nameDialog = null }
}

// Popular

private fun LazyListScope.popularSection(
    model: DetailArtistModel,
    actions: DetailActions,
    currentId: String?,
    isPlaying: Boolean,
    offline: Boolean,
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    val tracks = model.tracks
    val app = actions.app
    item(key = "popular-head") { SectionHeader(L("Popular"), style = SectionStyle.Artist, first = true) }
    itemsIndexed(tracks.take(if (expanded) 10 else 5), key = { i, t -> "popular-${t.id}-$i" }) { i, t ->
        val current = currentId == t.id
        val downloaded = actions.has(t.id)
        TrackRow(
            t, showArt = true, number = i + 1, isCurrent = current, isPlaying = current && isPlaying,
            isDownloaded = downloaded, isUnavailable = offline && !downloaded,
            subtitle = DetailLogic.playsSubtitle(t, Localizer.shared.locale),
            onMore = { actions.openTrackMenu(t) },
            onArt = { app.nav.push(Route.Album(t.albumId)) },
            onTouchDown = { app.player.prewarm(t) },
        ) { if (current) app.player.togglePlay() else actions.playRow(tracks, i, model.context) }
    }
    if (tracks.size > 5) {
        item(key = "popular-more") {
            DetailOutlinePill(if (expanded) L("Show less") else L("See more"), Modifier.padding(top = 8.dp).padding(horizontal = Spacing.gutter), onToggle)
        }
    }
}

// Popular releases (phone default)

private fun LazyListScope.releasesSection(
    model: DetailArtistModel,
    offline: Boolean,
    onOpen: (String) -> Unit,
    onRequest: (DetailLogic.Entry) -> Unit,
    onRetry: () -> Unit,
    onSeeDiscography: () -> Unit,
) {
    val all = model.entries
    val top = DetailLogic.newestFirst(all).take(5)
    val discog = model.discog
    if (all.isEmpty() && discog is DetailDiscog.Loaded) return
    item(key = "releases-head") { SectionHeader(L("Popular releases"), style = SectionStyle.Artist) }
    if (discog == DetailDiscog.Loading && top.isEmpty()) item(key = "releases-loading") { PlaceholderNote(L("Loading…")) }
    if (discog == DetailDiscog.Failed) item(key = "releases-failed") { DetailDiscographyFailedNote(offline, onRetry) }
    itemsIndexed(top, key = { _, e -> "release-${e.id}" }) { _, e ->
        Box(Modifier.padding(horizontal = Spacing.gutter)) { DetailReleaseRow(e, model.requestState(e), onOpen, onRequest) }
    }
    if (all.isNotEmpty()) {
        item(key = "releases-more") {
            DetailOutlinePill(L("See discography"), Modifier.padding(top = 12.dp, bottom = 4.dp).padding(horizontal = Spacing.gutter), onSeeDiscography)
        }
    }
}

// Appears On / Fans also like

private fun LazyListScope.appearsOnSection(albums: List<Album>, onOpen: (String) -> Unit) {
    if (albums.isEmpty()) return
    item(key = "appears-head") { SectionHeader(L("Appears On"), style = SectionStyle.Artist) }
    item(key = "appears") {
        Shelf(albums, key = { it.id }) { a -> MediaCard(CoverSource.of(a), a.name, a.artist) { onOpen(a.id) } }
    }
}

private data class SimilarArtist(val id: String, val name: String)

private fun LazyListScope.similarSection(model: DetailArtistModel, onOpen: (String) -> Unit) {
    val similar = model.similar.mapNotNull { s -> s.id?.let { SimilarArtist(it, s.name) } }
    if (similar.isEmpty()) return
    item(key = "similar-head") { SectionHeader(L("Fans also like"), style = SectionStyle.Artist) }
    item(key = "similar") {
        Shelf(similar, key = { it.id }) { a ->
            MediaCard(CoverSource.ArtistArt(a.id, null), a.name, L("Artist"), round = true) { onOpen(a.id) }
        }
    }
}

// Offline, never opened (Library.jsx:1113-1120)

@Composable
private fun OfflineEmpty() {
    val theme = LocalTheme.current
    Column(
        Modifier.fillMaxWidth().padding(vertical = 120.dp - 56.dp, horizontal = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(L("Not available offline"), fontSize = 20.sp, fontWeight = FontWeight.Bold, color = theme.fg, textAlign = TextAlign.Center)
        Text(
            L("Open this artist once with a connection, and they show up here offline too."),
            fontSize = 14.sp, lineHeight = 20.sp, color = theme.fgSub, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 320.dp),
        )
    }
}

/**
 * The artist hero (UI.md 6.3.7): at least 300, content at the bottom, the banner melting into the
 * action-row band (or a flat `--hero`), verified badge, 48 name (34 at <= 380 wide), song count.
 */
@Composable
private fun ArtistHero(model: DetailArtistModel, hero: RGB) {
    val page = LocalTheme.current.rgb.page
    val api = LocalApiClient.current
    val topInset = LocalDetailTopInset.current
    val banner = model.hasBanner
    val a = model.artist
    // Phone: the 640 px copy (`bannerWidth`); the portrait when there is no wide photo.
    val bannerUrl = when {
        a == null -> null
        a.banner != null -> CoverSource.Banner(a.id).url(api, 640)
        a.image != null -> CoverSource.ArtistArt(a.id, a.image).url(api, 640)
        else -> null
    }
    val shadow = if (banner) Shadow(Color.Black.copy(alpha = 0.5f), Offset(0f, 2f), 6f) else null
    HeroIsland {
        BoxWithConstraints(Modifier.fillMaxWidth().heightIn(min = 300.dp + topInset).reportsHeroHeight().background(hero.color)) {
            if (banner) {
                DetailFocalImage(bannerUrl, Modifier.matchParentSize())
                Box(
                    Modifier.matchParentSize().background(
                        Brush.verticalGradient(
                            0.3f to Color.Transparent,
                            0.7f to Color.Black.copy(alpha = 0.35f),
                            1f to hero.colorMix(0.8, page).color,
                        ),
                    ),
                )
            }
            val size = if (maxWidth <= 380.dp) 34 else 48
            Column(
                Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(horizontal = Spacing.gutter).padding(bottom = 8.dp),
            ) {
                Row(Modifier.padding(bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconView(Icon.Verified, size = 18.dp, tint = Theme.Fixed.verified)
                    Text(L("Verified Artist"), style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold, shadow = shadow), color = Color.White)
                }
                val name = a?.name
                if (name != null) {
                    Text(
                        name, color = Color.White, modifier = Modifier.padding(bottom = 4.dp),
                        style = TextStyle(fontSize = size.sp, fontWeight = FontWeight.Bold, lineHeight = (size * 1.05).sp, shadow = shadow),
                    )
                } else {
                    SkeletonTitle()
                }
                Text(L("{n} songs in your library", "n" to model.tracks.size), fontSize = 13.sp, color = Color.White)
            }
        }
    }
}
