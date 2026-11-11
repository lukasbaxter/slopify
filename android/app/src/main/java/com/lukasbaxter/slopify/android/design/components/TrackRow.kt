package com.lukasbaxter.slopify.android.design.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.LocalConnectivity
import com.lukasbaxter.slopify.android.design.LocalPlayer
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles

/** Lyric match line: `text` with the matched words at `matches` (index ranges into text). */
@Immutable
data class LyricSnippet(val text: String, val matches: List<IntRange> = emptyList())

/**
 * The shared track row (UI.md 5.4; ios TrackRow.swift), phone layout. Data-driven: the screen
 * passes state and callbacks; the row never plays, navigates or fetches (except its artwork).
 *
 * Variants: plain (album pages), `showArt` (playlists, Liked, search, Popular, recommended),
 * `number` (artist Popular: index column with the now-playing bars), `subtitle` override
 * (Popular play counts), downloaded mark, unavailable (offline and not downloaded: 40 %),
 * highlighted (opened from a link), lyric snippet (Liked "find" by lyrics). Swipe right adds the
 * track to the queue ([SwipeToQueueBox], uses [LocalPlayer]; off without one).
 *
 *     TrackRow(t, showArt = true, isCurrent = current == t.id, onTap = { play(i) }, onMore = { menu = t })
 */
@Composable
fun TrackRow(
    track: Track,
    modifier: Modifier = Modifier,
    showArt: Boolean = false,
    /** Popular list: 1-based number in a 20 index column. */
    number: Int? = null,
    /** This track is the player's current track (accent title). */
    isCurrent: Boolean = false,
    /** Current and audio playing (Popular shows the animated bars). */
    isPlaying: Boolean = false,
    isDownloaded: Boolean = false,
    isUnavailable: Boolean = false,
    isHighlighted: Boolean = false,
    /** Replaces the artist names (e.g. play count). */
    subtitle: String? = null,
    snippet: LyricSnippet? = null,
    onMore: (() -> Unit)? = null,
    /** Tap on the artwork (open the album). */
    onArt: (() -> Unit)? = null,
    /** Finger down: pre-warm the stream. */
    onTouchDown: (() -> Unit)? = null,
    onSnippet: (() -> Unit)? = null,
    onTap: () -> Unit = {},
) {
    val theme = LocalTheme.current
    val player = LocalPlayer.current
    val connectivity = LocalConnectivity.current
    SwipeToQueueBox(
        modifier.alpha(if (isUnavailable) 0.4f else 1f),
        enabled = player != null,
        // Asked when a swipe starts, so rows do not observe the offline state.
        queueable = {
            SwipeToQueue.canQueue(
                offline = connectivity?.offline?.value == true,
                downloaded = isDownloaded || player?.localFile?.invoke(track.id) != null,
            )
        },
        onQueue = {
            player?.addToQueue(listOf(track))
            ToastCenter.shared.show(L("Added to queue"))
        },
    ) {
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = Shell.trackRow)
                .then(if (isHighlighted) Modifier.background(theme.tintHi).border(1.dp, theme.tintPress) else Modifier)
                .pressable(PressFeedback.Row, onLongPress = onMore, onTouchDown = onTouchDown, onTap = onTap)
                .padding(vertical = 8.dp)
                .padding(start = Spacing.gutter, end = if (onMore != null) Spacing.gutter - 12.dp else Spacing.gutter),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (number != null) IndexColumn(number, isCurrent, isPlaying)
            if (showArt) {
                CoverImage(
                    CoverSource.of(track), 48.dp,
                    Modifier.size(48.dp).pressable(PressFeedback.None, onLongPress = onMore, onTap = onArt ?: onTap),
                    shape = CoverShape.Rounded(Radius.rowArt), placeholder = CoverPlaceholder.CardHover,
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(track.title, style = TextStyles.rowTitle, color = if (isCurrent) theme.accentInk else theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (isDownloaded) {
                        val label = L("Downloaded")
                        IconView(Icon.DownloadedMark, Modifier.semantics { contentDescription = label }, size = 12.dp, tint = theme.green)
                    }
                    Text(subtitle ?: artistLine(track), style = TextStyles.subLine, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (snippet != null) SnippetLine(snippet, onSnippet)
            }
            if (onMore != null) {
                val more = L("More options")
                Box(
                    Modifier.size(40.dp).pressable(PressFeedback.Fade, onTap = onMore).semantics { contentDescription = more },
                    contentAlignment = Alignment.Center,
                ) { IconView(Icon.Dots, size = 16.dp, tint = theme.fgSub) }
            }
        }
    }
}

/** "A, B" or the album artist. */
fun artistLine(t: Track): String {
    val names = t.artists.filter { it.isNotEmpty() }
    return if (names.isEmpty()) (if (t.albumArtist.isEmpty()) t.artist else t.albumArtist) else names.joinToString(", ")
}

@Composable
private fun IndexColumn(n: Int, isCurrent: Boolean, isPlaying: Boolean) {
    val theme = LocalTheme.current
    Box(Modifier.size(20.dp, 24.dp), contentAlignment = Alignment.Center) {
        if (isCurrent && isPlaying) NowPlayingBars()
        else Text("$n", fontSize = 16.sp, color = if (isCurrent) theme.accentInk else theme.fgSub, maxLines = 1)
    }
}

@Composable
private fun SnippetLine(s: LyricSnippet, onSnippet: (() -> Unit)?) {
    val theme = LocalTheme.current
    val text = buildAnnotatedString {
        append(s.text)
        for (r in s.matches) {
            val lo = r.first.coerceIn(0, s.text.length)
            val hi = (r.last + 1).coerceIn(lo, s.text.length)
            addStyle(SpanStyle(color = theme.fg, fontWeight = FontWeight.Medium), lo, hi)
        }
    }
    Row(
        Modifier.padding(top = 3.dp).then(if (onSnippet != null) Modifier.pressable(PressFeedback.None, onTap = onSnippet) else Modifier),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.height(15.dp).background(theme.fg(0.1), RoundedCornerShape(3.dp)).padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
            Text(L("Lyrics"), fontSize = 10.sp, fontWeight = FontWeight.SemiBold, color = theme.fgDim)
        }
        Text(text, fontSize = 12.sp, color = theme.fgDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A stand-in track for previews. */
internal fun previewTrack(title: String = "Paranoid Android", artist: String = "Radiohead", id: String = title) = Track(
    id = id, title = title, artist = artist, artists = listOf(artist), artistIds = emptyList(), albumId = "", album = "OK Computer",
    albumArtist = artist, trackNo = 2, discNo = 1, year = 1997, durationMs = 383000, codec = "FLAC",
)
