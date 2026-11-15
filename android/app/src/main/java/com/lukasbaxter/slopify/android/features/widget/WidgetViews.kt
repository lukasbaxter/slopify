package com.lukasbaxter.slopify.android.features.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.lukasbaxter.slopify.android.R
import com.lukasbaxter.slopify.android.app.MainActivity
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.theme.RGB

// The widgets' look, after Spotify's: the ground takes the cover's colour, white text, a round
// white play button with a dark glyph. Shapes are tinted drawables and pre-cut bitmaps, since
// RemoteViews has no clipping before Android 12.

private val widgetInk = ColorProvider(Color.White)
private val widgetInkSub = ColorProvider(Color.White.copy(alpha = 0.72f))
private val widgetGlyph = ColorProvider(RGB.BLACK.color)
private val widgetTitle = TextStyle(color = widgetInk, fontSize = 14.sp, fontWeight = FontWeight.Bold)
private val widgetSub = TextStyle(color = widgetInkSub, fontSize = 13.sp)

/** One widget: reads the kept state (live while the process runs) and draws its model. */
@Composable
internal fun WidgetContent(kind: WidgetKind) {
    val context = LocalContext.current
    val store = WidgetStore.shared(context)
    val snapshot by store.snapshot.collectAsState()
    val progress by store.progress.collectAsState()
    val model = WidgetLogic.model(kind, snapshot, if (kind == WidgetKind.Small) progress else null)
    val open = widgetOpen(context, model.link)
    Box(GlanceModifier.fillMaxSize().appWidgetBackground().clickable(open)) {
        WidgetShape(R.drawable.widget_bg, model.background)
        when (kind) {
            WidgetKind.Recents -> WidgetRecents(model, store)
            WidgetKind.Player -> WidgetPlayer(model, store)
            WidgetKind.Small -> WidgetSmall(model, store)
        }
    }
}

/** 4x2: the song on top, the recent shortcuts in a darker strip below. */
@Composable
private fun WidgetRecents(model: WidgetModel, store: WidgetStore) {
    val size = LocalSize.current
    val pad = WidgetLogic.SIDE_PAD.dp
    val top = 64.dp
    val strip = size.height - top
    val fit = WidgetLogic.tileFit(size.width.value, strip.value, model.tiles.size)
    Column(GlanceModifier.fillMaxSize()) {
        Row(
            GlanceModifier.fillMaxWidth().then(if (fit.count > 0) GlanceModifier.height(top) else GlanceModifier.defaultWeight()).padding(horizontal = pad),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WidgetArt(model, store, 48.dp, 5.dp, WidgetLogic.ROW_COVER_PX)
            Spacer(GlanceModifier.width(12.dp))
            WidgetWords(model, GlanceModifier.defaultWeight(), titleLines = 1)
            if (model.has(WidgetPart.PlayPause)) {
                Spacer(GlanceModifier.width(8.dp))
                WidgetPlayButton(model.playing, 36.dp)
            }
        }
        if (model.has(WidgetPart.Tiles) && fit.count > 0) {
            Box(GlanceModifier.fillMaxWidth().defaultWeight(), contentAlignment = Alignment.Center) {
                WidgetShape(R.drawable.widget_strip, model.strip)
                Row(GlanceModifier.fillMaxWidth().padding(horizontal = pad), verticalAlignment = Alignment.CenterVertically) {
                    val side = fit.size.dp
                    model.tiles.take(fit.count).forEachIndexed { i, tile ->
                        // Spread edge to edge, as the cover and the play button above are.
                        if (i > 0) Spacer(GlanceModifier.defaultWeight())
                        Box(GlanceModifier.size(side).clickable(widgetOpen(LocalContext.current, tile.link)).semantics { contentDescription = tile.name }) {
                            WidgetPicture(
                                tile.cover?.let { store.file(it) }, side, WidgetLogic.TILE_PX,
                                corner = if (tile.round) 0.5f else 4.5f / fit.size, round = tile.round,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 4x1: the song with previous, play / pause, next. */
@Composable
private fun WidgetPlayer(model: WidgetModel, store: WidgetStore) {
    val cover = (LocalSize.current.height.value - 16f).coerceIn(32f, 48f).dp
    Row(GlanceModifier.fillMaxSize().padding(horizontal = WidgetLogic.SIDE_PAD.dp), verticalAlignment = Alignment.CenterVertically) {
        WidgetArt(model, store, cover, 5.dp, WidgetLogic.ROW_COVER_PX)
        Spacer(GlanceModifier.width(12.dp))
        WidgetWords(model, GlanceModifier.defaultWeight(), titleLines = 1)
        if (model.has(WidgetPart.Previous)) WidgetSkipButton(WidgetCommand.Previous)
        if (model.has(WidgetPart.PlayPause)) WidgetPlayButton(model.playing, 36.dp)
        if (model.has(WidgetPart.Next)) WidgetSkipButton(WidgetCommand.Next)
    }
}

/** 2x2: cover top left, the words and the play button along the bottom, the progress line under them. */
@Composable
private fun WidgetSmall(model: WidgetModel, store: WidgetStore) {
    val size = LocalSize.current
    val cover = WidgetLogic.smallCover(size.height.value).dp
    Column(GlanceModifier.fillMaxSize().padding(WidgetLogic.SIDE_PAD.dp)) {
        WidgetArt(model, store, cover, 6.dp, WidgetLogic.COVER_PX)
        Spacer(GlanceModifier.defaultWeight())
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            WidgetWords(model, GlanceModifier.defaultWeight(), titleLines = WidgetLogic.titleLines(WidgetKind.Small, size.height.value), large = true)
            if (model.has(WidgetPart.PlayPause)) {
                Spacer(GlanceModifier.width(6.dp))
                WidgetPlayButton(model.playing, 34.dp)
            }
        }
    }
    val p = model.progress
    if (model.has(WidgetPart.Progress) && p != null) {
        val inset = WidgetLogic.progressInset(Build.VERSION.SDK_INT).dp
        val line = (size.width - inset * 2) * p
        Box(GlanceModifier.fillMaxSize().padding(horizontal = inset), contentAlignment = Alignment.BottomStart) {
            if (line.value >= 1f) Spacer(GlanceModifier.width(line).height(3.dp).background(widgetInk))
        }
    }
}

/** The song's cover, or the placeholder square (empty state, or a cover not saved yet). */
@Composable
private fun WidgetArt(model: WidgetModel, store: WidgetStore, side: Dp, radius: Dp, px: Int) {
    WidgetPicture(model.cover?.let { store.file(it) }, side, px, corner = radius.value / side.value, round = false)
}

@Composable
private fun WidgetPicture(file: java.io.File?, side: Dp, px: Int, corner: Float, round: Boolean) {
    val bitmap = file?.let { WidgetBitmaps.shaped(it, px, corner) }
    if (bitmap != null) {
        Image(ImageProvider(bitmap), null, GlanceModifier.size(side))
    } else {
        Image(
            ImageProvider(if (round) R.drawable.widget_placeholder_round else R.drawable.widget_placeholder), null,
            GlanceModifier.size(side), contentScale = ContentScale.FillBounds,
        )
    }
}

/** Title over artist; in the empty state the one line "Listen to your music". */
@Composable
private fun WidgetWords(model: WidgetModel, modifier: GlanceModifier, titleLines: Int, large: Boolean = false) {
    val title = if (large) widgetTitle.copy(fontSize = 15.sp) else widgetTitle
    Column(modifier) {
        if (model.has(WidgetPart.EmptyText)) Text(L("Listen to your music"), style = title, maxLines = 2)
        if (model.has(WidgetPart.Title)) Text(model.title, style = title, maxLines = titleLines)
        if (model.has(WidgetPart.Artist) && model.artist.isNotEmpty()) Text(model.artist, style = widgetSub, maxLines = 1)
    }
}

/** The round white button with the dark play / pause glyph. */
@Composable
private fun WidgetPlayButton(playing: Boolean, side: Dp) {
    Box(
        GlanceModifier.size(side).clickable(widgetCommand(WidgetCommand.Toggle)).semantics { contentDescription = L(if (playing) "Pause" else "Play") },
        contentAlignment = Alignment.Center,
    ) {
        Image(ImageProvider(R.drawable.widget_circle), null, GlanceModifier.fillMaxSize())
        Image(
            ImageProvider(if (playing) R.drawable.widget_pause else R.drawable.widget_play), null,
            GlanceModifier.size(side * 0.42f), colorFilter = ColorFilter.tint(widgetGlyph),
        )
    }
}

@Composable
private fun WidgetSkipButton(command: WidgetCommand) {
    val next = command == WidgetCommand.Next
    Box(
        GlanceModifier.size(40.dp).clickable(widgetCommand(command)).semantics { contentDescription = L(if (next) "Next" else "Previous") },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            ImageProvider(if (next) R.drawable.widget_next else R.drawable.widget_previous), null,
            GlanceModifier.size(16.dp), colorFilter = ColorFilter.tint(widgetInk),
        )
    }
}

/** A white shape drawable stretched over its box, in `color`. */
@Composable
private fun WidgetShape(drawable: Int, color: RGB) {
    Image(
        ImageProvider(drawable), null, GlanceModifier.fillMaxSize(),
        contentScale = ContentScale.FillBounds, colorFilter = ColorFilter.tint(ColorProvider(color.color)),
    )
}

private fun widgetCommand(command: WidgetCommand): Action =
    actionRunCallback<WidgetTransportAction>(actionParametersOf(WidgetTransportAction.COMMAND to command.wire))

/** Opens the app: on `link` (now playing, a tile's page), or just to the front without one. */
private fun widgetOpen(context: Context, link: String?): Action {
    val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (link != null) intent.setAction(Intent.ACTION_VIEW).setData(Uri.parse(link))
    else intent.setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return actionStartActivity(intent)
}
