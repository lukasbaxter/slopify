package com.lukasbaxter.slopify.android.features.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.api.requestAlbum
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.components.CardGrid
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.ErrorBanner
import com.lukasbaxter.slopify.android.design.components.MediaCard
import com.lukasbaxter.slopify.android.design.components.PlaceholderNote
import com.lukasbaxter.slopify.android.design.components.RequestPill
import com.lukasbaxter.slopify.android.design.components.pageBanner
import com.lukasbaxter.slopify.android.design.components.reportsHeroHeight
import com.lukasbaxter.slopify.android.design.components.LocalDetailTopInset
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.theme.HeroIsland
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/**
 * Release Radar page (UI.md 6.3.9; ios ReleaseRadarView.swift): new releases (90 days) from the
 * artists you like, as a two-column grid. Owned releases open their album; missing ones carry a
 * Request pill and link the artist. Paints the kept list at once, then asks the server again.
 */
@Composable
internal fun HomeReleaseRadarPage() {
    val app = LocalAppModel.current
    val nav = app.nav
    val theme = LocalTheme.current
    val store = HomeStore.shared
    val st by store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    /** album_id -> this client's request state (`queued`, `exists`, `error`). */
    val requesting = remember { mutableStateMapOf<String, String>() }
    var error by remember { mutableStateOf<String?>(null) }
    val hero = remember { ColorMath.heroTint(Theme.Fixed.radarHero) }

    LaunchedEffect(Unit) {
        store.reloadRadar(app.account.api)
        val s = store.state.value
        if (s.radarError != null && s.data.radar.isEmpty()) error = s.radarError
    }

    fun request(r: Release) {
        val id = r.albumId ?: return
        requesting[id] = "queued"
        scope.launch {
            try {
                val status = app.account.api.requestAlbum(id) ?: "queued"
                requesting[id] = status
                store.setRequestStatus(id, status)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                requesting[id] = "error"
                error = HomeStore.message(e)
            }
        }
    }

    val rels = st.data.radar
    val known = st.radarLoaded || rels.isNotEmpty()
    DetailScaffold(L("Release Radar"), heroColor = hero) {
        item(key = "hero") {
            RadarHero(
                hero,
                if (known) L("{n} new releases from the artists you like • last 90 days", "n" to rels.size)
                else L("Checking the last 90 days for the artists you like…"),
            )
        }
        item(key = "band") {
            // `.actions.slim`: no buttons, only the colour band behind the first rows.
            val top = hero.colorMix(0.7, theme.rgb.page).color
            val base = theme.bgBase
            Spacer(
                Modifier.fillMaxWidth().height(8.dp).drawBehind {
                    val h = size.height + 230.dp.toPx()
                    drawRect(Brush.verticalGradient(listOf(top, base), startY = 0f, endY = h), size = Size(size.width, h))
                },
            )
        }
        item(key = "body") {
            Column(Modifier.padding(top = 8.dp)) {
                error?.let { ErrorBanner(it, Modifier.pageBanner()) { error = null } }
                if (st.radarLoaded && rels.isEmpty()) {
                    PlaceholderNote(L("Nothing new from your artists in the last 90 days."))
                } else if (rels.isNotEmpty()) {
                    CardGrid(rels) { r ->
                        val lib = r.inLibrary
                        if (lib != null) {
                            MediaCard(CoverSource.AlbumArt(lib, null), r.title, HomeLogic.radarOwnedSub(r), artSize = 175.dp) {
                                nav.push(Route.Album(lib))
                            }
                        } else {
                            val ui = HomeLogic.requestUi(HomeLogic.requestState(r.requestStatus, r.albumId?.let { requesting[it] }))
                            RadarMissingCard(r, request = { RequestPill(ui.label, busy = ui.busy) { request(r) } }) {
                                r.artistId?.let { nav.push(Route.Artist(it)) }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** `.hero.browse-hero` without a cover: padding `56 + inset` 16 8, 24/700 title, 13 meta at 70 % white. */
@Composable
private fun RadarHero(color: RGB, meta: String) {
    val topInset = LocalDetailTopInset.current
    HeroIsland {
        val theme = LocalTheme.current
        Column(
            Modifier.fillMaxWidth().reportsHeroHeight()
                .background(color.color)
                .background(Brush.verticalGradient(listOf(theme.page(0.0), theme.page(0.3))))
                .padding(top = Shell.topBar + topInset, start = Spacing.gutter, end = Spacing.gutter, bottom = 8.dp),
        ) {
            Text(L("Release Radar"), style = TextStyles.pageTitle, color = theme.fg, modifier = Modifier.padding(bottom = 6.dp))
            Text(meta, style = TextStyles.subLine, color = theme.fg.copy(alpha = 0.7f))
        }
    }
}

/**
 * `.card.missing` on the Radar page: dimmed art with a centred Request pill; the subtitle's
 * artist name links to the artist. The card itself does not open anything (Library.jsx).
 */
@Composable
private fun RadarMissingCard(release: Release, request: @Composable () -> Unit, openArtist: () -> Unit) {
    val theme = LocalTheme.current
    Column(Modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().aspectRatio(1f), contentAlignment = Alignment.Center) {
            Box(Modifier.matchParentSize().clip(RoundedCornerShape(Radius.card)).radarMissingArt()) {
                CoverImage(CoverSource.Url(release.image), 175.dp, Modifier.fillMaxSize(), shape = CoverShape.Rounded(Radius.card), placeholder = CoverPlaceholder.CardHover, fade = false)
            }
            request()
        }
        Text(
            release.title, style = TextStyles.cardTitlePage, color = theme.fgDim, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        )
        val sub = buildAnnotatedString {
            val name = release.artistName ?: ""
            if (release.artistId != null) {
                withLink(LinkAnnotation.Clickable("artist", TextLinkStyles(SpanStyle(color = theme.fgDim))) { openArtist() }) { append(name) }
            } else append(name)
            append(HomeLogic.radarMissingTail(release))
        }
        Text(
            sub, style = TextStyles.cardSub, color = theme.fgDim, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
        )
    }
}

/**
 * `grayscale(.6) brightness(.55)` over the art.
 * TODO(lead): MediaCard's private `missingArt()` as a public design modifier, so this copy can go.
 */
private fun Modifier.radarMissingArt(): Modifier = drawWithContent {
    val m = ColorMatrix().apply { setToSaturation(0.4f) }
    val v = m.values
    for (i in 0 until 3) for (j in 0 until 4) v[i * 5 + j] *= 0.55f
    val paint = Paint().apply { colorFilter = ColorFilter.colorMatrix(ColorMatrix(v)) }
    drawIntoCanvas { c ->
        c.saveLayer(Rect(0f, 0f, size.width, size.height), paint)
        drawContent()
        c.restore()
    }
}
