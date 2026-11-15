package com.lukasbaxter.slopify.android.features.widget

import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.features.home.HomeLogic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** What each home screen widget shows for a state. */
class WidgetLogicTest {
    private val song = WidgetTrack("t1", "One Dance", "Drake", cover = "c.png")
    private val tiles = listOf(
        WidgetTile("album", "al1", "Views", cover = "a.png"),
        WidgetTile("artist", "ar1", "PARTYNEXTDOOR", cover = "b.png"),
        WidgetTile("playlist", "pl_1", "Chill (feat. Friends)"),
    )
    private val empty = WidgetSnapshot()
    private val paused = WidgetSnapshot(track = song, playing = false, color = listOf(40, 90, 160), tiles = tiles)
    private val playing = paused.copy(playing = true)
    private val states = listOf(empty, empty.copy(tiles = tiles), paused, playing)

    // States

    @Test fun emptyStateIsThePlaceholderAndTheText() {
        for (kind in WidgetKind.entries) {
            val m = WidgetLogic.model(kind, empty, progress = 0.5f)
            assertEquals(listOf(WidgetPart.Placeholder, WidgetPart.EmptyText), m.parts)
            assertNull("an empty widget just opens the app", m.link)
            assertNull(m.progress)
            assertFalse(m.playing)
            assertEquals(WidgetLogic.NEUTRAL, m.background)
        }
    }

    @Test fun eachWidgetShowsItsOwnParts() {
        assertEquals(
            listOf(WidgetPart.Cover, WidgetPart.Title, WidgetPart.Artist, WidgetPart.PlayPause, WidgetPart.Tiles),
            WidgetLogic.model(WidgetKind.Recents, paused).parts,
        )
        assertEquals(
            listOf(WidgetPart.Cover, WidgetPart.Title, WidgetPart.Artist, WidgetPart.Previous, WidgetPart.PlayPause, WidgetPart.Next),
            WidgetLogic.model(WidgetKind.Player, paused).parts,
        )
        assertEquals(
            listOf(WidgetPart.Cover, WidgetPart.Title, WidgetPart.Artist, WidgetPart.PlayPause, WidgetPart.Progress),
            WidgetLogic.model(WidgetKind.Small, paused).parts,
        )
    }

    @Test fun pausedAndPlaying() {
        for (kind in WidgetKind.entries) {
            val p = WidgetLogic.model(kind, paused)
            val q = WidgetLogic.model(kind, playing)
            assertFalse(p.playing); assertTrue(q.playing)
            assertEquals(p.parts, q.parts)
            assertEquals("One Dance", q.title); assertEquals("Drake", q.artist); assertEquals("c.png", q.cover)
            assertEquals(WidgetLink.NOW_PLAYING, q.link)
        }
    }

    @Test fun recentsWithoutTilesHasNoStrip() {
        assertFalse(WidgetLogic.model(WidgetKind.Recents, paused.copy(tiles = emptyList())).has(WidgetPart.Tiles))
        // Shortcuts show before anything has played.
        assertTrue(WidgetLogic.model(WidgetKind.Recents, empty.copy(tiles = tiles)).has(WidgetPart.Tiles))
        assertTrue(WidgetLogic.model(WidgetKind.Player, paused).tiles.isEmpty())
        assertTrue(WidgetLogic.model(WidgetKind.Small, paused).tiles.isEmpty())
    }

    // Regression: the widgets never carry the app's mark, in any state.

    @Test fun noStateRendersALogo() {
        val allowed = setOf(
            WidgetPart.Cover, WidgetPart.Placeholder, WidgetPart.Title, WidgetPart.Artist, WidgetPart.EmptyText,
            WidgetPart.PlayPause, WidgetPart.Previous, WidgetPart.Next, WidgetPart.Tiles, WidgetPart.Progress,
        )
        assertEquals("a new part needs a look: is it a logo?", allowed, WidgetPart.entries.toSet())
        for (kind in WidgetKind.entries) for (s in states) {
            val m = WidgetLogic.model(kind, s, progress = 0.3f)
            assertTrue(m.parts.none { it.name.contains("logo", ignoreCase = true) || it.name.contains("brand", ignoreCase = true) })
        }
    }

    @Test fun noWidgetFileUsesTheLauncherIcon() {
        val main = File("src/main")
        assertTrue("tests run from the app module", File(main, "res").isDirectory)
        val files = File(main, "res").walkTopDown().filter { it.isFile && it.name.startsWith("widget_") }.toList() +
            File(main, "java/com/lukasbaxter/slopify/android/features/widget").walkTopDown().filter { it.isFile }.toList()
        assertTrue(files.size > 10)
        val marks = listOf("ic_launcher", "mipmap", "app_name", "logo")
        for (f in files) {
            val text = f.readText().lowercase()
            for (m in marks) assertFalse("${f.name} mentions $m", text.contains(m))
        }
    }

    // Tiles

    @Test fun artistTilesAreRoundAndOnlyThose() {
        val m = WidgetLogic.model(WidgetKind.Recents, playing)
        assertEquals(listOf(false, true, false), m.tiles.map { it.round })
        assertTrue(WidgetLogic.tileRound("artist"))
        assertFalse(WidgetLogic.tileRound("album")); assertFalse(WidgetLogic.tileRound("playlist"))
        // From Home's shortcuts, whatever the order.
        val fromHome = WidgetLogic.tiles(
            listOf(
                HomeLogic.Shortcut.ArtistTile(HomeLogic.RankedArtist("ar9", "Valley", "img")),
                HomeLogic.Shortcut.AlbumTile(Album(id = "al9", name = "Maybe", artist = "Valley")),
            ),
        )
        assertEquals(listOf(true, false), WidgetLogic.model(WidgetKind.Recents, WidgetSnapshot(tiles = fromHome)).tiles.map { it.round })
    }

    @Test fun tilesComeFromHomeShortcutsWithoutLikedSongs() {
        val shortcuts = listOf(HomeLogic.Shortcut.Liked) +
            (1..7).map { HomeLogic.Shortcut.AlbumTile(Album(id = "al$it", name = "A$it", artist = "X", cover = "h$it")) }
        val got = WidgetLogic.tiles(shortcuts)
        assertEquals(5, got.size)
        assertEquals(WidgetTile("album", "al1", "A1", "h1"), got.first())
        val pl = WidgetLogic.tiles(listOf(HomeLogic.Shortcut.PlaylistTile(Playlist(id = "pl_1", name = "Mix", cover = "pc")))).single()
        assertEquals(WidgetTile("playlist", "pl_1", "Mix", "pc"), pl)
    }

    @Test fun tileLabelsAndLinks() {
        val m = WidgetLogic.model(WidgetKind.Recents, playing)
        assertEquals(listOf("Views", "PARTYNEXTDOOR", "Chill"), m.tiles.map { it.name })
        assertEquals(listOf("slopify://widget/album/al1", "slopify://widget/artist/ar1", "slopify://widget/playlist/pl_1"), m.tiles.map { it.link })
    }

    @Test fun tileCoverSources() {
        assertEquals(CoverSource.AlbumArt("al1", "h"), WidgetLogic.coverSource(WidgetTile("album", "al1", "A", "h")))
        assertEquals(CoverSource.PlaylistArt("pl_1", "h"), WidgetLogic.coverSource(WidgetTile("playlist", "pl_1", "P", "h")))
        assertEquals(CoverSource.ArtistArt("ar1", null), WidgetLogic.coverSource(WidgetTile("artist", "ar1", "R")))
        assertNull(WidgetLogic.coverSource(WidgetTile("genre", "g", "G")))
    }

    @Test fun pictureFileNames() {
        val a = WidgetLogic.fileName(CoverSource.AlbumArt("al1", "h"))
        assertEquals(a, WidgetLogic.fileName(CoverSource.AlbumArt("al1", "h")))
        assertNotEquals(a, WidgetLogic.fileName(CoverSource.AlbumArt("al1", "h2")))
        assertNotEquals(a, WidgetLogic.fileName(CoverSource.ArtistArt("al1", "h")))
        assertTrue(Regex("[0-9a-f]{20}\\.png").matches(a))
    }

    @Test fun asManyTilesAsFit() {
        // A usual 4x2: all five.
        assertEquals(5, WidgetLogic.tileFit(340f, 110f, 5).count)
        assertEquals(3, WidgetLogic.tileFit(340f, 110f, 3).count)
        // Squares never taller than the strip or wider than their share.
        val fit = WidgetLogic.tileFit(340f, 66f, 5)
        assertEquals(46f, fit.size, 0.01f)
        assertEquals(56.8f, WidgetLogic.tileFit(340f, 200f, 5).size, 0.01f)
        // Narrow: fewer.
        assertEquals(4, WidgetLogic.tileFit(180f, 110f, 5).count)
        // Too low for a strip at all.
        assertEquals(0, WidgetLogic.tileFit(340f, 46f, 5).count)
        assertEquals(0, WidgetLogic.tileFit(340f, 110f, 0).count)
    }

    // Text

    @Test fun titleClamping() {
        assertEquals("There's Still a Light in the House", WidgetLogic.clampTitle("  There's Still a\n Light  in the House "))
        val long = "x".repeat(300)
        val cut = WidgetLogic.clampTitle(long)
        assertEquals(100, cut.length); assertTrue(cut.endsWith("…"))
        assertEquals("", WidgetLogic.clampTitle("   "))
        assertEquals(100, WidgetLogic.model(WidgetKind.Small, WidgetSnapshot(track = song.copy(title = long))).title.length)
    }

    @Test fun titleLines() {
        assertEquals(1, WidgetLogic.titleLines(WidgetKind.Recents, 200f))
        assertEquals(1, WidgetLogic.titleLines(WidgetKind.Player, 200f))
        assertEquals(2, WidgetLogic.titleLines(WidgetKind.Small, 160f))
        assertEquals(1, WidgetLogic.titleLines(WidgetKind.Small, 110f))
    }

    @Test fun smallCoverIsAbout80AndShrinksWithTheCell() {
        assertEquals(80f, WidgetLogic.smallCover(190f), 0.01f)
        assertEquals(53f, WidgetLogic.smallCover(140f), 0.01f)
        assertEquals(43f, WidgetLogic.smallCover(110f), 0.01f)
        assertEquals(32f, WidgetLogic.smallCover(60f), 0.01f)
    }

    // Progress

    @Test fun progressFraction() {
        assertEquals(0.25f, WidgetLogic.progress(50.0, 200.0)!!, 0.0001f)
        assertEquals(1f, WidgetLogic.progress(500.0, 200.0)!!, 0.0001f)
        assertEquals(0f, WidgetLogic.progress(-3.0, 200.0)!!, 0.0001f)
        assertNull(WidgetLogic.progress(10.0, 0.0))
        assertNull(WidgetLogic.progress(Double.NaN, 200.0))
    }

    @Test fun progressMovesInSteps() {
        assertEquals(0.24f, WidgetLogic.progressStep(0.2599f)!!, 0.0001f)
        assertEquals(WidgetLogic.progressStep(0.241f), WidgetLogic.progressStep(0.259f))
        assertEquals(1f, WidgetLogic.progressStep(1f)!!, 0.0001f)
        assertNull(WidgetLogic.progressStep(null))
    }

    @Test fun onlyTheSmallWidgetHasTheProgressLineAndOnlyWithASong() {
        assertEquals(0.4f, WidgetLogic.model(WidgetKind.Small, playing, 0.4f).progress!!, 0.0001f)
        assertEquals(0f, WidgetLogic.model(WidgetKind.Small, paused, null).progress!!, 0.0001f)
        assertEquals(1f, WidgetLogic.model(WidgetKind.Small, paused, 7f).progress!!, 0.0001f)
        assertNull(WidgetLogic.model(WidgetKind.Recents, playing, 0.4f).progress)
        assertNull(WidgetLogic.model(WidgetKind.Player, playing, 0.4f).progress)
        assertEquals(0f, WidgetLogic.progressInset(34), 0f)
        assertEquals(16f, WidgetLogic.progressInset(30), 0f)
    }

    // Colour

    @Test fun groundTakesTheCoverColourAndStaysReadable() {
        for (c in listOf(listOf(250, 250, 240), listOf(5, 5, 20), listOf(230, 40, 40), listOf(40, 90, 160))) {
            val bg = WidgetLogic.background(c)
            assertTrue("white text reads on $bg", bg.contrast(RGB.WHITE) >= WidgetLogic.MIN_CONTRAST)
            assertNotEquals(RGB.BLACK, bg.rounded)
        }
        // A blue cover stays blue, a pale yellow one stays yellow (darker, so the text reads).
        val blue = WidgetLogic.background(listOf(40, 90, 160))
        assertTrue(blue.b > blue.r && blue.b > blue.g)
        val yellow = WidgetLogic.background(listOf(250, 250, 140))
        assertTrue(yellow.r > yellow.b * 2 && yellow.g > yellow.b * 2)
        assertEquals(WidgetLogic.NEUTRAL, WidgetLogic.background(null))
        assertEquals(WidgetLogic.NEUTRAL, WidgetLogic.background(listOf(1, 2)))
    }

    @Test fun stripIsTheGroundSlightlyDarker() {
        val m = WidgetLogic.model(WidgetKind.Recents, playing)
        assertTrue(m.strip.luminance < m.background.luminance)
        assertTrue(m.strip.luminance > m.background.luminance * 0.5)
        // The picker preview's colours are the neutral ones.
        val colors = File("src/main/res/values/widget.xml").readText()
        assertTrue(colors.contains(WidgetLogic.NEUTRAL.hex))
        assertTrue(colors.contains(WidgetLogic.model(WidgetKind.Recents, empty).strip.hex))
    }

    // Links

    @Test fun linksRoundTrip() {
        assertEquals(WidgetLink.Target.NowPlaying, WidgetLink.parse(WidgetLink.NOW_PLAYING))
        assertEquals(WidgetLink.Target.Page(Route.Album("al1")), WidgetLink.parse(WidgetLink.tile("album", "al1")))
        assertEquals(WidgetLink.Target.Page(Route.Playlist("pl_9")), WidgetLink.parse(WidgetLink.tile("playlist", "pl_9")))
        assertEquals(WidgetLink.Target.Page(Route.Artist("ar 1/é?")), WidgetLink.parse(WidgetLink.tile("artist", "ar 1/é?")))
    }

    @Test fun otherLinksAreNotWidgetLinks() {
        assertNull(WidgetLink.parse(null))
        assertNull(WidgetLink.parse(""))
        assertNull(WidgetLink.parse("slopify://music.example.com/?invite=abc"))
        assertNull(WidgetLink.parse("https://widget/album/al1"))
        assertNull(WidgetLink.parse("slopify://widget/genre/rock"))
        assertNull(WidgetLink.parse("slopify://widget/album/"))
        assertNull(WidgetLink.parse("slopify://widget/album/a/b"))
        assertNull(WidgetLink.parse("not a link"))
    }

    @Test fun commands() {
        assertEquals(WidgetCommand.Toggle, WidgetCommand.of("toggle"))
        assertEquals(WidgetCommand.Next, WidgetCommand.of(WidgetCommand.Next.wire))
        assertEquals(WidgetCommand.Previous, WidgetCommand.of("previous"))
        assertNull(WidgetCommand.of("stop")); assertNull(WidgetCommand.of(null))
    }
}
