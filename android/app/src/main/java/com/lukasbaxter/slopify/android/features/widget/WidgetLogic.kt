package com.lukasbaxter.slopify.android.features.widget

import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Theme
import com.lukasbaxter.slopify.android.features.home.HomeLogic
import kotlinx.serialization.Serializable
import java.security.MessageDigest
import kotlin.math.floor
import kotlin.math.min

/** The three home screen widgets: 4x2 player + recents, 4x1 player, 2x2 small. */
enum class WidgetKind { Recents, Player, Small }

/** Everything a widget can draw. A widget shows exactly the parts its [WidgetModel] lists. */
enum class WidgetPart { Cover, Placeholder, Title, Artist, EmptyText, PlayPause, Previous, Next, Tiles, Progress }

/** A transport button, as it travels in the click's parameters. */
enum class WidgetCommand(val wire: String) {
    Toggle("toggle"), Next("next"), Previous("previous");

    companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire } }
}

/** The song on the widget. `cover`: its picture's file in the widget folder, once it is saved. */
@Serializable
data class WidgetTrack(val id: String, val title: String, val artist: String, val cover: String? = null)

/**
 * A recent shortcut. `kind`: album | playlist | artist. `art`: the cover hash the server sent
 * (`Album.cover`, `Playlist.cover`, `Artist.image`). `cover`: the saved picture's file.
 */
@Serializable
data class WidgetTile(val kind: String, val id: String, val name: String, val art: String? = null, val cover: String? = null)

/** What the widgets last showed, kept on disk so they draw after process death and a reboot. */
@Serializable
data class WidgetSnapshot(
    val track: WidgetTrack? = null,
    val playing: Boolean = false,
    /** The cover's prominent colour, 0..255 channels; null = the neutral ground. */
    val color: List<Int>? = null,
    val tiles: List<WidgetTile> = emptyList(),
)

data class WidgetTileModel(val name: String, val cover: String?, val round: Boolean, val link: String)

/** One widget, ready to draw. */
data class WidgetModel(
    val kind: WidgetKind,
    val parts: List<WidgetPart>,
    val title: String,
    val artist: String,
    val playing: Boolean,
    /** 0..1 along the bottom edge; null without a song. */
    val progress: Float?,
    val background: RGB,
    /** The recents strip: the ground, slightly darker. */
    val strip: RGB,
    val cover: String?,
    val tiles: List<WidgetTileModel>,
    /** Where a tap on the cover or the text goes; null just opens the app. */
    val link: String?,
) {
    fun has(part: WidgetPart) = part in parts
}

/** Pure widget rules: what each widget shows for a state, its colours, sizes and links. */
object WidgetLogic {
    const val MAX_TILES = 5
    /** Saved picture sides, px. Small, so a full widget stays far below the RemoteViews limits. */
    const val COVER_PX = 240
    const val TILE_PX = 128
    /** The cover as the two wide widgets draw it (48 dp). */
    const val ROW_COVER_PX = 144

    fun model(kind: WidgetKind, snapshot: WidgetSnapshot, progress: Float? = null): WidgetModel {
        val track = snapshot.track
        val tiles = if (kind == WidgetKind.Recents) snapshot.tiles.take(MAX_TILES).map(::tileModel) else emptyList()
        val parts = buildList {
            if (track == null) {
                add(WidgetPart.Placeholder); add(WidgetPart.EmptyText)
            } else {
                add(WidgetPart.Cover); add(WidgetPart.Title); add(WidgetPart.Artist)
                if (kind == WidgetKind.Player) add(WidgetPart.Previous)
                add(WidgetPart.PlayPause)
                if (kind == WidgetKind.Player) add(WidgetPart.Next)
                if (kind == WidgetKind.Small) add(WidgetPart.Progress)
            }
            if (tiles.isNotEmpty()) add(WidgetPart.Tiles)
        }
        val ground = background(if (track == null) null else snapshot.color)
        return WidgetModel(
            kind = kind, parts = parts,
            title = track?.let { clampTitle(it.title) }.orEmpty(),
            artist = track?.let { clampTitle(it.artist) }.orEmpty(),
            playing = track != null && snapshot.playing,
            progress = if (track != null && kind == WidgetKind.Small) (progress ?: 0f).coerceIn(0f, 1f) else null,
            background = ground, strip = ground.colorMix(0.84, RGB.BLACK),
            cover = track?.cover, tiles = tiles,
            link = if (track == null) null else WidgetLink.NOW_PLAYING,
        )
    }

    /** The title bold on one line, two on the small widget when it is tall enough. */
    fun titleLines(kind: WidgetKind, heightDp: Float): Int = if (kind == WidgetKind.Small && heightDp >= 140f) 2 else 1

    /** One tidy line of text: whitespace collapsed, cut at `max` characters with an ellipsis. */
    fun clampTitle(s: String, max: Int = 100): String {
        val t = s.trim().replace(Regex("\\s+"), " ")
        return if (t.length <= max) t else t.take(max - 1).trimEnd() + "…"
    }

    /** Home's shortcuts as widget tiles: what was picked last first; Liked Songs is pinned, not recent. */
    fun tiles(shortcuts: List<HomeLogic.Shortcut>): List<WidgetTile> = shortcuts.mapNotNull { s ->
        when (s) {
            HomeLogic.Shortcut.Liked -> null
            is HomeLogic.Shortcut.AlbumTile -> WidgetTile("album", s.album.id, s.album.name, s.album.cover)
            is HomeLogic.Shortcut.PlaylistTile -> WidgetTile("playlist", s.playlist.id, s.playlist.name, s.playlist.cover)
            is HomeLogic.Shortcut.ArtistTile -> WidgetTile("artist", s.artist.id, s.artist.name, s.artist.image)
        }
    }.take(MAX_TILES)

    /** Artist photos are circles everywhere in the app; every other tile is a square. */
    fun tileRound(kind: String): Boolean = kind == "artist"

    private fun tileModel(t: WidgetTile) = WidgetTileModel(HomeLogic.tileTitle(t.name), t.cover, tileRound(t.kind), WidgetLink.tile(t.kind, t.id))

    fun coverSource(t: WidgetTile): CoverSource? = when (t.kind) {
        "album" -> CoverSource.AlbumArt(t.id, t.art)
        "playlist" -> CoverSource.PlaylistArt(t.id, t.art)
        "artist" -> CoverSource.ArtistArt(t.id, t.art)
        else -> null
    }

    /** The saved picture's file name for a cover (the same picture keeps its file across server addresses). */
    fun fileName(source: CoverSource): String {
        val sha = MessageDigest.getInstance("SHA-1").digest(source.toString().toByteArray())
        return sha.take(10).joinToString("") { "%02x".format(it) } + ".png"
    }

    /** How far the song is, 0..1; null when its length is unknown. */
    fun progress(position: Double, duration: Double): Float? =
        if (duration > 0 && position.isFinite()) (position / duration).coerceIn(0.0, 1.0).toFloat() else null

    /** The progress line moves in `steps` jumps a song, so the widget is not redrawn twice a second. */
    fun progressStep(fraction: Float?, steps: Int = 50): Float? = fraction?.let { floor(it * steps) / steps }

    /**
     * The ground: the cover's colour, light enough to still read as that colour and dark enough
     * for white text (yellows and greens are bright at any lightness, so those go darker until
     * the text reads). Neutral dark without one.
     */
    fun background(color: List<Int>?): RGB {
        if (color == null || color.size != 3) return NEUTRAL
        var c = ColorMath.clampLightness(RGB(color[0].toDouble(), color[1].toDouble(), color[2].toDouble()), lo = 0.28, hi = 0.42)
        var steps = 0
        while (c.contrast(RGB.WHITE) < MIN_CONTRAST && steps++ < 40) c = c.mix(RGB.BLACK, 0.05)
        return c
    }

    /** WCAG AA for the widget's text on its ground. */
    const val MIN_CONTRAST = 4.5

    /** Also `@color/widget_neutral` (the picker previews). */
    val NEUTRAL: RGB = Theme.Fixed.defaultHero

    /** The recents strip: how many square tiles fit, and their side (dp). Zero when the strip is too low. */
    data class TileFit(val count: Int, val size: Float)

    fun tileFit(widthDp: Float, stripHeightDp: Float, available: Int): TileFit {
        val tall = stripHeightDp - 2 * TILE_PAD
        var n = min(available, MAX_TILES)
        while (n > 0) {
            val side = min(tall, (widthDp - 2 * SIDE_PAD - (n - 1) * TILE_GAP) / n)
            if (side >= MIN_TILE) return TileFit(n, min(side, MAX_TILE))
            if (tall < MIN_TILE) break
            n--
        }
        return TileFit(0, 0f)
    }

    /** The small widget's cover: about 80 dp, less when the cell is low (dp). */
    fun smallCover(heightDp: Float): Float {
        val text = titleLines(WidgetKind.Small, heightDp) * 20f + 17f
        return (heightDp - 2 * SIDE_PAD - 6f - text).coerceIn(32f, 80f)
    }

    /** Before Android 12 nothing clips the widget, so the progress line stays clear of the round corners (dp). */
    fun progressInset(sdk: Int): Float = if (sdk >= 31) 0f else 16f

    const val SIDE_PAD = 12f
    const val TILE_PAD = 10f
    const val TILE_GAP = 8f
    private const val MIN_TILE = 32f
    private const val MAX_TILE = 72f
}
