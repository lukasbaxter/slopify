package com.lukasbaxter.slopify.android.features.account

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
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
import com.lukasbaxter.slopify.android.core.api.history
import com.lukasbaxter.slopify.android.core.api.historyStats
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.HistoryPage
import com.lukasbaxter.slopify.android.core.model.HistoryStats
import com.lukasbaxter.slopify.android.core.storage.SharedPrefsStore
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.Chip
import com.lukasbaxter.slopify.android.design.components.ChipRow
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.LocalDetailTopInset
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.components.skeletonPulse
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

private sealed interface StatsState {
    data object Loading : StatsState
    data class Loaded(val stats: HistoryStats) : StatsState
    data class Failed(val error: String) : StatsState
}

/** Listening history / stats (UI.md 7.5; web components/History.jsx, phone layout; ios HistoryView.swift). */
@Composable
internal fun AccountHistoryScreen() {
    val app = LocalAppModel.current
    val account = app.account
    val nav = app.nav
    val theme = LocalTheme.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val store = remember { SharedPrefsStore(context) }
    val user by account.user.collectAsStateWithLifecycle()
    var range by remember { mutableStateOf(AccountHistoryLogic.Range.of(store.getString(AccountHistoryLogic.Range.STORAGE_KEY)) ?: AccountHistoryLogic.Range.Default) }
    val stats = remember { mutableStateMapOf<AccountHistoryLogic.Range, StatsState>() }
    var recent by remember { mutableStateOf<List<HistoryPage.Entry>?>(null) }
    var showAll by remember { mutableStateOf(false) }
    var loadingMore by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf(false) }
    val locale = Localizer.shared.locale
    val name = user?.name?.takeIf { it.isNotEmpty() } ?: L("You")

    LaunchedEffect(range) {
        val r = range
        val cur = stats[r]
        if (cur != null && cur != StatsState.Loading) return@LaunchedEffect
        stats[r] = StatsState.Loading
        try {
            stats[r] = StatsState.Loaded(account.api.historyStats(r.wire))
        } catch (e: CancellationException) {
            stats.remove(r)
            throw e
        } catch (e: Exception) {
            stats[r] = StatsState.Failed(e.message ?: e.toString())
        }
    }
    LaunchedEffect(Unit) {
        if (recent == null) recent = attempt { account.api.history(limit = 100) }?.items.orEmpty()
    }

    fun loadMore() {
        val last = recent?.lastOrNull() ?: return
        if (loadingMore || done) return
        loadingMore = true
        scope.launch {
            try {
                val page = attempt { account.api.history(limit = 100, before = last.at) } ?: return@launch
                if (page.items.isEmpty()) done = true else recent = recent.orEmpty() + page.items
            } finally {
                loadingMore = false
            }
        }
    }

    val current = stats[range]
    val loaded = (current as? StatsState.Loaded)?.stats
    // No hero on this page: the bar is `color-mix(--hero 55%, --page)` with the default --hero on
    // dark themes, plain `--page` on light ones (app.css:61).
    DetailScaffold(L("Listening history"), heroColor = if (theme.isLight) theme.rgb.page else Theme.Fixed.defaultHero) {
        item(key = "hero") { HistoryHero(name, user?.id, user?.name.orEmpty(), loaded) { nav.push(Route.Settings) } }
        item(key = "ranges") {
            ChipRow(Modifier.padding(bottom = 16.dp)) {
                for (r in AccountHistoryLogic.Range.entries) {
                    Chip(r.label(), on = r == range, small = true) {
                        range = r
                        store.putString(AccountHistoryLogic.Range.STORAGE_KEY, r.wire)
                    }
                }
            }
        }
        item(key = "stats") {
            Box(Modifier.padding(horizontal = Spacing.gutter)) {
                StatsBlock(current ?: StatsState.Loading, locale) { nav.push(Route.Settings) }
            }
        }
        if (loaded != null && loaded.connected) {
            sections(loaded, range, locale, nav::push)
            item(key = "recent-head") { AccountHistorySectionHead(L("Recent streams"), L("Your recently played tracks")) }
            recentList(recent, showAll, loadingMore, done, locale, onShowAll = { showAll = true }, onMore = ::loadMore) {
                nav.push(Route.Album(it.track.albumId))
            }
        }
    }
}

@Composable
private fun HistoryHero(name: String, userId: String?, rawName: String, s: HistoryStats?, onEdit: () -> Unit) {
    val theme = LocalTheme.current
    val top = LocalDetailTopInset.current
    val locale = Localizer.shared.locale
    Column(
        Modifier.fillMaxWidth()
            .background(Brush.verticalGradient(0f to theme.card, 0.7f to theme.card, 1f to theme.page))
            .padding(top = 24.dp + Shell.topBar + top, bottom = 24.dp, start = Spacing.gutter, end = Spacing.gutter),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        AccountAvatar(userId, name, 128.dp, theme.chip, 56.sp, theme.fg, initialWeight = FontWeight.ExtraBold)
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(name, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = theme.fg, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
            Text("@" + rawName.lowercase(), fontSize = 16.sp, color = theme.fgSub)
            if (s != null && s.connected) {
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(L("{n} streams", "n" to AccountHistoryLogic.number(s.total, locale)), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub)
                    if (s.spotify > 0) {
                        HeroDot()
                        Text(L("{n} from Spotify", "n" to AccountHistoryLogic.number(s.spotify, locale)), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub)
                    }
                    HeroDot()
                    Text(
                        L("Edit profile"), fontSize = 14.sp, fontWeight = FontWeight.Bold, color = theme.green,
                        modifier = Modifier.pressable(PressFeedback.Fade, onTap = onEdit),
                    )
                }
            }
        }
    }
}

@Composable
private fun HeroDot() {
    val theme = LocalTheme.current
    Box(Modifier.padding(horizontal = 8.dp).size(4.dp).background(theme.fgSub))
}

@Composable
private fun StatsGrid(count: Int, cell: @Composable (Int) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (row in (0 until count).chunked(2)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (i in row) Box(Modifier.weight(1f)) { cell(i) }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun StatsBlock(state: StatsState, locale: java.util.Locale, openSettings: () -> Unit) {
    val theme = LocalTheme.current
    when (state) {
        StatsState.Loading -> Box(Modifier.skeletonPulse().clearAndSetSemantics {}) {
            StatsGrid(6) { SkeletonCard() }
        }
        is StatsState.Failed -> Text(L("Could not load history: {error}", "error" to state.error), fontSize = 14.sp, color = theme.fgFaint)
        is StatsState.Loaded -> if (!state.stats.connected) {
            Box(contentAlignment = Alignment.Center) {
                Box(Modifier.blur(4.dp).clearAndSetSemantics {}) {
                    val labels = listOf("minutes streamed", "hours streamed", "streams")
                    StatsGrid(labels.size) { StatCard("?", L(labels[it]), null) }
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        L("Connect ListenBrainz under Settings › Scrobbling to see your streaming history"),
                        fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgFaint, textAlign = TextAlign.Center,
                    )
                    Box(
                        Modifier.padding(top = 8.dp).pressable(PressFeedback.Fade, onTap = openSettings)
                            .background(theme.fg, CircleShape).heightIn(min = 32.dp).padding(horizontal = 16.dp),
                        contentAlignment = Alignment.Center,
                    ) { Text(L("Open settings"), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = theme.onFg) }
                }
            }
        } else {
            val cards = AccountHistoryLogic.cards(state.stats)
            StatsGrid(cards.size) {
                val c = cards[it]
                StatCard(AccountHistoryLogic.number(c.value, locale), L(c.label), AccountHistoryLogic.delta(c.value, c.before))
            }
        }
    }
}

@Composable
private fun SkeletonCard() {
    val theme = LocalTheme.current
    BoxWithConstraints {
        val w = maxWidth
        Column {
            Box(Modifier.height(36.dp)) { Box(Modifier.width(w * 0.5f).height(28.dp).background(theme.card, CircleShape)) }
            Box(Modifier.width(w * 0.7f).height(16.dp).background(theme.card, CircleShape))
        }
    }
}

@Composable
private fun StatCard(value: String, label: String, delta: Int?) {
    val theme = LocalTheme.current
    Column(Modifier.semantics(mergeDescendants = true) {}) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(value, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = theme.fg, maxLines = 1)
            if (delta != null) AccountHistoryDelta(delta)
        }
        Text(label, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

// sections (7.5.5)

private fun LazyListScope.sections(s: HistoryStats, range: AccountHistoryLogic.Range, locale: java.util.Locale, push: (Route) -> Unit) {
    fun desc(withRange: String, bare: String) = AccountHistoryLogic.description(withRange, bare, range)

    item(key = "genres") {
        val theme = LocalTheme.current
        Column {
            AccountHistorySectionHead(L("Top genres"), desc("Your top genres {range}", "Your top genres"))
            if (s.topGenres.isEmpty()) AccountHistoryEmpty() else {
                LazyRow(contentPadding = PaddingValues(start = Spacing.gutter, end = Spacing.gutter, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    itemsIndexed(s.topGenres, key = { i, g -> "$i-${g.id}" }) { _, g ->
                        Text(
                            g.name.lowercase(), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fg,
                            modifier = Modifier.background(theme.card, CircleShape).padding(vertical = 8.dp, horizontal = 16.dp),
                        )
                    }
                }
            }
        }
    }
    item(key = "tracks") {
        Column {
            AccountHistorySectionHead(L("Top tracks"), desc("Your top tracks {range}", "Your top tracks"))
            Carousel(s.topTracks, 276) { i, t ->
                AccountHistoryTrackCard(i, t, locale, onOpen = { t.albumId?.let { push(Route.Album(it)) } }, onArtist = { t.artistId?.let { push(Route.Artist(it)) } })
            }
        }
    }
    item(key = "artists") {
        Column {
            AccountHistorySectionHead(L("Top artists"), desc("Your top artists {range}", "Your top artists"))
            Carousel(s.topArtists, 262) { i, a -> AccountHistoryArtistCard(i, a, locale) { a.artistId?.let { push(Route.Artist(it)) } } }
        }
    }
    item(key = "albums") {
        Column {
            AccountHistorySectionHead(L("Top albums"), desc("Your top albums {range}", "Your top albums"))
            Carousel(s.topAlbums, 255) { i, a -> AccountHistoryAlbumCard(i, a, locale) { a.albumId?.let { push(Route.Album(it)) } } }
        }
    }
    item(key = "per-day") {
        Column {
            AccountHistorySectionHead(L("Streams and minutes streamed per day"), desc("Your listening over time {range}", "Your listening over time"))
            val pts = AccountHistoryLogic.buckets(s.perDay, locale)
            val (avgStreams, avgMinutes) = AccountHistoryLogic.averages(s)
            Column(Modifier.padding(horizontal = Spacing.gutter), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AvgCard(AccountHistoryLogic.number(avgStreams, locale), L("average streams per day"), Modifier.weight(1f))
                    AvgCard(AccountHistoryLogic.number(avgMinutes, locale), L("average minutes per day"), Modifier.weight(1f))
                }
                AccountHistoryLineChart(L("Daily"), pts)
                AccountHistoryLineChart(L("Cumulative"), AccountHistoryLogic.cumulative(pts))
            }
        }
    }
    item(key = "clocks") {
        val theme = LocalTheme.current
        Column {
            AccountHistorySectionHead(
                L("Listening clocks"),
                desc("Your listening habits throughout the day {range}", "Your listening habits throughout the day"),
            )
            Column(Modifier.padding(horizontal = Spacing.gutter), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AccountHistoryClock(s.byHour) { AccountHistoryLogic.streams(it.toInt(), locale) }
                Text(L("streams"), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub)
                val secs = s.byHourSeconds
                AccountHistoryClock(secs ?: s.byHour) { v -> if (secs != null) AccountHistoryLogic.hm(v) else AccountHistoryLogic.streams(v.toInt(), locale) }
                Text(L("minutes streamed"), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub)
            }
        }
    }
}

@Composable
private fun <T> Carousel(items: List<T>, height: Int, cell: @Composable (Int, T) -> Unit) {
    if (items.isEmpty()) { AccountHistoryEmpty(); return }
    LazyRow(contentPadding = PaddingValues(horizontal = Spacing.gutter), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        itemsIndexed(items) { i, t -> Box(Modifier.width(160.dp).height(height.dp)) { cell(i, t) } }
    }
}

@Composable
private fun AvgCard(value: String, label: String, modifier: Modifier) {
    val theme = LocalTheme.current
    Column(modifier.background(theme.card, RoundedCornerShape(12.dp)).padding(vertical = 14.dp, horizontal = 16.dp).semantics(mergeDescendants = true) {}) {
        Text(value, fontSize = 20.sp, fontWeight = FontWeight.Bold, color = theme.green)
        Text(label, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = theme.fg)
    }
}

// recent streams

private fun LazyListScope.recentList(
    recent: List<HistoryPage.Entry>?,
    showAll: Boolean,
    loadingMore: Boolean,
    done: Boolean,
    locale: java.util.Locale,
    onShowAll: () -> Unit,
    onMore: () -> Unit,
    onOpen: (HistoryPage.Entry) -> Unit,
) {
    if (recent == null) {
        item(key = "recent-skeleton") {
            val theme = LocalTheme.current
            Column(Modifier.padding(horizontal = Spacing.gutter).skeletonPulse().clearAndSetSemantics {}, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                repeat(4) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(48.dp).background(theme.card, RoundedCornerShape(8.dp)))
                        Box(Modifier.weight(1f)) { Box(Modifier.widthIn(max = 240.dp).fillMaxWidth().height(16.dp).background(theme.card, CircleShape)) }
                        Box(Modifier.width(64.dp).height(16.dp).background(theme.card, CircleShape))
                    }
                }
            }
        }
        return
    }
    if (recent.isEmpty()) {
        item(key = "recent-empty") {
            val theme = LocalTheme.current
            Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                IconView(Icon.HistoryMusicOff, size = 48.dp, tint = theme.fgFaint)
                Text(L("Looks like you don't have any recent streams"), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = theme.fgSub)
            }
        }
        return
    }
    val rows = if (showAll) recent else recent.take(8)
    val groups = AccountHistoryLogic.groupByDay(rows, { it.at }, locale)
    var n = 0
    for (g in groups) {
        val gi = n
        item(key = "day-$gi") {
            Text(g.day, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = LocalTheme.current.fgSub, modifier = Modifier.padding(horizontal = Spacing.gutter).padding(vertical = 8.dp))
        }
        for (e in g.rows) {
            val ri = n++
            item(key = "recent-$ri") {
                Box(Modifier.padding(horizontal = Spacing.gutter)) { AccountHistoryRecentRow(e) { onOpen(e) } }
            }
        }
    }
    if (!showAll && recent.size > 8) {
        item(key = "show-all") {
            Text(
                L("show all").uppercase(), fontSize = 14.sp, fontWeight = FontWeight.Bold, color = LocalTheme.current.fgFaint,
                modifier = Modifier.padding(horizontal = Spacing.gutter).pressable(PressFeedback.Fade, onTap = onShowAll).padding(vertical = 12.dp),
            )
        }
    }
    if (showAll && !done) {
        item(key = "more-${recent.size}") {
            LaunchedEffect(recent.size) { onMore() }
            Box(Modifier.fillMaxWidth().height(48.dp), contentAlignment = Alignment.Center) { AccountHistorySpinner(loadingMore) }
        }
    }
    if (showAll && done) {
        item(key = "no-more") {
            Text(
                L("No streams to load!"), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = LocalTheme.current.fgFaint,
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(16.dp),
            )
        }
    }
}
