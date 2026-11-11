package com.lukasbaxter.slopify.android.features.home

import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Theme
import com.lukasbaxter.slopify.android.features.home.HomeLogic.Section
import kotlinx.serialization.Serializable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

internal fun homeTrack(id: String, artists: List<Pair<String, String>>, plays: Int? = null, album: String = "al", ms: Int = 1000) = Track(
    id = id, title = "T$id", artist = artists.joinToString(", ") { it.first }, artists = artists.map { it.first },
    artistIds = artists.map { it.second }, albumId = album, album = "Album", albumArtist = artists.firstOrNull()?.first ?: "",
    durationMs = ms, plays = plays,
)

internal fun homeAlbum(id: String, name: String = "A") = Album(id = id, name = name, artist = "X")

internal fun homePlaylist(id: String) = Playlist(id = id, name = "P$id")

class HomeLogicTest {
    @Before fun english() = Localizer.shared.install(emptyMap(), "en")

    @Test fun rankTopArtistsScoresOnePlusPlaysAndKeepsTieOrder() {
        val tracks = listOf(
            homeTrack("1", listOf("A" to "a", "B" to "b"), plays = 2), // a 3, b 3
            homeTrack("2", listOf("C" to "c"), plays = 5), // c 6
            homeTrack("3", listOf("B" to "b", "Nameless" to "")), // b 4; empty id skipped
            homeTrack("4", listOf("D" to "d"), plays = 2), // d 3 (ties a, after it)
        )
        val r = HomeLogic.rankTopArtists(tracks)
        assertEquals(listOf("c", "b", "a", "d"), r.map { it.id })
        assertEquals(listOf(6, 4, 3, 3), r.map { it.score })
        assertEquals("C", r.first().name)
    }

    @Test fun recentArtistsNeedsADate() {
        val tracks = listOf(homeTrack("1", listOf("A" to "a")), homeTrack("2", listOf("B" to "b")))
        assertTrue(HomeLogic.recentArtists(tracks) { null }.isEmpty())
        val dates = mapOf("1" to "2026-01-01", "2" to "2026-02-01")
        assertEquals(listOf("b", "a"), HomeLogic.recentArtists(tracks) { dates[it.id] }.map { it.id })
    }

    @Test fun recentArtistsKeepsTheLatestDateAndCapsAt16() {
        val many = (0 until 20).map { homeTrack("$it", listOf("N$it" to "id$it")) }
        assertEquals(16, HomeLogic.recentArtists(many) { "2026" }.size)
        val t = listOf(homeTrack("1", listOf("A" to "a")), homeTrack("2", listOf("A" to "a", "B" to "b")))
        val lp = mapOf("1" to "2026-03", "2" to "2026-01")
        assertEquals(listOf("a", "b"), HomeLogic.recentArtists(t) { lp[it.id] }.map { it.id })
    }

    @Test fun tileTitleStripsSuffixes() {
        assertEquals("Song", HomeLogic.tileTitle("Song (feat. Someone)"))
        assertEquals("Album", HomeLogic.tileTitle("Album [Deluxe Edition]"))
        assertEquals("Track", HomeLogic.tileTitle("Track - 2011 Remaster"))
        assertEquals("Track", HomeLogic.tileTitle("Track – Radio Edit"))
        assertEquals("Live at Leeds", HomeLogic.tileTitle("Live at Leeds"))
        assertEquals("Mixtape", HomeLogic.tileTitle("Mixtape (Live)"))
        assertEquals("(Remastered)", HomeLogic.tileTitle("(Remastered)"))
    }

    @Test fun shortcutsOrderAndCap() {
        val recent = listOf(homeAlbum("r1"), homeAlbum("r2"))
        val pls = listOf(homePlaylist("p1"), homePlaylist("p2"))
        val lib = listOf(homeAlbum("r1"), homeAlbum("l1"), homeAlbum("l2"), homeAlbum("l3"), homeAlbum("l4"))
        val s = HomeLogic.shortcuts(recent, pls, lib)
        assertEquals(listOf("__liked__", "al:r1", "al:r2", "pl:p1", "pl:p2", "al:l1", "al:l2", "al:l3"), s.map { it.id })
        assertEquals(listOf("__liked__"), HomeLogic.shortcuts(emptyList(), emptyList(), emptyList()).map { it.id })
        val tenRecent = (0 until 10).map { homeAlbum("x$it") }
        assertEquals(8, HomeLogic.shortcuts(tenRecent, pls, lib).size)
    }

    @Test fun mixSeedsFallBackToLibraryArtists() {
        val top = (0 until 8).map { HomeLogic.RankedArtist("t$it", "T") }
        assertEquals((0 until 6).map { "t$it" }, HomeLogic.mixSeeds(top, emptyList()).map { it.id })
        val seeds = HomeLogic.mixSeeds(emptyList(), listOf(Artist(id = "l1", name = "L", image = "hash")))
        assertEquals(listOf("l1"), seeds.map { it.id })
        assertEquals("hash", seeds.first().image)
    }

    @Test fun sectionsOrderFiltersAndHiddenMadeForYou() {
        val full = HomeLogic.Counts(mixes = 6, years = 2, recent = 3, recentArtists = 4, radar = 5, topArtists = 6)
        assertEquals(
            listOf(Section.Shortcuts, Section.MadeForYou, Section.TopSongs, Section.Recent, Section.JumpBackIn, Section.Radar, Section.TopArtists),
            HomeLogic.sections(HomeLogic.Filter.All, full),
        )
        assertEquals(
            listOf(Section.Shortcuts, Section.MadeForYou, Section.TopSongs, Section.Recent, Section.Radar),
            HomeLogic.sections(HomeLogic.Filter.Music, full),
        )
        assertEquals(listOf(Section.JumpBackIn, Section.TopArtists), HomeLogic.sections(HomeLogic.Filter.Artists, full))
        // No mixes: no Made For You (DECISIONS), and empty lists hide their shelves.
        assertEquals(listOf(Section.Shortcuts), HomeLogic.sections(HomeLogic.Filter.All, HomeLogic.Counts()))
    }

    @Test fun mixColourIndexWraps() {
        assertEquals(0, HomeLogic.mixColorIndex(0))
        assertEquals(1, HomeLogic.mixColorIndex(9))
        assertEquals(7, HomeLogic.mixColorIndex(-1))
        assertEquals(RGB.hex(0xe8115b), Theme.Fixed.mixPalette[HomeLogic.mixColorIndex(8)])
    }

    @Test fun topSongsSubtitleByYear() {
        assertEquals("Your most played songs of 2026 so far", HomeLogic.topSongsSub(2026, 2026))
        assertEquals("The songs you played most in 2024", HomeLogic.topSongsSub(2024, 2026))
    }

    @Test fun totalShortAndMixStats() {
        assertEquals("9min 39sec", HomeLogic.totalShort(579_400))
        assertEquals("3h 7min", HomeLogic.totalShort(11_220_000))
        assertEquals("0min 0sec", HomeLogic.totalShort(499))
        assertEquals("0min 1sec", HomeLogic.totalShort(500))
        assertEquals("Daft Punk and more • 2h 31min", HomeLogic.mixStats("Daft Punk and more", 9_060_000))
        assertEquals("X and more", HomeLogic.mixStats("X and more", 0))
        assertEquals("1min 0sec", HomeLogic.mixStats(null, 60_000))
    }

    @Test fun radarSubtitles() {
        val r = Release(albumId = "m", title = "New", rtype = "EP", date = "2026-11-01", artistId = "a", artistName = "Band")
        assertEquals("Band • EP", HomeLogic.radarShelfSub(r))
        assertEquals("Band • 2026-11-01", HomeLogic.radarOwnedSub(r))
        assertEquals(" • EP • 2026-11-01", HomeLogic.radarMissingTail(r))
        val noType = r.copy(rtype = null)
        assertEquals("Band • Album", HomeLogic.radarShelfSub(noType))
        assertEquals(" • 2026-11-01", HomeLogic.radarMissingTail(noType))
        assertNotEquals(r.key, Release(albumId = "m", title = "New", artistId = "b").key)
    }

    @Test fun requestStateAndLabels() {
        assertEquals("queued", HomeLogic.requestState(null, "queued"))
        assertEquals("queued", HomeLogic.requestState("failed", "queued"))
        assertEquals("downloading", HomeLogic.requestState("downloading", "queued"))
        assertEquals("failed", HomeLogic.requestState("failed", null))
        assertNull(HomeLogic.requestState(null, null))
        assertEquals("Request", HomeLogic.requestUi(null).label)
        assertEquals("Requested", HomeLogic.requestUi("exists").label)
        assertTrue(HomeLogic.requestUi("downloading").busy)
        assertEquals("Retry", HomeLogic.requestUi("failed").label)
        assertFalse(HomeLogic.requestUi("failed").busy)
        assertEquals("Failed", HomeLogic.requestUi("error").label)
    }

    @Serializable private data class HomeRadarR(val releases: List<Release>)

    @Test fun radarReleaseDecodesServerShape() {
        val json = """{"releases":[{"album_id":"mb1","artist":"Band","title":"New","rtype":"Single","year":2026,"date":"2026-10-30","image":"https://example.com/a.jpg","total_tracks":1,"secondary":[],"artistId":"a1","artistName":"Band","inLibrary":null,"localName":null,"requestStatus":"queued"}]}"""
        val r = SlopifyJson.decodeFromString(HomeRadarR.serializer(), json).releases
        assertEquals("Band", r.first().artistName)
        assertEquals("queued", r.first().requestStatus)
        assertNull(r.first().inLibrary)
    }
}
