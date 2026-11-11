package com.lukasbaxter.slopify.android.features.library

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.LibraryLayout
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.storage.MemoryStore
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Fixtures shaped like API.md §5.4 / §8.1 (ios SlopifyTests/Library/LibraryLogicTests.swift).
private fun pl(id: String, n: Int = 0) = Playlist(id, "P $id", "u", 0.0, 0.0, n)
private fun al(id: String) = Album(id, "A $id", "Band", "ar", 2000, 1, 1)
private fun ar(id: String) = Artist(id, "R $id", 1, 1)
private fun folder(id: String, items: List<String>, name: String = "F") = LibraryLayout.Folder(id, name, null, items)
internal fun libraryTrack(id: String, title: String, artist: String = "X", album: String = "Y") =
    Track(id, title, artist, listOf(artist), emptyList(), "al", album, artist, durationMs = 1000)

class LibraryArrangementTest {
    @Test fun orderFoldersFreshAndPins() {
        // Sidebar.jsx:103-125: folder kids leave the top level, order kept, folders not in
        // order go on top, unplaced ("fresh") above all known, pinned float keeping list order.
        val layout = LibraryLayout(listOf("p2", "fd1", "a1", "gone"), listOf(folder("fd1", listOf("p3")), folder("fd2", emptyList())))
        val a = LibraryArrangement(listOf(pl("p1"), pl("p2"), pl("p3")), listOf(al("a1")), listOf(ar("r1")), layout, emptyList())
        assertEquals(listOf("p1", "r1", "fd2", "p2", "fd1", "a1"), a.top.map { it.id })
        assertEquals(listOf("p3"), a.kids["fd1"]?.map { it.id })
        val pinned = LibraryArrangement(listOf(pl("p1"), pl("p2"), pl("p3")), listOf(al("a1")), listOf(ar("r1")), layout, listOf("a1", "p2"))
        assertEquals(listOf("p2", "a1", "p1", "r1", "fd2", "fd1"), pinned.top.map { it.id })
    }

    @Test fun childInTwoFoldersIsPlacedOnce() {
        val layout = LibraryLayout(emptyList(), listOf(folder("f1", listOf("p1")), folder("f2", listOf("p1", "p2"))))
        val a = LibraryArrangement(listOf(pl("p1"), pl("p2")), emptyList(), emptyList(), layout, emptyList())
        assertEquals(listOf("p1"), a.kids["f1"]?.map { it.id })
        assertEquals(listOf("p2"), a.kids["f2"]?.map { it.id })
    }

    @Test fun treeAndFlatShown() {
        val layout = LibraryLayout(listOf("fd1", "a1", "p2"), listOf(folder("fd1", listOf("p1"))))
        val a = LibraryArrangement(listOf(pl("p1"), pl("p2")), listOf(al("a1")), emptyList(), layout, emptyList())
        assertEquals(listOf("fd1", "a1", "p2"), a.shown(null, "", false, emptySet(), emptySet(), false).map { it.id })
        val open = a.shown(null, "", false, emptySet(), setOf("fd1"), false)
        assertEquals(listOf("fd1", "p1", "a1", "p2"), open.map { it.id })
        assertEquals("fd1", open[1].parent)
        assertEquals(listOf("fd1", "a1", "p2"), a.shown(null, "", false, emptySet(), setOf("fd1"), true).map { it.id })
        // Flat: children inline at the folder's place, no folders.
        assertEquals(listOf("p1", "p2"), a.shown(LibraryFilter.Playlist, "", false, emptySet(), emptySet(), false).map { it.id })
        assertEquals(listOf("a1"), a.shown(null, "  a A1 ", false, emptySet(), emptySet(), false).map { it.id })
        assertEquals(listOf("p2"), a.shown(null, "", true, setOf("p2"), emptySet(), false).map { it.id })
    }

    @Test fun showLiked() {
        assertTrue(LibraryArrangement.showLiked(null, "", "Liked Songs", false, false))
        assertTrue(LibraryArrangement.showLiked(LibraryFilter.Playlist, "liked", "Liked Songs", false, false))
        assertFalse(LibraryArrangement.showLiked(LibraryFilter.Album, "", "Liked Songs", false, false))
        assertFalse(LibraryArrangement.showLiked(null, "zzz", "Liked Songs", false, false))
        assertFalse(LibraryArrangement.showLiked(null, "", "Liked Songs", true, false))
    }

    @Test fun draftKeepsUnknownIdsAndRoundTrips() {
        val layout = LibraryLayout(listOf("p1", "unknown"), listOf(LibraryLayout.Folder("fd1", "Gym", "c1", listOf("p2", "lost"))))
        val a = LibraryArrangement(listOf(pl("p1"), pl("p2")), emptyList(), emptyList(), layout, emptyList())
        val d = a.draft(layout)
        // fd1 is not in `order`, so it goes on top; ids the client does not know are kept.
        assertEquals(listOf("fd1", "p1", "unknown"), d.order)
        assertEquals(listOf("p2", "lost"), d.folders["fd1"])
        val back = d.layout
        assertEquals("Gym", back.folders.first().name)
        assertEquals("c1", back.folders.first().cover)
        assertTrue("unknown" in back.order)
    }

    @Test fun createRenameDeleteFolder() {
        val layout = LibraryLayout(listOf("a", "fd1", "b"), listOf(folder("fd1", listOf("x", "y"))))
        val a = LibraryArrangement(listOf(pl("a"), pl("b"), pl("x"), pl("y")), emptyList(), emptyList(), layout, emptyList())
        val d = a.draft(layout)
        val created = LibraryArrangement.creatingFolder(d, "fd_new1", "New")
        assertEquals("fd_new1", created.order.first())
        assertEquals(listOf("fd1", "fd_new1"), created.layout.folders.map { it.id })
        assertEquals("Run", LibraryArrangement.renamingFolder(d, "fd1", "Run").layout.folders.first().name)
        // What it held goes back where the folder was.
        val deleted = LibraryArrangement.deletingFolder(d, "fd1")
        assertEquals(listOf("a", "x", "y", "b"), deleted.order)
        assertTrue(deleted.layout.folders.isEmpty())
    }

    @Test fun dropRules() {
        // Rows shown: fd1 (open) > x, then a, b, fdE (open, empty).
        val layout = LibraryLayout(listOf("fd1", "a", "b", "fdE"), listOf(folder("fd1", listOf("x")), folder("fdE", emptyList())))
        val a = LibraryArrangement(listOf(pl("a"), pl("b"), pl("x")), emptyList(), emptyList(), layout, emptyList())
        val open = setOf("fd1", "fdE")
        val shown = a.shown(null, "", false, emptySet(), open, false)
        val rows = shown.map { it.id }
        assertEquals(listOf("fd1", "x", "a", "b", "fdE"), rows)
        val d = a.draft(layout)
        fun drop(id: String, to: Int, into: String? = null) = a.dropping(d, id, to, into, rows, shown, open, false)
        // Onto a folder: first in it.
        assertEquals(listOf("b", "x"), drop("b", 0, "fd1").folders["fd1"])
        // Before a folder's first child: in the folder.
        val between = drop("b", 1)
        assertEquals(listOf("b", "x"), between.folders["fd1"])
        assertFalse("b" in between.order)
        // Right under an open empty folder: in it.
        assertEquals(listOf("a"), drop("a", 4).folders["fdE"])
        // Top level after the row above (a child counts as its folder).
        assertEquals(listOf("fd1", "b", "a", "fdE"), drop("b", 2).order)
        assertEquals(listOf("b", "fd1", "a", "fdE"), drop("b", 0).order)
        // A folder never goes inside a folder.
        assertEquals(listOf("fd1", "fdE", "a", "b"), drop("fdE", 1).order)
    }

    @Test fun pinToggle() {
        assertEquals(listOf("a", "b"), LibraryArrangement.togglingPin(listOf("a"), "b"))
        assertEquals(listOf("b"), LibraryArrangement.togglingPin(listOf("a", "b"), "a"))
    }

    @Test fun emptyStates() {
        assertEquals(LibraryEmptyState.NothingDownloaded, LibraryEmptyState.pick(true, false, 0, "", null, false, false, false))
        assertEquals(LibraryEmptyState.CreateFirst, LibraryEmptyState.pick(false, true, 0, "", null, false, true, true))
        assertNull(LibraryEmptyState.pick(false, true, 0, "", null, false, false, true))
        assertEquals(LibraryEmptyState.NoMatch("zz"), LibraryEmptyState.pick(false, false, 0, " zz ", null, false, true, true))
        assertEquals(LibraryEmptyState.NoArtists, LibraryEmptyState.pick(false, false, 0, "", LibraryFilter.Artist, false, true, true))
        assertEquals(LibraryEmptyState.NoAlbums, LibraryEmptyState.pick(false, false, 0, "", LibraryFilter.Album, false, true, true))
        assertNull(LibraryEmptyState.pick(false, false, 0, "", LibraryFilter.Album, true, true, true))
    }
}

class LibraryDragTest {
    private fun listRows(n: Int, folderAt: Int? = null) =
        (0 until n).map { LibraryDrag.Row("r$it", it == folderAt, Rect(16f, it * 80f, 16f + 361f, it * 80f + 80f)) }

    @Test fun halvesPickBeforeOrAfter() {
        val rows = listRows(4)
        val start = LibraryDrag.Target(0)
        // Lifted row 0; finger over row 2's upper half -> slot 1 (before it among the others).
        assertEquals(LibraryDrag.Target(1), LibraryDrag.target(rows, 0, start, Offset(100f, 170f), true))
        assertEquals(LibraryDrag.Target(2), LibraryDrag.target(rows, 0, start, Offset(100f, 230f), true))
        // Above everything / below everything.
        assertEquals(0, LibraryDrag.target(rows, 2, LibraryDrag.Target(2), Offset(100f, -20f), true).to)
        assertEquals(3, LibraryDrag.target(rows, 0, start, Offset(100f, 999f), true).to)
    }

    @Test fun folderMiddleBand() {
        val rows = listRows(3, folderAt = 2)
        val t = LibraryDrag.target(rows, 0, LibraryDrag.Target(0), Offset(100f, 200f), true)
        assertEquals("r2", t.into)
        assertNull(LibraryDrag.target(rows, 0, LibraryDrag.Target(0), Offset(100f, 200f), false).into)
        assertNull(LibraryDrag.dropLine(rows, 0, t))
    }

    @Test fun shiftsAndLine() {
        val rows = listRows(3)
        // Lifted 0 aimed at slot 2: rows 1 and 2 move up one place.
        assertEquals(Offset(0f, -80f), LibraryDrag.shift(rows, 0, 2, 1))
        assertEquals(Offset(0f, -80f), LibraryDrag.shift(rows, 0, 2, 2))
        assertEquals(Offset.Zero, LibraryDrag.shift(rows, 0, 1, 2))
        assertNull(LibraryDrag.dropLine(rows, 1, LibraryDrag.Target(1)))
        assertEquals(Rect(20f, 199f, 20f + 353f, 201f), LibraryDrag.dropLine(rows, 0, LibraryDrag.Target(2)))
    }

    @Test fun gridUsesLeftRightHalves() {
        val rows = (0 until 4).map { i ->
            val x = if (i % 2 == 0) 16f else 204f
            val y = (i / 2) * 220f
            LibraryDrag.Row("g$i", false, Rect(x, y, x + 172f, y + 210f))
        }
        assertEquals(3, LibraryDrag.target(rows, 0, LibraryDrag.Target(0), Offset(350f, 300f), true).to)
        assertEquals(2, LibraryDrag.target(rows, 0, LibraryDrag.Target(0), Offset(220f, 300f), true).to)
    }

    @Test fun autoScroll() {
        assertEquals(-18f, LibraryDrag.autoScroll(0f, 600f), 0.001f)
        assertEquals(-9f, LibraryDrag.autoScroll(28f, 600f), 0.001f)
        assertEquals(0f, LibraryDrag.autoScroll(300f, 600f), 0.001f)
        assertEquals(18f, LibraryDrag.autoScroll(600f, 600f), 0.001f)
    }
}

class LibraryTextTest {
    @Test fun movedUsesFinalIndexes() {
        // A song drag's slot is its final index, the server's `{from, to}` (web splice).
        assertEquals(listOf("d", "a", "b", "c"), LibraryText.moved(listOf("a", "b", "c", "d"), 3, 0))
        assertEquals(listOf("b", "c", "a", "d"), LibraryText.moved(listOf("a", "b", "c", "d"), 0, 2))
    }

    @Test fun totalShort() {
        assertEquals(Localizer.fill(L("{m}min {sec}sec"), mapOf("m" to 9, "sec" to 39)), LibraryText.totalShort(579_400))
        assertEquals(Localizer.fill(L("{h}h {m}min"), mapOf("h" to 3, "m" to 7)), LibraryText.totalShort(11_220_000))
    }

    @Test fun findMatchesEveryWord() {
        val t = libraryTrack("1", "Paranoid Android", artist = "Radiohead", album = "OK Computer")
        assertTrue(LibraryText.matches(t, "android radio"))
        assertTrue(LibraryText.matches(t, "ＯＫ"))
        assertFalse(LibraryText.matches(t, "android blur"))
        assertTrue(LibraryText.matches(t, "  "))
    }

    @Test fun likedOrderNewestFirstThenSort() {
        val rows = mapOf(
            "a" to libraryTrack("a", "Zebra", artist = "Beta", album = "m"),
            "b" to libraryTrack("b", "apple", artist = "alpha", album = "z"),
            "c" to libraryTrack("c", "Mango", artist = "Gamma", album = "a"),
        )
        val at = mapOf("a" to 3.0, "b" to 1.0, "c" to 2.0, "missing" to 9.0)
        assertEquals(listOf("a", "c", "b"), LibraryText.likedOrder(at, rows, LibraryText.LikedSort.Recent).map { it.id })
        assertEquals(listOf("b", "c", "a"), LibraryText.likedOrder(at, rows, LibraryText.LikedSort.Title).map { it.id })
        assertEquals(listOf("b", "a", "c"), LibraryText.likedOrder(at, rows, LibraryText.LikedSort.Artist).map { it.id })
        assertEquals(listOf("c", "a", "b"), LibraryText.likedOrder(at, rows, LibraryText.LikedSort.Album).map { it.id })
    }

    @Test fun openFoldersPersist() {
        val kv = MemoryStore()
        assertEquals(emptySet<String>(), LibraryOpenFolders.load(kv))
        LibraryOpenFolders.save(setOf("fd2", "fd1"), kv)
        assertEquals("""["fd1","fd2"]""", kv.getString(LibraryOpenFolders.KEY))
        assertEquals(setOf("fd1", "fd2"), LibraryOpenFolders.load(kv))
    }

    @Test fun subtitles() {
        val p = LibraryEntry.of(pl("p1", 3))
        assertEquals(L("Playlist") + LibraryText.DOT + L("{n} songs", "n" to 3), LibraryText.subtitle(p, 0))
        assertEquals(L("Playlist"), LibraryText.subtitle(LibraryEntry.of(pl("p2")), 0))
        assertEquals(L("Album") + LibraryText.DOT + "Band", LibraryText.subtitle(LibraryEntry.of(al("a1")), 0))
        assertEquals(L("Playlist"), LibraryText.likedSubtitle(null))
    }
}
