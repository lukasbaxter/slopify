package com.lukasbaxter.slopify.android.features.account

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.core.model.HistoryPage
import com.lukasbaxter.slopify.android.core.model.HistoryStats
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.PressState
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.delay
import java.util.Locale

/** `.sf-section-head`: h2 24/700, description 14 `--fg-sub` one line. */
@Composable
internal fun AccountHistorySectionHead(title: String, description: String) {
    val theme = LocalTheme.current
    Column(Modifier.fillMaxWidth().padding(top = 28.dp, bottom = 12.dp).padding(horizontal = Spacing.gutter), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, fontSize = 24.sp, fontWeight = FontWeight.Bold, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
        Text(description, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
internal fun AccountHistoryEmpty() {
    val theme = LocalTheme.current
    Text(
        L("Not enough data to complete this list"), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgFaint,
        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(16.dp),
    )
}

/** `+N%` green / `-N%` red / `0%` grey, 12/700 on `--card`, radius 6, padding 1/6. */
@Composable
internal fun AccountHistoryDelta(pct: Int) {
    val theme = LocalTheme.current
    Text(
        if (pct > 0) "+$pct%" else "$pct%", fontSize = 12.sp, fontWeight = FontWeight.Bold,
        color = if (pct > 0) theme.green else if (pct < 0) Theme.Fixed.deltaDown else theme.fgSub,
        modifier = Modifier.background(theme.card, RoundedCornerShape(6.dp)).padding(vertical = 1.dp, horizontal = 6.dp),
    )
}

/** Press: scale .95 over 0.3 s. */
@Composable
private fun Modifier.accountCardPress(onClick: () -> Unit): Modifier {
    val press = remember { PressState() }
    val scale by animateFloatAsState(if (press.pressed) 0.95f else 1f, tween(300), label = "press")
    return graphicsLayer { scaleX = scale; scaleY = scale }.pressable(PressFeedback.None, state = press, onTap = onClick)
}

@Composable
private fun HistorySquare(source: CoverSource?, round: Boolean = false) {
    val theme = LocalTheme.current
    Box(Modifier.size(160.dp).clip(if (round) CircleShape else RoundedCornerShape(0.dp)).background(theme.card)) {
        if (source != null) {
            CoverImage(source, 160.dp, Modifier.fillMaxSize(), shape = if (round) CoverShape.Circle else CoverShape.Rounded(0.dp), placeholder = CoverPlaceholder.None)
        }
    }
}

@Composable
internal fun AccountHistoryTrackCard(index: Int, track: HistoryStats.TopTrack, locale: Locale, onOpen: () -> Unit, onArtist: () -> Unit) {
    val theme = LocalTheme.current
    Column(Modifier.width(160.dp)) {
        Column(Modifier.accountCardPress(onOpen), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            HistorySquare((track.albumId ?: track.id)?.let { CoverSource.AlbumArt(it, null) })
            Text("${index + 1}. ${track.name}", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = theme.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        // `{n} minutes • {n} streams • artist`, the artist a link when it has an id.
        val meta = buildAnnotatedString {
            append(AccountHistoryLogic.minutes(track.seconds, locale) + " • " + AccountHistoryLogic.streams(track.count, locale) + " • ")
            val artist = track.artist.orEmpty()
            if (track.artistId != null) {
                withLink(LinkAnnotation.Clickable("artist", TextLinkStyles(SpanStyle(color = theme.fgSub))) { onArtist() }) { append(artist) }
            } else append(artist)
        }
        Text(meta, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
internal fun AccountHistoryArtistCard(index: Int, artist: HistoryStats.TopArtist, locale: Locale, onOpen: () -> Unit) {
    val theme = LocalTheme.current
    Column(Modifier.width(160.dp).accountCardPress(onOpen), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val id = artist.artistId
        if (id != null) HistorySquare(CoverSource.ArtistArt(id, null), round = true)
        else Box(Modifier.size(160.dp).background(theme.card, CircleShape), contentAlignment = Alignment.Center) {
            Text(AccountProfileLogic.initial(artist.name), fontSize = 48.sp, color = theme.fgSub)
        }
        Text("${index + 1}. ${artist.name}", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = theme.fg, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        Text(
            AccountHistoryLogic.minutes(artist.seconds, locale) + " • " + AccountHistoryLogic.streams(artist.count, locale),
            fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
        )
    }
}

@Composable
internal fun AccountHistoryAlbumCard(index: Int, album: HistoryStats.TopAlbum, locale: Locale, onOpen: () -> Unit) {
    val theme = LocalTheme.current
    Column(Modifier.width(160.dp).accountCardPress(onOpen), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HistorySquare(album.albumId?.let { CoverSource.AlbumArt(it, null) })
        Text("${index + 1}. ${album.name}", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = theme.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(
            AccountHistoryLogic.minutes(album.seconds, locale) + " • " + AccountHistoryLogic.streams(album.count, locale),
            fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

/** One recent stream: 48 cover, title, `artist • album`, relative time, divider. Tap opens the album. */
@Composable
internal fun AccountHistoryRecentRow(entry: HistoryPage.Entry, onOpen: () -> Unit) {
    val theme = LocalTheme.current
    var now by remember { mutableDoubleStateOf(System.currentTimeMillis().toDouble()) }
    LaunchedEffect(entry.at) {
        while (true) {
            delay(30_000)
            now = System.currentTimeMillis().toDouble()
        }
    }
    Column(Modifier.fillMaxWidth().pressable(PressFeedback.Fade, onTap = onOpen)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            CoverImage(CoverSource.of(entry.track), 48.dp, Modifier.size(48.dp).background(theme.card), shape = CoverShape.Rounded(0.dp), placeholder = CoverPlaceholder.None)
            Column(Modifier.weight(1f)) {
                Text(entry.track.title, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(AccountHistoryLogic.recentSubtitle(entry.track), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(
                AccountHistoryLogic.fromNow((now - entry.at) / 1000), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub,
                maxLines = 1, modifier = Modifier.padding(start = 8.dp),
            )
        }
        Spacer(Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(theme.card))
    }
}

/** 24 ring: 3 `--card` with a `--green` quarter arc, 0.8 s linear spin. */
@Composable
internal fun AccountHistorySpinner(visible: Boolean, modifier: Modifier = Modifier) {
    val theme = LocalTheme.current
    val spin by rememberInfiniteTransition(label = "spin").animateFloat(0f, 360f, infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Restart), label = "spin")
    val card = theme.card
    val green = theme.green
    Canvas(modifier.size(24.dp).graphicsLayer { alpha = if (visible) 1f else 0f; rotationZ = spin }) {
        val w = 3.dp.toPx()
        val inset = w / 2
        val tl = androidx.compose.ui.geometry.Offset(inset, inset)
        val sz = androidx.compose.ui.geometry.Size(size.width - w, size.height - w)
        drawArc(card, 0f, 360f, false, tl, sz, style = Stroke(w))
        drawArc(green, -90f, 90f, false, tl, sz, style = Stroke(w))
    }
}
