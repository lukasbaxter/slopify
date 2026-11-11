package com.lukasbaxter.slopify.android.features.account

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.DownloadScope
import com.lukasbaxter.slopify.android.core.model.DownloadsPage
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.Chip
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Drawer › Downloads (UI.md 5.9; web components/Downloads.jsx; ios DownloadsView.swift): albums
 * requested through Slopify and where each one is. Polls every 5 s while open and the app is
 * in front.
 */
@Composable
internal fun AccountDownloadsScreen(source: AccountDownloadsSource? = null) {
    val app = LocalAppModel.current
    val nav = app.nav
    val scope = rememberCoroutineScope()
    val model = remember { AccountDownloadsModel(source ?: AccountServerDownloadsSource(app.account.api)) }
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(model, state.scope) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                model.load()
                delay(5_000)
            }
        }
    }
    // Relative times refresh every 15 s.
    var now by remember { mutableDoubleStateOf(System.currentTimeMillis().toDouble()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(15_000)
            now = System.currentTimeMillis().toDouble()
        }
    }
    LaunchedEffect(state.data) { now = System.currentTimeMillis().toDouble() }

    fun play(d: DownloadsPage.Item) {
        val id = d.libraryAlbumId ?: return
        scope.launch {
            val tracks = attempt { model.source.albumTracks(id) }
            if (!tracks.isNullOrEmpty()) app.player.play(tracks, startAt = 0, context = "album:$id")
        }
    }

    DetailScaffold(L("Downloads")) {
        item(key = "head") { DownloadsHead(state, now, model::setScope) }
        val data = state.data
        if (data != null) {
            if (data.items.isEmpty()) item(key = "empty") { DownloadsEmpty(state.scope) }
            for (s in AccountDownloadsLogic.sections) {
                val list = AccountDownloadsLogic.shown(data.items, s.state)
                if (list.isEmpty()) continue
                val count = data.items.count { it.state == s.state }
                item(key = "sec-" + s.state) { DownloadsSectionHead(s, count, data.stuckAfterMs) }
                for (d in list) {
                    item(key = "row-${s.state}-${d.id}") {
                        Box(Modifier.padding(horizontal = Spacing.gutter)) {
                            DownloadsRow(
                                d, data.watcher, now, state.retrying == d.id,
                                onOpen = { d.libraryAlbumId?.let { nav.push(Route.Album(it)) } },
                                onPlay = { play(d) },
                                onRetry = { scope.launch { ToastCenter.shared.show(model.retry(d)) } },
                            )
                        }
                    }
                }
                item(key = "sec-end-" + s.state) { Box(Modifier.height(8.dp)) }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DownloadsHead(state: AccountDownloadsModel.State, now: Double, setScope: (DownloadScope) -> Unit) {
    val theme = LocalTheme.current
    Column(Modifier.padding(horizontal = Spacing.gutter)) {
        Text(L("Downloads"), style = TextStyles.pageTitle, color = theme.fg, modifier = Modifier.padding(top = 8.dp).semantics { heading() })
        Column(Modifier.padding(top = 4.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip(L("Yours"), on = state.scope == DownloadScope.Mine) { setScope(DownloadScope.Mine) }
                Chip(L("Everyone"), on = state.scope == DownloadScope.All) { setScope(DownloadScope.All) }
            }
            val summary = AccountDownloadsLogic.summary(state.data?.items.orEmpty())
            if (summary.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    for ((st, text) in summary) {
                        val c = when (st) {
                            "downloading" -> theme.green
                            "stuck", "failed" -> theme.danger
                            else -> theme.fgDim
                        }
                        Text(text, style = TextStyles.small, color = c)
                    }
                }
            }
        }
        AccountDownloadsLogic.watcherLine(state.data?.watcher, now)?.let {
            Text(it, style = TextStyles.subLine, color = theme.fgDim, modifier = Modifier.padding(bottom = 10.dp))
        }
        state.error?.let { e ->
            Text(
                e, style = TextStyles.small, color = theme.fgDim,
                modifier = Modifier.padding(vertical = 16.dp).fillMaxWidth()
                    .background(theme.field, RoundedCornerShape(8.dp)).padding(vertical = 12.dp, horizontal = 16.dp),
            )
        }
        if (state.data == null && state.error == null) {
            Text(L("Loading…"), style = TextStyles.body, color = theme.fgDim, modifier = Modifier.padding(vertical = 32.dp))
        }
    }
}

@Composable
private fun DownloadsEmpty(scope: DownloadScope) {
    val theme = LocalTheme.current
    Column(Modifier.padding(horizontal = Spacing.gutter, vertical = 32.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            if (scope == DownloadScope.Mine) L("Nothing requested yet") else L("The queue is empty"),
            fontSize = 18.sp, fontWeight = FontWeight.Bold, color = theme.fg,
        )
        Text(
            if (scope == DownloadScope.Mine) L("Request an album from an artist page, or make a generated playlist: songs it suggests that you do not have yet show up here while they download.")
            else L("Nobody is downloading anything right now."),
            style = TextStyles.body, color = theme.fgDim,
        )
    }
}

@Composable
private fun DownloadsSectionHead(s: AccountDownloadsLogic.Section, count: Int, stuckAfterMs: Double?) {
    val theme = LocalTheme.current
    Column(Modifier.padding(start = Spacing.gutter, end = Spacing.gutter, top = 24.dp)) {
        Row(Modifier.padding(bottom = 8.dp).semantics(mergeDescendants = true) { heading() }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(L(s.heading), style = TextStyles.sectionArtist, color = theme.fg, modifier = Modifier.alignByBaseline())
            Text("$count", style = TextStyles.small, color = theme.fgDim, modifier = Modifier.alignByBaseline())
        }
        if (s.state == "stuck") {
            Text(
                L(
                    "No new song for {time} or more. Soulseek keeps looking; if nothing turns up it moves to Failed with the reason. Retry also tries torrents.",
                    "time" to AccountDownloadsLogic.duration(stuckAfterMs ?: 86_400_000.0),
                ),
                style = TextStyles.subLine, color = theme.fgDim, modifier = Modifier.padding(bottom = 8.dp),
            )
        }
    }
}

@Composable
private fun DownloadsRow(
    item: DownloadsPage.Item,
    watcher: DownloadsPage.Watcher?,
    now: Double,
    retrying: Boolean,
    onOpen: () -> Unit,
    onPlay: () -> Unit,
    onRetry: () -> Unit,
) {
    val theme = LocalTheme.current
    val status = AccountDownloadsLogic.statusLine(item, watcher, now)
    Column(Modifier.fillMaxWidth().padding(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
            CoverImage(CoverSource.Url(item.image), 48.dp, Modifier.size(48.dp), shape = CoverShape.Rounded(Radius.art), placeholder = CoverPlaceholder.Chip)
            Column(
                Modifier.weight(1f).then(if (item.libraryAlbumId != null) Modifier.pressable(PressFeedback.None, onTap = onOpen) else Modifier),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(item.title, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(AccountDownloadsLogic.meta(item), style = TextStyles.small, color = theme.fgDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                item.note?.takeIf { it.isNotEmpty() }?.let { Text(it, style = TextStyles.subLine, color = theme.fgDim) }
            }
        }
        AccountDownloadsLogic.progress(item)?.let { p ->
            val fill by animateFloatAsState(p.toFloat(), tween(600, easing = Motion.easeCurve), label = "progress")
            val barColor = when (item.state) {
                "done" -> theme.fgDim
                "stuck" -> theme.danger
                else -> theme.green
            }
            Box(Modifier.padding(top = 8.dp).fillMaxWidth().height(4.dp).background(theme.fg(0.14), CircleShape)) {
                Box(Modifier.fillMaxWidth(fill).height(4.dp).background(barColor, CircleShape))
            }
        }
        Row(Modifier.padding(top = 6.dp).heightIn(min = 28.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(status.text, style = TextStyles.subLine, color = if (status.warn) theme.danger else theme.fgDim, modifier = Modifier.weight(1f))
            when (AccountDownloadsLogic.action(item)) {
                AccountDownloadsLogic.Action.Play -> DownloadsPill(L("Play"), disabled = false, onPlay)
                AccountDownloadsLogic.Action.Retry -> DownloadsPill(if (retrying) L("Retrying…") else L("Retry"), disabled = retrying, onRetry)
                null -> Unit
            }
        }
    }
}

@Composable
private fun DownloadsPill(title: String, disabled: Boolean, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Text(
        title, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = theme.fg,
        modifier = Modifier.alpha(if (disabled) 0.5f else 1f)
            .pressable(PressFeedback.Fade, enabled = !disabled, onTap = onClick)
            .border(1.dp, theme.fgDim, CircleShape)
            .padding(vertical = 5.dp, horizontal = 14.dp),
    )
}
