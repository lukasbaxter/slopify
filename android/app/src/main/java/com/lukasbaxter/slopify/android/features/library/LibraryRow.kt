package com.lukasbaxter.slopify.android.features.library

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.image.LikedCover
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles

/** What one Your Library row shows (UI.md 5.2.8). `entry == null` is Liked Songs. */
data class LibraryRowModel(
    val entry: LibraryEntry?,
    val subtitle: String,
    val pinned: Boolean,
    /** Every song kept on this device: the green mark. */
    val downloaded: Boolean = false,
    /** Offline + partly kept: `{have} of {total} downloaded • `. */
    val partial: String? = null,
    val folderOpen: Boolean = false,
) {
    val id: String get() = entry?.id ?: LIKED_ID
    val name: String get() = entry?.name ?: L("Liked Songs")
    val isChild: Boolean get() = entry?.parent != null

    companion object {
        const val LIKED_ID = "__liked__"
    }
}

object LibraryLayoutMetrics {
    /** 64 art + 8 + 8. */
    val listRow = 80.dp
    val gridGap = 16.dp
}

/** List row: 64 art (radius 3, circle for artists), 16 gap, title 16 + subtitle 13. */
@Composable
internal fun LibraryListRow(model: LibraryRowModel, modifier: Modifier = Modifier) {
    val theme = LocalTheme.current
    Row(
        modifier.fillMaxWidth().height(LibraryLayoutMetrics.listRow)
            .padding(vertical = 8.dp).padding(start = if (model.isChild) 20.dp else 0.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LibraryArt(model, 64.dp, Modifier.size(64.dp))
        Column(Modifier.weight(1f)) {
            Text(model.name, style = TextStyles.rowTitle, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            LibrarySubline(model)
        }
    }
}

/** Grid cell: square art the cell's width, title 14 up to 2 lines, subtitle 13. */
@Composable
internal fun LibraryGridCell(model: LibraryRowModel, modifier: Modifier = Modifier) {
    val theme = LocalTheme.current
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        LibraryArt(model, 180.dp, Modifier.fillMaxWidth().aspectRatio(1f))
        Column {
            Text(model.name, fontSize = 14.sp, lineHeight = (14 * 1.3).sp, color = theme.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            LibrarySubline(model)
        }
    }
}

/** `[pin] [mark | partial] subtitle`, 13 `--fg-sub`, one line. */
@Composable
private fun LibrarySubline(model: LibraryRowModel) {
    val theme = LocalTheme.current
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (model.pinned) {
            val label = L("Pinned")
            IconView(Icon.Pin, Modifier.semantics { contentDescription = label }, size = 13.dp, tint = theme.accentInk)
        }
        if (model.downloaded) {
            val label = L("Downloaded")
            IconView(Icon.DownloadedMark, Modifier.semantics { contentDescription = label }, size = 12.dp, tint = theme.green)
        }
        Text((model.partial ?: "") + model.subtitle, style = TextStyles.subLine, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Artwork per kind (UI.md 5.2.8). */
@Composable
internal fun LibraryArt(model: LibraryRowModel, side: Dp, modifier: Modifier = Modifier) {
    val theme = LocalTheme.current
    val e = model.entry
    val rounded = CoverShape.Rounded(Radius.rowArt)
    when {
        e == null -> LikedCover(modifier, radius = Radius.rowArt)
        e.kind == LibraryEntry.Kind.Playlist ->
            CoverImage(CoverSource.PlaylistArt(e.id, e.playlist?.cover), side, modifier, shape = rounded, placeholder = CoverPlaceholder.CardHover)
        e.kind == LibraryEntry.Kind.Album ->
            CoverImage(CoverSource.AlbumArt(e.id, e.album?.cover), side, modifier, shape = rounded, placeholder = CoverPlaceholder.CardHover)
        e.kind == LibraryEntry.Kind.Artist ->
            CoverImage(CoverSource.ArtistArt(e.id, e.artist?.image), side, modifier, shape = CoverShape.Circle, placeholder = CoverPlaceholder.CardHover)
        e.folderCover != null ->
            // TODO(lead): CoverSource.Folder has no cover hash cache-buster (`&c=`); a new picture may show late.
            CoverImage(CoverSource.Folder(e.id), side, modifier, shape = rounded, placeholder = CoverPlaceholder.CardHover)
        else -> Box(modifier.background(theme.cardHover, RoundedCornerShape(Radius.rowArt)), contentAlignment = Alignment.Center) {
            IconView(if (model.folderOpen) Icon.FolderOpen else Icon.Folder, size = 28.dp, tint = theme.fgDim)
        }
    }
}
