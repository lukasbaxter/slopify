package com.lukasbaxter.slopify.android.features.detail

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.CardGrid
import com.lukasbaxter.slopify.android.design.components.Chip
import com.lukasbaxter.slopify.android.design.components.MediaCard
import com.lukasbaxter.slopify.android.design.components.PlaceholderNote
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.RequestPill
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Spacing

/**
 * "Popular releases" row (`.releases .release`): 76 art radius 4, name 16, "{year} • {type}" 13
 * 3 below; missing releases dimmed with an inline Request pill and no row tap.
 */
@Composable
internal fun DetailReleaseRow(entry: DetailLogic.Entry, request: String?, onOpen: (String) -> Unit, onRequest: (DetailLogic.Entry) -> Unit) {
    val theme = LocalTheme.current
    val missing = entry.inLib == null
    val open = entry.inLib
    Row(
        Modifier.fillMaxWidth()
            .then(if (open != null) Modifier.pressable(PressFeedback.Fade) { onOpen(open) } else Modifier)
            .padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(76.dp).clip(RoundedCornerShape(Radius.art))
                .then(if (missing) Modifier.detailDimmed(grayscale = 0.4f, brightness = 0.75f) else Modifier),
        ) { ReleaseArt(entry) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(entry.title, fontSize = 16.sp, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(entry.subtitle, fontSize = 13.sp, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (missing) InlineRequestPill(request, enabled = entry.mbid != null) { onRequest(entry) }
    }
}

@Composable
private fun ReleaseArt(entry: DetailLogic.Entry) {
    val theme = LocalTheme.current
    val id = entry.inLib
    when {
        id != null -> CoverImage(CoverSource.AlbumArt(id, null), 76.dp, Modifier.fillMaxSize(), placeholder = CoverPlaceholder.Chip)
        entry.image != null -> CoverImage(CoverSource.Url(entry.image), 76.dp, Modifier.fillMaxSize(), placeholder = CoverPlaceholder.Chip)
        else -> Box(Modifier.fillMaxSize().background(theme.chip), contentAlignment = Alignment.Center) {
            IconView(Icon.MusicNote, size = 28.dp, tint = theme.fgFaint)
        }
    }
}

/** The Request pill inline in a release row: 13, padding 6/14, no shadow (`.release .card-request`). */
@Composable
private fun InlineRequestPill(state: String?, enabled: Boolean, onClick: () -> Unit) {
    val theme = LocalTheme.current
    val ui = DetailLogic.requestLabel(state)
    val hint = L("Download this release into your library")
    Text(
        L(ui.key), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = if (ui.busy) theme.fg else Color.Black,
        modifier = Modifier
            .alpha(if (!ui.busy && !enabled) 0.4f else 1f)
            .pressable(PressFeedback.Fade, enabled = !ui.busy && enabled, onTap = onClick)
            .semantics { contentDescription = "${L(ui.key)}. $hint" }
            .background(if (ui.busy) theme.tintPress else Color.White, CircleShape)
            .padding(vertical = 6.dp, horizontal = 14.dp),
    )
}

/** "Couldn’t load the full discography. Retry" (offline: "Not available offline."). */
@Composable
internal fun DetailDiscographyFailedNote(offline: Boolean, retry: () -> Unit) {
    val theme = LocalTheme.current
    if (offline) {
        PlaceholderNote(L("Not available offline."))
        return
    }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 24.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(L("Couldn’t load the full discography."), fontSize = 13.sp, color = theme.fgSub)
        Text(L("Retry"), fontSize = 13.sp, color = theme.fg, modifier = Modifier.pressable(PressFeedback.Fade, onTap = retry))
    }
}

/**
 * "Discography" after "See discography" (UI.md 6.3.7 §3): hint, the two filter groups in one
 * sideways line, a 2-column grid. Keeps its tallest height so filtering never moves the page.
 */
@Composable
internal fun DetailDiscographySection(
    model: DetailArtistModel,
    offline: Boolean,
    onOpen: (String) -> Unit,
    onRequest: (DetailLogic.Entry) -> Unit,
    onRetry: () -> Unit,
) {
    val theme = LocalTheme.current
    val density = LocalDensity.current
    var type by remember { mutableStateOf(DetailLogic.TypeFilter.All) }
    var lib by remember { mutableStateOf(DetailLogic.LibFilter.All) }
    var minHeight by remember { mutableIntStateOf(0) }
    val all = model.entries
    val shown = DetailLogic.filtered(all, type, lib)
    val types = DetailLogic.typeFilters(all)
    val have = all.count { it.inLib != null }
    val hint = when {
        model.discog == DetailDiscog.Loading -> L("Loading…")
        all.isEmpty() -> null
        else -> L("{have} of {total} in your library", "have" to have, "total" to all.size)
    }
    Column(
        Modifier.fillMaxWidth()
            .heightIn(min = with(density) { minHeight.toDp() })
            .onSizeChanged { if (it.height > minHeight) minHeight = it.height },
    ) {
        DetailSectionHeader(L("Discography"), hint)
        if (model.discog == DetailDiscog.Failed) DetailDiscographyFailedNote(offline, onRetry)
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Spacing.gutter).padding(bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            for (f in DetailLogic.LibFilter.entries) Chip(L(f.key), on = lib == f) { lib = f }
            if (types.size > 2) {
                Row(Modifier.padding(start = 4.dp).height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.width(1.dp).fillMaxHeight().background(theme.fg(0.2)))
                    Row(Modifier.padding(start = 11.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (f in types) Chip(L(f.key), on = type == f) { type = f }
                    }
                }
            }
        }
        CardGrid(shown) { e -> DiscographyCard(model, e, onOpen, onRequest) }
    }
}

@Composable
private fun DiscographyCard(model: DetailArtistModel, e: DetailLogic.Entry, onOpen: (String) -> Unit, onRequest: (DetailLogic.Entry) -> Unit) {
    val id = e.inLib
    if (id != null) {
        MediaCard(CoverSource.AlbumArt(id, null), e.title, e.subtitle) { onOpen(id) }
        return
    }
    val ui = DetailLogic.requestLabel(model.requestState(e))
    MediaCard(
        e.title, e.subtitle, missing = true,
        request = { RequestPill(L(ui.key), busy = ui.busy) { if (e.mbid != null) onRequest(e) } },
        onClick = {},
    ) {
        CoverImage(CoverSource.Url(e.image), 158.dp, Modifier.fillMaxSize(), shape = CoverShape.Rounded(Radius.card), placeholder = CoverPlaceholder.Note)
    }
}
