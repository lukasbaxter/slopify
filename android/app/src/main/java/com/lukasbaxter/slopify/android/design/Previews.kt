package com.lukasbaxter.slopify.android.design

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.lukasbaxter.slopify.android.core.model.Format
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.components.ActionRow
import com.lukasbaxter.slopify.android.design.components.BigPlayButton
import com.lukasbaxter.slopify.android.design.components.CardStyle
import com.lukasbaxter.slopify.android.design.components.Chip
import com.lukasbaxter.slopify.android.design.components.ChipRow
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.ErrorBanner
import com.lukasbaxter.slopify.android.design.components.FollowPill
import com.lukasbaxter.slopify.android.design.components.HeroHeader
import com.lukasbaxter.slopify.android.design.components.IconButton
import com.lukasbaxter.slopify.android.design.components.LyricSnippet
import com.lukasbaxter.slopify.android.design.components.Marquee
import com.lukasbaxter.slopify.android.design.components.MediaCard
import com.lukasbaxter.slopify.android.design.components.PlaceholderNote
import com.lukasbaxter.slopify.android.design.components.PrimaryButton
import com.lukasbaxter.slopify.android.design.components.QualityBadge
import com.lukasbaxter.slopify.android.design.components.RequestPill
import com.lukasbaxter.slopify.android.design.components.SecondaryButton
import com.lukasbaxter.slopify.android.design.components.SectionHeader
import com.lukasbaxter.slopify.android.design.components.SectionStyle
import com.lukasbaxter.slopify.android.design.components.Shelf
import com.lukasbaxter.slopify.android.design.components.SkeletonRows
import com.lukasbaxter.slopify.android.design.components.TrackRow
import com.lukasbaxter.slopify.android.design.components.previewTrack
import com.lukasbaxter.slopify.android.design.icons.DownloadGlyph
import com.lukasbaxter.slopify.android.design.icons.DownloadGlyphState
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.icons.RepeatGlyph
import com.lukasbaxter.slopify.android.design.icons.RepeatGlyphMode
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyph
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyphMode
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.image.LikedCover
import com.lukasbaxter.slopify.android.design.overlay.LyricSyncPill
import com.lukasbaxter.slopify.android.design.overlay.OfflinePill
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.overlay.ToastView
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.sheets.MenuList
import com.lukasbaxter.slopify.android.design.theme.LocalTheme

// Android Studio previews of the shared views (no server: covers show their placeholders).

@OptIn(ExperimentalLayoutApi::class)
@Preview(name = "Icons", widthDp = 393, heightDp = 640)
@Composable
private fun IconsPreview() = SlopifyTheme {
    FlowRow(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (i in Icon.entries) IconView(i, size = 24.dp)
        RepeatGlyph(RepeatGlyphMode.One, size = 24.dp)
        ShuffleGlyph(ShuffleGlyphMode.Smart, size = 24.dp)
        DownloadGlyph(DownloadGlyphState.Busy(0.4))
        DownloadGlyph(DownloadGlyphState.Done, tint = LocalTheme.current.seekAccent)
    }
}

@Preview(name = "Track rows", widthDp = 393)
@Composable
private fun TrackRowsPreview() = SlopifyTheme {
    Column {
        TrackRow(previewTrack(), onMore = {})
        TrackRow(previewTrack("Karma Police"), showArt = true, isCurrent = true, onMore = {})
        TrackRow(previewTrack("No Surprises"), showArt = true, isDownloaded = true, onMore = {})
        TrackRow(previewTrack("Let Down"), number = 1, isCurrent = true, isPlaying = true, subtitle = "1,234", onMore = {})
        TrackRow(previewTrack("Lucky"), showArt = true, isUnavailable = true, onMore = {})
        TrackRow(previewTrack("Exit Music"), showArt = true, isHighlighted = true, onMore = {})
        TrackRow(previewTrack("Climbing Up the Walls"), showArt = true, snippet = LyricSnippet("and either way you turn", listOf(4..9)), onMore = {})
        SkeletonRows(count = 2, art = true)
    }
}

@Preview(name = "Cards and buttons", widthDp = 393)
@Composable
private fun CardsPreview() = SlopifyTheme {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionHeader("Jump back in", style = SectionStyle.Home)
        Shelf((0 until 4).toList(), style = CardStyle.Home) { MediaCard(CoverSource.Url(null), "Album $it", "Artist", style = CardStyle.Home) {} }
        SectionHeader("Popular releases", style = SectionStyle.Artist, showAll = {})
        Shelf((0 until 4).toList()) {
            MediaCard(CoverSource.Url(null), "Release $it with a long name", "2020 • Album", missing = it == 1, request = { RequestPill("Request") {} }) {}
        }
        ChipRow { Chip("All", on = true) {}; Chip("Music") {}; Chip("Playlists", small = true) {} }
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton("Cancel") {}; PrimaryButton("Create") {}; FollowPill(false) {}; FollowPill(true) {}
        }
        Row(Modifier.padding(horizontal = 16.dp)) {
            IconButton(Icon.Heart, "Like") {}
            IconButton(Icon.HeartFilled, "Liked", on = true) {}
            Spacer(Modifier.width(16.dp))
            BigPlayButton(playing = false) {}
        }
        ErrorBanner("Not saved: network error")
        PlaceholderNote("Nothing here yet")
        Marquee("A very long song title that does not fit in this narrow box at all", Modifier.width(200.dp).padding(horizontal = 16.dp))
        QualityBadge(Format("FLAC", true, null, 96000.0, 24.0), Modifier.padding(horizontal = 16.dp))
    }
}

@Preview(name = "Detail page", widthDp = 393, heightDp = 800)
@Composable
private fun DetailPreview() = SlopifyTheme {
    val hero = ColorMath.phoneHero("#1e3264")!!
    DetailScaffold("OK Computer", heroColor = hero, onBack = {}) {
        item { HeroHeader(hero, "OK Computer", cover = { LikedCover(Modifier.size(250.dp)) }) { androidx.compose.material3.Text("Album • 1997") } }
        item {
            ActionRow(hero, leading = { IconButton(Icon.Heart, "Save") {}; IconButton(Icon.Dots24, "More") {} }) {
                IconButton("Shuffle", onClick = {}) { ShuffleGlyph(ShuffleGlyphMode.Off, size = 24.dp, tint = it) }
                BigPlayButton(playing = false) {}
            }
        }
        items(20) { TrackRow(previewTrack("Track $it"), onMore = {}) }
    }
}

@Preview(name = "Menu, toasts", widthDp = 393)
@Composable
private fun MenuPreview() = SlopifyTheme {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        MenuList(
            null,
            listOf(
                MenuItem("Add to queue", Icon.Queue, offline = true), MenuItem("Add to playlist", Icon.Plus), MenuItem.separator,
                MenuItem.heading("Quality"), MenuItem("Original", checked = true), MenuItem("Syncing Lyrics…", Icon.Lyrics, disabled = true),
                MenuItem("Delete", Icon.Trash, danger = true),
            ),
        ) {}
        ToastView("Added to Liked Songs")
        LyricSyncPill(ToastCenter.LyricSync("Paranoid Android", "Aligning", 2))
        OfflinePill()
    }
}
