package com.lukasbaxter.slopify.android.features.search

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.api.genre
import com.lukasbaxter.slopify.android.core.api.genreMix
import com.lukasbaxter.slopify.android.core.api.genreTracks
import com.lukasbaxter.slopify.android.core.api.home
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.GenreDetail
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.storage.SharedPrefsStore
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.components.ActionRow
import com.lukasbaxter.slopify.android.design.components.BigPlayButton
import com.lukasbaxter.slopify.android.design.components.CardGrid
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.IconButton
import com.lukasbaxter.slopify.android.design.components.LocalDetailTopInset
import com.lukasbaxter.slopify.android.design.components.MediaCard
import com.lukasbaxter.slopify.android.design.components.SectionHeader
import com.lukasbaxter.slopify.android.design.components.Shelf
import com.lukasbaxter.slopify.android.design.components.TrackRow
import com.lukasbaxter.slopify.android.design.components.rememberTrackMenuBuilder
import com.lukasbaxter.slopify.android.design.components.reportsHeroHeight
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyph
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyphMode
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialog
import com.lukasbaxter.slopify.android.design.sheets.NameDialogHost
import com.lukasbaxter.slopify.android.design.theme.HeroIsland
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme
import com.lukasbaxter.slopify.android.player.ShuffleMode
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import java.text.NumberFormat
import kotlin.coroutines.cancellation.CancellationException
import kotlin.random.Random

/** A genre page (UI.md 6.3.8), coloured like the tile it was opened from (DECISIONS). */
@Composable
fun GenreView(name: String) = SearchBrowsePage(charts = false, genre = name)

/** Which Browse page (`kind 'Browse'`). */
sealed interface SearchBrowseKind {
    data class Genre(val name: String) : SearchBrowseKind
    data object Charts : SearchBrowseKind
}

/** Pure parts of the Genre / Charts page, for tests. */
object SearchBrowseLogic {
    /** Charts has no hub: its albums come from the tracks, first appearance order. */
    fun albumsFromTracks(tracks: List<Track>, unknown: String): List<Album> {
        val seen = HashSet<String>()
        return tracks.filter { it.albumId.isNotEmpty() && seen.add(it.albumId) }.map { t ->
            Album(t.albumId, t.album.ifEmpty { unknown }, t.albumArtist.ifEmpty { t.artists.firstOrNull() ?: "" }, cover = t.cover)
        }
    }

    /** The player context (`browse:<tile id>`). */
    fun context(kind: SearchBrowseKind): String = when (kind) {
        is SearchBrowseKind.Genre -> "browse:genre:${kind.name}"
        SearchBrowseKind.Charts -> "browse:charts"
    }

    /** Charts `#402d4d`; a genre takes its tile's colour, else the default `#2a2929`. */
    fun hero(kind: SearchBrowseKind, tiles: List<com.lukasbaxter.slopify.android.core.model.BrowseTile>?): RGB = when (kind) {
        SearchBrowseKind.Charts -> ColorMath.heroTint(Theme.Fixed.radarHero)
        is SearchBrowseKind.Genre -> ColorMath.heroTint(SearchBrowseData.tileColor(kind.name, tiles) ?: Theme.Fixed.defaultHero)
    }

    fun number(n: Int): String = NumberFormat.getIntegerInstance(Localizer.shared.locale).format(n)

    fun meta(hub: GenreDetail?, tracks: Int, loading: Boolean, failed: Boolean, offline: Boolean): String = when {
        hub != null -> L("{songs} songs • {albums} albums", "songs" to number(hub.trackCount ?: 0), "albums" to number(hub.albumCount ?: 0))
        tracks > 0 -> L("{n} most played", "n" to tracks)
        loading -> L("Loading…")
        failed -> if (offline) L("Not available offline") else L("Couldn’t load this — try again")
        else -> L("Nothing in this genre yet")
    }
}

/**
 * Genre and Charts pages (`kind 'Browse'`, Library.jsx:672-742): text-only hero, Shuffle +
 * Play, then Top artists, Albums, New additions and Popular. Route.charts lands here with
 * `charts = true`; [GenreView] passes the genre.
 */
@Composable
fun SearchBrowsePage(charts: Boolean, genre: String? = null) {
    val kind: SearchBrowseKind = if (charts || genre == null) SearchBrowseKind.Charts else SearchBrowseKind.Genre(genre)
    val app = LocalAppModel.current
    val context = LocalContext.current
    val player by app.player.state.collectAsStateWithLifecycle()
    val offline by app.connectivity.offline.collectAsStateWithLifecycle()
    var hub by remember(kind) { mutableStateOf<GenreDetail?>(null) }
    var tracks by remember(kind) { mutableStateOf<List<Track>>(emptyList()) }
    var loading by remember(kind) { mutableStateOf(true) }
    var failed by remember(kind) { mutableStateOf(false) }
    var menu by remember { mutableStateOf<MenuSheet?>(null) }
    var dialog by remember { mutableStateOf<NameDialog?>(null) }
    val builder = rememberTrackMenuBuilder { dialog = it }
    val scope = rememberCoroutineScope()

    val hero = remember(kind, app) {
        val tiles = SearchSession.browseIfOpen(app)?.saved?.value?.tiles
            ?: SearchBrowseData.storageKey(app.account.saved.value?.main, app.account.user.value?.id)
                ?.let { SearchBrowseData.load(SharedPrefsStore(context.applicationContext), it)?.tiles }
        SearchBrowseLogic.hero(kind, tiles)
    }
    val title = (kind as? SearchBrowseKind.Genre)?.name ?: L("Charts")
    val ctx = SearchBrowseLogic.context(kind)

    LaunchedEffect(kind) {
        loading = true; failed = false
        try {
            when (kind) {
                is SearchBrowseKind.Genre -> coroutineScope {
                    val h = async { app.account.api.genre(kind.name) }
                    val t = async { app.account.api.genreTracks(kind.name) }
                    hub = h.await(); tracks = t.await().take(30)
                }
                // The web's `topTracks({ limit: 100 })` reads /api/home (at most 50), keeps 50.
                SearchBrowseKind.Charts -> tracks = app.account.api.home().topTracks.take(50)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = true
        }
        loading = false
    }

    // Genre: everything in the genre weighted to plays and likes; Charts: its own tracks.
    fun playMix(shuffle: Boolean) {
        scope.launch {
            val mix = (kind as? SearchBrowseKind.Genre)?.let { attempt { app.account.api.genreMix(it.name) } } ?: tracks
            if (mix.isEmpty()) return@launch
            if (shuffle) app.player.setShuffle(ShuffleMode.On)
            app.player.play(mix, startAt = if (shuffle) Random.nextInt(mix.size) else 0, context = ctx)
        }
    }

    val artists = hub?.topArtists.orEmpty()
    val albums = (hub?.albums ?: SearchBrowseLogic.albumsFromTracks(tracks, L("Unknown album"))).take(18)
    val recent = hub?.recent.orEmpty().take(12)

    DetailScaffold(title, heroColor = hero) {
        item(key = "browse-hero") { SearchBrowseHero(hero, title, SearchBrowseLogic.meta(hub, tracks.size, loading, failed, offline)) }
        item(key = "browse-actions") {
            ActionRow(hero, leading = {}) {
                IconButton(L("Shuffle"), onClick = { playMix(shuffle = true) }) { tint -> ShuffleGlyph(ShuffleGlyphMode.Off, size = 24.dp, tint = tint) }
                BigPlayButton(playing = false, Modifier.padding(start = 4.dp)) { playMix(shuffle = false) }
            }
        }
        if (artists.isNotEmpty()) {
            item(key = "artists-head") { SectionHeader(L("Top artists"), first = true) }
            item(key = "artists") {
                Shelf(artists, key = { it.id }) { a ->
                    MediaCard(CoverSource.ArtistArt(a.id, null), a.name, L("Artist"), round = true) { app.nav.push(Route.Artist(a.id)) }
                }
            }
        }
        if (albums.isNotEmpty()) {
            item(key = "albums-head") { SectionHeader(L("Albums"), first = artists.isEmpty()) }
            item(key = "albums") {
                CardGrid(albums) { a ->
                    MediaCard(
                        CoverSource.of(a), a.name, listOf(a.artist, a.year?.toString() ?: "").filter { it.isNotEmpty() }.joinToString(" • "),
                        artSize = 175.dp,
                    ) { app.nav.push(Route.Album(a.id)) }
                }
            }
        }
        if (recent.isNotEmpty()) {
            item(key = "recent-head") { SectionHeader(L("New additions"), first = artists.isEmpty() && albums.isEmpty()) }
            item(key = "recent") {
                Shelf(recent, key = { it.id }) { a -> MediaCard(CoverSource.of(a), a.name, a.artist) { app.nav.push(Route.Album(a.id)) } }
            }
        }
        if (tracks.isNotEmpty()) {
            item(key = "popular-head") { SectionHeader(L("Popular"), first = artists.isEmpty() && albums.isEmpty() && recent.isEmpty()) }
            itemsIndexed(tracks, key = { i, t -> "t:$i:${t.id}" }) { i, t ->
                TrackRow(
                    t, showArt = true, isCurrent = player.current?.id == t.id,
                    onMore = { menu = builder.sheet(t) },
                    onArt = { if (t.albumId.isNotEmpty()) app.nav.push(Route.Album(t.albumId)) },
                    onTouchDown = { app.player.prewarm(t) },
                ) {
                    if (player.current?.id == t.id) app.player.togglePlay() else app.player.play(tracks, startAt = i, context = ctx)
                }
            }
        }
    }
    ContextMenuSheet(menu) { menu = null }
    NameDialogHost(dialog) { dialog = null }
}

/**
 * The text-only hero of genre / chart pages (`.hero.browse-hero`): `--hero` with the page wash,
 * padding `56 + inset` 16 8, 24/700 title (2 lines), meta 13 white 70 %. The "Genre" kind label
 * is hidden on phone.
 */
@Composable
private fun SearchBrowseHero(color: RGB, title: String, meta: String) {
    val topInset = LocalDetailTopInset.current
    HeroIsland {
        val theme = LocalTheme.current
        Column(
            Modifier.fillMaxWidth().reportsHeroHeight()
                .background(color.color)
                .background(Brush.verticalGradient(listOf(theme.page(0.0), Theme.Fixed.heroWash)))
                .padding(top = Shell.topBar + topInset, start = Spacing.gutter, end = Spacing.gutter, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(title, style = TextStyles.pageTitle, color = theme.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(meta, fontSize = 13.sp, color = theme.fg(0.7))
        }
    }
}
