package com.lukasbaxter.slopify.android.features.account

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.api.home
import com.lukasbaxter.slopify.android.core.api.playlists
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.LocalDetailTopInset
import com.lukasbaxter.slopify.android.design.components.MediaCard
import com.lukasbaxter.slopify.android.design.components.PlaceholderNote
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.TrackRow
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.components.rememberTrackMenuBuilder
import com.lukasbaxter.slopify.android.design.components.reportsHeroHeight
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.image.ImageLoader
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.sheets.BottomSheet
import com.lukasbaxter.slopify.android.design.sheets.ContextMenuSheet
import com.lukasbaxter.slopify.android.design.sheets.LocalCloseSheet
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuList
import com.lukasbaxter.slopify.android.design.sheets.MenuSheet
import com.lukasbaxter.slopify.android.design.sheets.NameDialog
import com.lukasbaxter.slopify.android.design.sheets.NameDialogHost
import com.lukasbaxter.slopify.android.design.theme.HeroIsland
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/**
 * Phone Profile (UI.md 7.4; web Library.jsx:1029-1109, App.jsx:938-955; ios ProfileView.swift):
 * grey hero with the 128 avatar (tap to change it), Edit + ⋯, then top artists, top tracks and
 * playlists.
 */
@Composable
internal fun AccountProfileScreen() {
    val app = LocalAppModel.current
    val account = app.account
    val nav = app.nav
    val player = app.player
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val user by account.user.collectAsStateWithLifecycle()
    val playerState by player.state.collectAsStateWithLifecycle()
    var loading by remember { mutableStateOf(true) }
    var tracks by remember { mutableStateOf<List<Track>>(emptyList()) }
    var artists by remember { mutableStateOf<List<AccountProfileLogic.TopArtist>>(emptyList()) }
    var playlists by remember { mutableStateOf<List<Playlist>>(emptyList()) }
    var showAllTracks by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var trackMenu by remember { mutableStateOf<MenuSheet?>(null) }
    var nameDialog by remember { mutableStateOf<NameDialog?>(null) }
    val builder = rememberTrackMenuBuilder { nameDialog = it }
    val name = user?.name?.takeIf { it.isNotEmpty() } ?: L("You")

    suspend fun upload(uri: Uri) {
        val jpeg = withContext(Dispatchers.IO) { AccountProfilePhoto.jpeg(context.contentResolver, uri) }
        if (jpeg == null) {
            ToastCenter.shared.show(L("Could not upload: {error}", "error" to L("not an image")))
            return
        }
        try {
            account.api.upload("api/users/me/avatar", jpeg, "image/jpeg", JsonObject.serializer())
            user?.id?.let { ImageLoader.shared.evict(account.api.avatarUrl(it).toString()) }
            com.lukasbaxter.slopify.android.design.image.AvatarVersion.bumped()
            ToastCenter.shared.show(L("Profile picture updated"))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ToastCenter.shared.show(L("Could not upload: {error}", "error" to (e.message ?: e.toString())))
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) scope.launch { upload(uri) }
    }
    val pick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }

    LaunchedEffect(Unit) {
        coroutineScope {
            val home = async { attempt { account.api.home() } }
            val lists = async { attempt { account.api.playlists() } }
            val top = home.await()?.topTracks.orEmpty().take(60)
            tracks = top.take(10)
            artists = AccountProfileLogic.topArtists(top)
            playlists = lists.await().orEmpty()
            loading = false
        }
    }

    DetailScaffold(name, heroColor = Theme.Fixed.profileHero) {
        item(key = "hero") { AccountProfileHero(name, user?.id, playlists.size, pick) }
        item(key = "actions") {
            Row(
                Modifier.fillMaxWidth().padding(start = Spacing.gutter, end = Spacing.gutter, bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val theme = LocalTheme.current
                AccountOutlinePill(L("Edit"), theme.fgFaint, onClick = pick)
                val more = L("More options")
                Box(
                    Modifier.size(32.dp).pressable(PressFeedback.Fade) { menuOpen = true }.semantics { contentDescription = more },
                    contentAlignment = Alignment.Center,
                ) { IconView(Icon.Dots, size = 24.dp, tint = theme.fgDim) }
            }
        }
        item(key = "top-pad") { Spacer(Modifier.height(8.dp)) }
        if (artists.isNotEmpty()) {
            item(key = "artists") {
                Column {
                    ProfileHead(L("Top artists this month"), first = true, sub = true)
                    LazyRow(contentPadding = PaddingValues(horizontal = Spacing.gutter), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(artists, key = { it.id }) { a ->
                            MediaCard(CoverSource.ArtistArt(a.id, null), a.name, L("Artist"), Modifier.width(120.dp), round = true, artSize = 120.dp) {
                                nav.push(Route.Artist(a.id))
                            }
                        }
                    }
                }
            }
        }
        if (tracks.isNotEmpty()) {
            item(key = "tracks-head") { ProfileHead(L("Top tracks this month"), first = artists.isEmpty(), sub = true) }
            val shown = if (showAllTracks) tracks else tracks.take(5)
            itemsIndexed(shown, key = { _, t -> "t-" + t.id }) { i, t ->
                val current = playerState.current?.id == t.id
                TrackRow(
                    t, showArt = true, isCurrent = current, isPlaying = current && playerState.isPlaying,
                    onMore = { trackMenu = builder.sheet(t) }, onTouchDown = { player.prewarm(t) },
                ) { player.play(tracks, startAt = i, context = "profile") }
            }
            if (tracks.size > 5) {
                item(key = "tracks-more") {
                    AccountOutlinePill(
                        if (showAllTracks) L("See less") else L("See all"), LocalTheme.current.fgFaint,
                        Modifier.padding(top = 8.dp, start = Spacing.gutter),
                    ) { showAllTracks = !showAllTracks }
                }
            }
        }
        if (playlists.isNotEmpty()) {
            item(key = "playlists") {
                Column {
                    ProfileHead(L("Public Playlists"), first = artists.isEmpty() && tracks.isEmpty(), sub = false)
                    LazyRow(contentPadding = PaddingValues(horizontal = Spacing.gutter), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(playlists, key = { it.id }) { p ->
                            MediaCard(CoverSource.of(p), p.name, L("By {name}", "name" to name), Modifier.width(120.dp), artSize = 120.dp) {
                                nav.push(Route.Playlist(p.id))
                            }
                        }
                    }
                }
            }
        }
        if (loading) item(key = "loading") { PlaceholderNote(L("Loading…")) }
        item(key = "bottom-pad") { Spacer(Modifier.height(24.dp)) }
    }

    BottomSheet(menuOpen, { menuOpen = false }) {
        AccountProfileMenu(name, onPhoto = pick, onSettings = { nav.push(Route.Settings) })
    }
    ContextMenuSheet(trackMenu) { trackMenu = null }
    NameDialogHost(nameDialog) { nameDialog = null }
}

@Composable
private fun ProfileHead(title: String, first: Boolean, sub: Boolean) {
    val theme = LocalTheme.current
    Column(Modifier.padding(horizontal = Spacing.gutter)) {
        Text(
            title, style = TextStyles.sectionDetail, color = theme.fg, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = if (first) 16.dp else 24.dp, bottom = if (sub) 4.dp else 12.dp).semantics { heading() },
        )
        if (sub) Text(L("Only visible to you"), style = TextStyles.subLine, color = theme.fgSub, modifier = Modifier.padding(bottom = 8.dp))
    }
}

/** The 7.4.1 hero: flat #4a4a4a fading into `--bg-base`, dark tokens on light themes. */
@Composable
private fun AccountProfileHero(name: String, userId: String?, playlistCount: Int, onAvatar: () -> Unit) {
    val top = LocalDetailTopInset.current
    val page = LocalTheme.current
    HeroIsland {
        val theme = LocalTheme.current
        Column(
            Modifier.fillMaxWidth().reportsHeroHeight()
                .background(Theme.Fixed.profileHero.color)
                .background(Brush.verticalGradient(listOf(page.page(0.0), page.bgBase)))
                .padding(top = Shell.topBar + top, start = Spacing.gutter, end = Spacing.gutter, bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            val label = L("Choose photo")
            AccountAvatar(
                userId, name, 128.dp, theme.sheet, 56.sp, theme.fg,
                Modifier.padding(bottom = 24.dp).shadow(12.dp, CircleShape)
                    .pressable(PressFeedback.Fade, onTap = onAvatar).semantics { contentDescription = label },
                initialWeight = FontWeight.ExtraBold,
            )
            Text(
                name, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.3).sp, color = theme.fg,
                maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() },
            )
            Text(AccountProfileLogic.playlistCount(playlistCount), style = TextStyles.subLine, color = theme.fgSub, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

/** The ⋯ sheet: initial disc header, Change photo, Settings. */
@Composable
private fun AccountProfileMenu(name: String, onPhoto: () -> Unit, onSettings: () -> Unit) {
    val theme = LocalTheme.current
    val close = LocalCloseSheet.current
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(bottom = 6.dp)
                .drawBehind { drawLine(theme.fg(0.1), Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) }
                .padding(top = 14.dp, start = 12.dp, end = 12.dp, bottom = 12.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(56.dp).background(Theme.Fixed.drawerAvatarFallback, CircleShape), contentAlignment = Alignment.Center) {
                Text(AccountProfileLogic.initial(name), fontSize = 22.sp, fontWeight = FontWeight.Bold, color = Theme.Fixed.white)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(name, style = TextStyles.barTitle, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(L("Profile"), style = TextStyles.subLine, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        MenuList(null, listOf(MenuItem(L("Change photo"), Icon.Photo, action = onPhoto), MenuItem(L("Settings"), Icon.Gear, action = onSettings))) { item ->
            close { item.action?.invoke() }
        }
    }
}
