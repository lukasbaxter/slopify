package com.lukasbaxter.slopify.android.features.detail

import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

internal fun detailTrack(id: String, album: String = "Alb", albumId: String = "al1", plays: Int? = null) = Track(
    id = id, title = "T$id", artist = "A", artists = listOf("A"), artistIds = listOf("a1"), albumId = albumId, album = album,
    albumArtist = "A", durationMs = 1000, plays = plays,
)

internal fun detailRelease(title: String, type: String? = "Album", year: String? = null, date: String? = null, inLib: String? = null, mbid: String? = null, status: String? = null) =
    Release(albumId = mbid, title = title, rtype = type, year = year, date = date, inLibrary = inLib, requestStatus = status)

class DetailLogicTest {
    @Test fun releaseTypeOrder() {
        assertEquals("Compilation", DetailLogic.releaseType("Hits", "Various Artists", 2, null))
        assertEquals("EP", DetailLogic.releaseType("Night Drive EP", "X", 12, 3_600_000))
        assertEquals("EP", DetailLogic.releaseType("Song - EP", "X", 12, null))
        assertEquals("Single", DetailLogic.releaseType("Song – Single", "X", 12, null))
        assertEquals("Single", DetailLogic.releaseType("Song (single)", "X", 12, null))
        assertEquals("Single", DetailLogic.releaseType("Short", "X", 3, 10 * 60_000))
        assertEquals("EP", DetailLogic.releaseType("Mid", "X", 5, null))
        assertEquals("Album", DetailLogic.releaseType("Long few", "X", 3, 40 * 60_000))
        assertEquals("Album", DetailLogic.releaseType("Unknown", "X", null, null))
        // "Deep" ends in "ep" but not as a word.
        assertEquals("Album", DetailLogic.releaseType("Deep", "X", 10, null))
    }

    @Test fun popularOrderPutsKnownFirstAndKeepsRest() {
        val ts = listOf("a", "b", "c", "d").map { detailTrack(it) }
        assertEquals(listOf("c", "a", "b", "d"), DetailLogic.popularOrder(ts, listOf("c", "x", "a")).map { it.id })
        assertEquals(listOf("a", "b", "c", "d"), DetailLogic.popularOrder(ts, emptyList()).map { it.id })
    }

    @Test fun playsSubtitle() {
        val en = Locale.US
        assertEquals(L("1 play"), DetailLogic.playsSubtitle(detailTrack("a", plays = 1), en))
        assertEquals(L("{n} plays", "n" to "1,234"), DetailLogic.playsSubtitle(detailTrack("a", plays = 1234), en))
        assertEquals("OK", DetailLogic.playsSubtitle(detailTrack("a", album = "OK", plays = 0), en))
        assertNull(DetailLogic.playsSubtitle(detailTrack("a", album = ""), en))
    }

    @Test fun entriesMergeLibraryOnlyAlbumsAndSortNewest() {
        val rels = listOf(
            detailRelease("Old", year = "1999", inLib = "L1"),
            detailRelease("New", type = "Single", year = "2020", date = "2020-05-01", mbid = "m2"),
            detailRelease("New2", type = "", year = "2020", date = "2020-09-01", mbid = "m3"),
        )
        val albums = listOf(Album("L1", "Old", "A", year = 1999), Album("L9", "Lib only", "A", year = 2010, trackCount = 12))
        val e = DetailLogic.entries(rels, albums)
        assertEquals("L1 listed by the catalogue is not added twice", 4, e.size)
        assertEquals("L9", e.last().inLib)
        assertEquals("empty rtype falls back to Album", "Album", e[2].type)
        assertEquals(listOf("New2", "New", "Lib only", "Old"), DetailLogic.newestFirst(e).map { it.title })
    }

    @Test fun filters() {
        val e = DetailLogic.entries(
            listOf(detailRelease("A", year = "2001", inLib = "x"), detailRelease("S", type = "Single", year = "2002"), detailRelease("C", type = "Compilation", year = "2003")),
            emptyList(),
        )
        assertEquals(
            listOf(DetailLogic.TypeFilter.All, DetailLogic.TypeFilter.Album, DetailLogic.TypeFilter.Single, DetailLogic.TypeFilter.Compilation),
            DetailLogic.typeFilters(e),
        )
        assertEquals(listOf("C", "S"), DetailLogic.filtered(e, DetailLogic.TypeFilter.All, DetailLogic.LibFilter.Missing).map { it.title })
        assertEquals(listOf("S"), DetailLogic.filtered(e, DetailLogic.TypeFilter.Single, DetailLogic.LibFilter.All).map { it.title })
        assertEquals(listOf("A"), DetailLogic.filtered(e, DetailLogic.TypeFilter.All, DetailLogic.LibFilter.Have).map { it.title })
        assertEquals("2001 • ${L("Album")}", e[0].subtitle)
    }

    @Test fun requestStateAndLabels() {
        assertEquals("queued", DetailLogic.requestState("queued", null))
        assertEquals("a retry must not flash the old failure", "queued", DetailLogic.requestState("queued", "failed"))
        assertEquals("downloading", DetailLogic.requestState("queued", "downloading"))
        assertEquals("failed", DetailLogic.requestState(null, "failed"))
        assertEquals("Request", DetailLogic.requestLabel(null).key)
        assertEquals("Requested", DetailLogic.requestLabel("exists").key)
        assertTrue(DetailLogic.requestLabel("downloading").busy)
        assertEquals("Retry", DetailLogic.requestLabel("failed").key)
        assertFalse(DetailLogic.requestLabel("error").busy)
    }

    @Test fun albumStats() {
        val a = Album("x", "OK Computer", "Radiohead", year = 1997, trackCount = 12, durationMs = 53 * 60_000)
        assertEquals("${L("Album")} • 1997", DetailLogic.albumStats(a, emptyList()))
        val b = Album("y", "Thing", "R")
        assertEquals(L("Single"), DetailLogic.albumStats(b, listOf(detailTrack("1"))))
    }

    @Test fun offlinePlayRules() {
        val ts = listOf("a", "b", "c", "d").map { detailTrack(it) }
        val has = { id: String -> id == "b" || id == "d" }
        assertEquals(ts to 2, DetailLogic.playable(ts, 2, offline = false, has = has))
        assertNull("offline, the tapped song is not downloaded", DetailLogic.playable(ts, 2, offline = true, has = has))
        val p = DetailLogic.playable(ts, 3, offline = true, has = has)
        assertEquals(listOf("b", "d"), p?.first?.map { it.id })
        assertEquals(1, p?.second)
        assertNull(DetailLogic.playable(ts, 9, offline = false, has = has))
        assertEquals(listOf("b", "d"), DetailLogic.playablePage(ts, offline = true, has = has)?.map { it.id })
        assertNull(DetailLogic.playablePage(ts, offline = true) { false })
        assertNull(DetailLogic.playablePage(emptyList(), offline = false, has = has))
    }
}
