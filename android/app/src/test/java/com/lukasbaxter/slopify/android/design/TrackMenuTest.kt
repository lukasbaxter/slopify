package com.lukasbaxter.slopify.android.design

import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.design.components.TrackMenu
import com.lukasbaxter.slopify.android.design.components.artistLine
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The shared track row menu (TrackRow.jsx:210-236; UI.md 5.4.5). */
class TrackMenuTest {
    private fun labels(items: List<MenuItem>) = items.map { if (it.kind == MenuItem.Kind.Separator) "—" else it.label }

    @Test fun onlineMenuOrder() {
        val s = TrackMenu.State(designTrack("1"), liked = false, excluded = false, playlists = listOf(Playlist("pl_1", "Road")))
        val items = TrackMenu.items(s, TrackMenu.Actions())
        assertEquals(
            listOf(L("Add to queue"), L("Add to playlist"), L("Add to Liked Songs"), L("Exclude from your taste profile"), "—",
                L("Go to song radio"), L("Go to artist"), L("Go to album"), L("Sync Lyrics"), L("Share")),
            labels(items),
        )
        assertEquals(listOf(L("New playlist"), "—", "Road"), labels(items[1].sub.orEmpty()))
        assertEquals(Icon.Share, items.last().icon)
    }

    @Test fun likedExcludedSyncingAndSeveralArtists() {
        val t = designTrack("1", artists = listOf("A", "B"), ids = listOf("a1", "b1"))
        val items = TrackMenu.items(TrackMenu.State(t, liked = true, excluded = true, syncing = true), TrackMenu.Actions())
        assertTrue(labels(items).contains(L("Remove from Liked Songs")))
        assertTrue(labels(items).contains(L("Include in your taste profile")))
        assertEquals(Icon.HeartFilled, items.first { it.label == L("Remove from Liked Songs") }.icon)
        assertEquals(true, items.first { it.label == L("Syncing Lyrics…") }.disabled)
        assertEquals(listOf("A", "B"), items.first { it.label == L("Go to artist") }.sub?.map { it.label })
        assertEquals("no separator without playlists", listOf(L("New playlist")), labels(items[1].sub.orEmpty()))
    }

    @Test fun offlineKeepsArtistAndAlbumOnly() {
        val t = designTrack("1", artists = listOf("A", "B"), ids = listOf("a1", "b1"))
        val off = TrackMenu.items(TrackMenu.State(t, liked = false, excluded = false, offline = true), TrackMenu.Actions())
        assertEquals(listOf(L("Go to artist"), L("Go to album")), labels(off))
        assertEquals(2, off[0].sub?.size)
        val kept = TrackMenu.items(TrackMenu.State(t, liked = false, excluded = false, downloaded = true, offline = true), TrackMenu.Actions())
        // offlineMenu keeps the inner separator (TrackRow.jsx:184-188).
        assertEquals(listOf(L("Add to queue"), "—", L("Go to artist"), L("Go to album")), labels(kept))
    }

    @Test fun actionsRunWithTheTrack() {
        var opened: String? = null
        var liked: Boolean? = null
        var queued: String? = null
        val a = TrackMenu.Actions(openAlbum = { opened = it }, like = { _, on -> liked = on }, addToQueue = { queued = it.id })
        val items = TrackMenu.items(TrackMenu.State(designTrack("1"), liked = false, excluded = false), a)
        items.first { it.label == L("Go to album") }.action?.invoke()
        items.first { it.label == L("Add to Liked Songs") }.action?.invoke()
        items.first { it.label == L("Add to queue") }.action?.invoke()
        assertEquals("al1", opened)
        assertEquals(true, liked)
        assertEquals("1", queued)
    }

    @Test fun removeOnlyWhenThePageGivesIt() {
        val t = designTrack("1")
        assertFalse(labels(TrackMenu.items(TrackMenu.State(t, liked = false, excluded = false), TrackMenu.Actions())).contains(L("Remove from this playlist")))
        var removed: String? = null
        val items = TrackMenu.items(TrackMenu.State(t, liked = false, excluded = false), TrackMenu.Actions(remove = { removed = it.id }))
        assertEquals(L("Remove from this playlist"), labels(items)[2])
        items[2].action?.invoke()
        assertEquals("1", removed)
    }

    @Test fun playlistRowsAddTheTrack() {
        var added: Pair<String, String>? = null
        val a = TrackMenu.Actions(addTo = { p, t -> added = p.id to t.id })
        val items = TrackMenu.items(TrackMenu.State(designTrack("9"), liked = false, excluded = false, playlists = listOf(Playlist("p1", "Road"))), a)
        items[1].sub?.last()?.action?.invoke()
        assertEquals("p1" to "9", added)
    }

    /** FullScreen.jsx:221-240: no taste-profile row, a separator before Sync Lyrics, trailing rows. */
    @Test fun nowPlayingStyle() {
        val t = designTrack("1", artists = emptyList(), ids = listOf("a9"))
        var opened: String? = null
        val s = TrackMenu.State(t, liked = false, excluded = false, style = TrackMenu.Style.NowPlaying, trailing = listOf(MenuItem("Sleep timer")))
        val items = TrackMenu.items(s, TrackMenu.Actions(openArtist = { opened = it }))
        assertEquals(
            listOf(L("Add to queue"), L("Add to playlist"), L("Add to Liked Songs"), "—",
                L("Go to song radio"), L("Go to artist"), L("Go to album"), "—", L("Sync Lyrics"), L("Share"), "Sleep timer"),
            labels(items),
        )
        items.first { it.label == L("Go to artist") }.action?.invoke()
        assertEquals("falls back to the first artist id", "a9", opened)
        assertEquals(Icon.Share16, items.first { it.label == L("Share") }.icon)
    }

    @Test fun newPlaylistName() {
        assertEquals("OK Computer", TrackMenu.newPlaylistName(designTrack("1", album = "OK Computer")))
        assertEquals(L("My Playlist"), TrackMenu.newPlaylistName(designTrack("1", album = "")))
        assertEquals(L("My Playlist"), TrackMenu.newPlaylistName(null))
    }

    @Test fun shareUrl() {
        assertEquals("https://music.example.org/?album=abc", TrackMenu.shareUrl("https://music.example.org//", TrackMenu.ShareKind.Album, "abc"))
        assertEquals("Song — Band", TrackMenu.shareTitle("Song", "Band"))
        assertEquals("Song", TrackMenu.shareTitle("Song", ""))
        assertEquals("A, B", TrackMenu.shareBy(designTrack("1", artists = listOf("A", "B"), ids = listOf("a", "b"))))
    }

    @Test fun dislikesPatch() {
        val prefs: Prefs = mapOf("dislikes" to JsonObject(mapOf("old" to JsonPrimitive(1))))
        assertTrue(TrackMenu.isExcluded("old", prefs))
        assertFalse(TrackMenu.isExcluded("new", prefs))
        assertEquals(JsonObject(mapOf("old" to JsonPrimitive(1), "new" to JsonPrimitive(5.0))), TrackMenu.dislikes(prefs, "new", true, 5.0))
        assertEquals(JsonObject(emptyMap()), TrackMenu.dislikes(prefs, "old", false, 5.0))
    }

    @Test fun artistLineFallsBack() {
        assertEquals("A, B", artistLine(designTrack("1", artists = listOf("A", "", "B"))))
        assertEquals("", artistLine(designTrack("1", artists = emptyList())))
        assertEquals("Band", artistLine(designTrack("1", artists = emptyList()).copy(albumArtist = "Band")))
    }
}
