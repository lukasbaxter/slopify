package com.lukasbaxter.slopify.android.features.search

import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.BrowseTile
import com.lukasbaxter.slopify.android.core.model.EverywhereResults
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.SearchResults
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.storage.MemoryStore
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Fixtures shaped like API.md §5.
private fun searchTrack(id: String, title: String, artists: List<String> = listOf("Radiohead"), album: String = "a1", plays: Int? = null) = Track(
    id = id, title = title, artist = artists.joinToString(", "), artists = artists, artistIds = artists.map { "id-$it" },
    albumId = album, album = "OK Computer", albumArtist = "Radiohead", year = 1997, durationMs = 1000, plays = plays,
)
private fun searchAlbum(id: String, name: String, year: Int? = 1997) = Album(id, name, "Radiohead", year = year)
private fun searchArtist(id: String, name: String) = Artist(id, name)
private fun searchPlaylist(id: String, name: String) = Playlist(id, name)
private fun searchResults(tracks: List<Track> = emptyList(), albums: List<Album> = emptyList(), artists: List<Artist> = emptyList()) =
    SearchResults(tracks, albums, artists)

class SearchLogicTest {
    @Test fun topResultPrefersArtistThenAlbumThenSongPrefix() {
        val r = searchResults(listOf(searchTrack("t1", "Karma Police")), listOf(searchAlbum("al", "Kid A")), listOf(searchArtist("ar", "Radiohead")))
        assertEquals("Artist:ar", SearchLogic.topResult("radio", r)?.key)
        assertEquals("Album:al", SearchLogic.topResult("KID", r)?.key)
        assertEquals("Song:t1", SearchLogic.topResult("karma", r)?.key)
        // No prefix match: first artist.
        assertEquals("Artist:ar", SearchLogic.topResult("zzz", r)?.key)
        assertNull(SearchLogic.topResult("x", searchResults()))
    }

    @Test fun topResultNormalisesNFKC() {
        val r = searchResults(artists = listOf(searchArtist("ar", "ＡＢＢＡ")))
        assertEquals("Artist:ar", SearchLogic.topResult("abba", r)?.key)
    }

    @Test fun phoneRowsOrderAndDedupe() {
        val tracks = (1..6).map { searchTrack("t$it", "Song $it") }
        val artists = (1..3).map { searchArtist("r$it", "Zed $it") }
        val albums = (1..3).map { searchAlbum("a$it", "Album $it") }
        val page = SearchPage("zed", searchResults(tracks, albums, artists), listOf(searchPlaylist("p1", "zed mix"), searchPlaylist("p2", "Zed two"), searchPlaylist("p3", "other")))
        val keys = SearchLogic.phoneRows(page, SearchType.All).map { it.key }
        assertEquals(
            listOf("Artist:r1", "Song:t1", "Song:t2", "Song:t3", "Song:t4", "Artist:r2", "Album:a1", "Album:a2", "Playlist:p1",
                "Song:t5", "Song:t6", "Artist:r3", "Album:a3", "Playlist:p2"),
            keys,
        )
        assertEquals(keys.size, keys.toSet().size)
    }

    @Test fun phoneRowsFilterByType() {
        val page = SearchPage("x", searchResults(listOf(searchTrack("t1", "x")), listOf(searchAlbum("a1", "x")), listOf(searchArtist("r1", "x"))), emptyList())
        assertEquals(listOf("Album:a1"), SearchLogic.phoneRows(page, SearchType.Albums).map { it.key })
        assertEquals(listOf("Song:t1"), SearchLogic.phoneRows(page, SearchType.Songs).map { it.key })
        assertEquals(emptyList<SearchItem>(), SearchLogic.phoneRows(page, SearchType.Everywhere))
    }

    @Test fun playlistsFilteredBySubstringCaseInsensitive() {
        val page = SearchPage("Road", searchResults(), listOf(searchPlaylist("p1", "Road Trip"), searchPlaylist("p2", "Crossroads"), searchPlaylist("p3", "Gym")))
        assertEquals(listOf("p1", "p2"), page.playlists.map { it.id })
    }

    @Test fun subtitlesAreLocalisedAndDropEmptyParts() {
        assertEquals("${L("Album")} • Radiohead", SearchItem.AlbumHit(searchAlbum("a", "Kid A", year = null)).subtitle)
        assertEquals("${L("Album")} • 1997 • Radiohead", SearchItem.AlbumHit(searchAlbum("a", "Kid A")).subtitle)
        assertEquals("${L("Song")} • A, B", SearchItem.Song(searchTrack("t", "x", artists = listOf("A", "B"))).subtitle)
        // No artists: falls back to the album artist.
        assertEquals("${L("Song")} • Radiohead", SearchItem.Song(searchTrack("t", "x", artists = emptyList())).subtitle)
        assertEquals(L("Artist"), SearchItem.ArtistHit(searchArtist("r", "x")).subtitle)
    }

    @Test fun tileColoursCycleThroughSixteen() {
        assertEquals("#e13300", SearchLogic.tileColor(0).hex)
        assertEquals("#e61e32", SearchLogic.tileColor(15).hex)
        assertEquals("#e13300", SearchLogic.tileColor(16).hex)
        val tiles = listOf(BrowseTile("genre:Rock", "Rock"), BrowseTile("genre:Jazz", "Jazz"))
        assertEquals("#1e3264", SearchBrowseData.tileColor("Jazz", tiles)?.hex)
        assertNull(SearchBrowseData.tileColor("Pop", tiles))
        assertNull(SearchBrowseData.tileColor("Jazz", null))
    }

    @Test fun genreHeroUsesTileColour() {
        // UI.md 6.3.1 table: #1e3264 -> #18233e, default #3d3c3c -> #2a2929.
        assertEquals("#18233e", ColorMath.heroTint(SearchLogic.tileColor(1)).hex)
        assertEquals("#2a2929", ColorMath.heroTint(Theme.Fixed.defaultHero).hex)
        assertEquals("#402d4d", ColorMath.heroTint(Theme.Fixed.radarHero).hex)
        val tiles = listOf(BrowseTile("genre:Rock", "Rock"), BrowseTile("genre:Jazz", "Jazz"))
        assertEquals("#18233e", SearchBrowseLogic.hero(SearchBrowseKind.Genre("Jazz"), tiles).hex)
        assertEquals("#2a2929", SearchBrowseLogic.hero(SearchBrowseKind.Genre("Pop"), tiles).hex)
        assertEquals("#402d4d", SearchBrowseLogic.hero(SearchBrowseKind.Charts, tiles).hex)
    }

    @Test fun topArtistRanking() {
        val a = searchTrack("1", "x", artists = listOf("A"), plays = 1)
        val b = searchTrack("2", "x", artists = listOf("B"), plays = 5)
        val c = searchTrack("3", "x", artists = listOf("A", "C"))
        assertEquals(listOf("id-B", "id-A", "id-C"), SearchLogic.topArtistIds(listOf(a, b, c)))
    }

    @Test fun chartsAlbumsFromTracks() {
        val t = listOf(searchTrack("1", "x", album = "a1"), searchTrack("2", "y", album = "a2"), searchTrack("3", "z", album = "a1"), searchTrack("4", "w", album = ""))
        assertEquals(listOf("a1", "a2"), SearchBrowseLogic.albumsFromTracks(t, "?").map { it.id })
        assertEquals("browse:genre:R&B/Soul", SearchBrowseLogic.context(SearchBrowseKind.Genre("R&B/Soul")))
        assertEquals("browse:charts", SearchBrowseLogic.context(SearchBrowseKind.Charts))
    }

    @Test fun browseMeta() {
        assertEquals(L("Loading…"), SearchBrowseLogic.meta(null, 0, loading = true, failed = false, offline = false))
        assertEquals(L("{n} most played", "n" to 3), SearchBrowseLogic.meta(null, 3, loading = false, failed = false, offline = false))
        assertEquals(L("Not available offline"), SearchBrowseLogic.meta(null, 0, loading = false, failed = true, offline = true))
        assertEquals(L("Couldn’t load this — try again"), SearchBrowseLogic.meta(null, 0, loading = false, failed = true, offline = false))
        assertEquals(L("Nothing in this genre yet"), SearchBrowseLogic.meta(null, 0, loading = false, failed = false, offline = false))
    }

    @Test fun requestStates() {
        assertEquals("queued", SearchRequestState.state(server = null, mine = "queued"))
        assertEquals("queued", SearchRequestState.state(server = "failed", mine = "queued"))
        assertEquals("downloading", SearchRequestState.state(server = "downloading", mine = "queued"))
        assertEquals("failed", SearchRequestState.state(server = "failed", mine = null))
        assertEquals(L("Request"), SearchRequestState.ui(null).label)
        assertTrue(SearchRequestState.ui("exists").busy)
        assertEquals(L("Retry"), SearchRequestState.ui("failed").label)
        assertFalse(SearchRequestState.ui("error").busy)
    }
}

class SearchRecentTest {
    @Test fun entryFromSongUsesAlbumAsArt() {
        val e = SearchRecent.from("  karma ", SearchItem.Song(searchTrack("t1", "Karma Police")))
        assertEquals("karma", e.q)
        assertEquals(SearchKind.Song, e.kind)
        assertEquals("a1", e.art)
        assertEquals("${L("Song")} • Radiohead", e.sub)
        assertEquals("r", SearchRecent.from("x", SearchItem.ArtistHit(searchArtist("r", "R"))).art)
        // A song without an album points at itself.
        assertEquals("t2", SearchRecent.from("x", SearchItem.Song(searchTrack("t2", "y", album = ""))).art)
    }

    @Test fun addMovesToTopAndCapsAtTen() {
        var list = emptyList<SearchRecent>()
        for (i in 0 until 12) list = SearchRecent.adding(SearchRecent("", SearchKind.Album, "a$i", null, "", ""), list)
        assertEquals(10, list.size)
        assertEquals("a11", list.first().id)
        list = SearchRecent.adding(SearchRecent("", SearchKind.Album, "a5", null, "", ""), list)
        assertEquals("a5", list.first().id)
        assertEquals(1, list.count { it.id == "a5" })
        // Same id, other kind: a separate entry.
        list = SearchRecent.adding(SearchRecent("", SearchKind.Artist, "a5", null, "", ""), list)
        assertEquals(2, list.count { it.id == "a5" })
        list = SearchRecent.removing(list.first(), list)
        assertEquals(1, list.count { it.id == "a5" })
    }

    @Test fun prefsRoundTripIgnoresJunk() {
        val json = """["old string", {"q":"x","kind":"Artist","id":"r1","art":"r1","name":"Radiohead","sub":"Artist"}, {"kind":"Album"}, {"kind":"Nope","id":"z"}]"""
        val list = SearchRecent.list(Json.parseToJsonElement(json))
        assertEquals(listOf("Artist:r1"), list.map { it.key })
        assertEquals(list, SearchRecent.list(SearchRecent.json(list)))
        assertEquals(L("Song"), SearchRecent("", SearchKind.Song, "s", null, "", "").subtitle)
        assertEquals(emptyList<SearchRecent>(), SearchRecent.list(null))
        // A null art survives the round trip.
        val noArt = listOf(SearchRecent("q", SearchKind.Playlist, "p", null, "n", ""))
        assertEquals(noArt, SearchRecent.list(SearchRecent.json(noArt)))
    }
}

class SearchBrowseDataTest {
    @Test fun keyedPerServerAndUserAndPersisted() {
        assertNull(SearchBrowseData.storageKey(null, "u1"))
        assertEquals("slopify.browse.https://example.com.u1", SearchBrowseData.storageKey("https://example.com", "u1"))
        val store = MemoryStore()
        val saved = SearchBrowseData.Saved(tiles = listOf(BrowseTile("genre:Rock", "Rock")), firstAlbums = listOf("x", "y"))
        store.putString("k", com.lukasbaxter.slopify.android.core.model.SlopifyJson.encodeToString(SearchBrowseData.Saved.serializer(), saved))
        val d = SearchBrowseData(store)
        d.use("k")
        assertEquals(saved, d.saved.value)
        d.use("other")
        assertEquals(SearchBrowseData.Saved(), d.saved.value)
    }

    @Test fun startTileCoverFallbacks() {
        assertEquals("y", SearchBrowseData.Saved(firstAlbums = listOf("x", "y")).chartsCover)
        assertEquals("r", SearchBrowseData.Saved(recentAlbum = "r", firstAlbums = listOf("x", "y")).chartsCover)
        assertEquals("c", SearchBrowseData.Saved(chartsTop = "c", recentAlbum = "r").chartsCover)
        assertEquals("x", SearchBrowseData.Saved(firstAlbums = listOf("x", "y")).newReleasesCover)
        assertEquals("f", SearchBrowseData.Saved(firstArtist = "f").madeForYouCover)
        assertEquals("t", SearchBrowseData.Saved(topArtist = "t", firstArtist = "f").madeForYouCover)
    }
}

/** Records calls; replies can be delayed per query (virtual time). */
private class SearchFakeBackend {
    val calls = mutableListOf<String>()
    val delays = mutableMapOf<String, Long>()
    var fail: Exception? = null
    var everywhere: Result<EverywhereResults> = Result.success(EverywhereResults(emptyList(), emptyList()))
    var everywhereCalls = 0
    var requestStatus: String? = "queued"
    var offline = false

    val backend = SearchBackend(
        search = { q ->
            calls.add(q)
            delays[q]?.let { delay(it) }
            fail?.let { throw it }
            searchResults(tracks = listOf(searchTrack("t-$q", q)))
        },
        playlists = { listOf(searchPlaylist("p1", "abc list")) },
        everywhere = { everywhereCalls++; everywhere.getOrThrow() },
        request = { requestStatus },
        offline = { offline },
        searchOffline = { q -> listOf(searchTrack("off-$q", q)) },
    )
}

@OptIn(ExperimentalCoroutinesApi::class)
class SearchModelTest {
    private fun TestScope.make(fake: SearchFakeBackend) = SearchModel(backgroundScope, fake.backend, now = { testScheduler.currentTime }).apply {
        searchDelayMs = 60; everywhereDelayMs = 300; pollIntervalMs = 4_000
    }

    @Test fun debounceSendsOnlyTheLastQuery() = runTest {
        val fake = SearchFakeBackend()
        val m = make(fake)
        m.setQuery("a"); advanceTimeBy(30); m.setQuery("ab"); advanceTimeBy(30); m.setQuery("abc")
        advanceTimeBy(59); runCurrent()
        assertEquals(emptyList<String>(), fake.calls)
        advanceTimeBy(2); runCurrent()
        assertEquals(listOf("abc"), fake.calls)
        assertEquals("abc", m.state.value.page?.query)
        assertEquals(listOf("p1"), m.state.value.page?.playlists?.map { it.id })
        assertTrue(m.state.value.showsChips)
    }

    @Test fun olderReplyNeverOverwritesNewer() = runTest {
        val fake = SearchFakeBackend()
        val m = make(fake)
        fake.delays["slow"] = 300
        m.setQuery("slow")
        advanceTimeBy(61); runCurrent()
        assertEquals(listOf("slow"), fake.calls)
        m.setQuery("fast")
        advanceTimeBy(61); runCurrent()
        assertEquals("fast", m.state.value.page?.query)
        advanceTimeBy(1_000); runCurrent()
        assertEquals("fast", m.state.value.page?.query)
    }

    @Test fun lateReplyForAnOldQueryIsIgnoredEvenIfNotCancelled() = runTest {
        // The backend ignores cancellation (a reply already on its way): the query check still drops it.
        val fake = SearchFakeBackend()
        val m = make(fake)
        val slow = kotlinx.coroutines.CompletableDeferred<Unit>()
        m.backend = SearchBackend(
            search = { q -> if (q == "old") kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { slow.await() }; searchResults(listOf(searchTrack("t-$q", q))) },
            playlists = { emptyList() }, everywhere = { EverywhereResults(emptyList(), emptyList()) }, request = { null },
        )
        m.setQuery("old"); advanceTimeBy(61); runCurrent()
        m.setQuery("new"); advanceTimeBy(61); runCurrent()
        slow.complete(Unit)
        runCurrent()
        assertEquals("new", m.state.value.page?.query)
    }

    @Test fun resultsStayWhileTypingAndClearOnEmpty() = runTest {
        val fake = SearchFakeBackend()
        val m = make(fake)
        m.setQuery("abc"); advanceTimeBy(61); runCurrent()
        assertNotNull(m.state.value.page)
        fake.delays["abcd"] = 200
        m.setQuery("abcd"); advanceTimeBy(100); runCurrent()
        assertEquals("abc", m.state.value.page?.query)
        m.setQuery("   ")
        assertNull(m.state.value.page)
        assertNull(m.state.value.rows)
        assertFalse(m.state.value.focusMode)
    }

    @Test fun focusModeAndCancel() = runTest {
        val m = make(SearchFakeBackend())
        assertFalse(m.state.value.focusMode)
        m.setFocused(true)
        assertTrue(m.state.value.focusMode)
        m.setQuery("x")
        m.cancel()
        assertEquals("", m.state.value.query)
        assertFalse(m.state.value.focusMode)
        m.setQuery("y"); m.leftTab()
        assertTrue(m.state.value.focusMode) // a query keeps focus mode after leaving the tab
    }

    @Test fun errorShowsBannerButOfflineDoesNot() = runTest {
        val fake = SearchFakeBackend()
        val m = make(fake)
        fake.fail = ApiError.Http(500, "boom")
        m.setQuery("x"); advanceTimeBy(61); runCurrent()
        assertEquals("boom", m.state.value.error)
        fake.fail = ApiError.Offline()
        m.clearError()
        m.setQuery("xy"); advanceTimeBy(61); runCurrent()
        assertNull(m.state.value.error)
        // Offline answers come from the downloaded songs.
        assertEquals(listOf("off-xy"), m.state.value.page?.tracks?.map { it.id })
    }

    @Test fun offlineSearchesDownloadsWithoutTheServer() = runTest {
        val fake = SearchFakeBackend()
        fake.offline = true
        val m = make(fake)
        m.setQuery("song"); advanceTimeBy(61); runCurrent()
        assertEquals(emptyList<String>(), fake.calls)
        assertEquals(listOf("Song:off-song"), m.state.value.rows?.map { it.key })
    }

    @Test fun everywhereWaitsThenLoadsOrFails() = runTest {
        val fake = SearchFakeBackend()
        val m = make(fake)
        m.setQuery("abc")
        assertNull(m.state.value.everywhere)
        m.setType(SearchType.Everywhere)
        assertEquals(SearchEverywhere.Waiting, m.state.value.everywhere)
        assertTrue(m.state.value.showsChips)
        advanceTimeBy(301); runCurrent()
        assertTrue(m.state.value.everywhere is SearchEverywhere.Loaded)
        assertNull(m.state.value.rows)
        fake.everywhere = Result.failure(ApiError.Offline())
        m.setQuery("abcd"); advanceTimeBy(301); runCurrent()
        assertEquals(SearchEverywhere.Failed, m.state.value.everywhere)
        assertNull(m.state.value.error)
        m.setType(SearchType.All)
        assertNull(m.state.value.everywhere)
    }

    @Test fun requestMarksPendingAndPolls() = runTest {
        val fake = SearchFakeBackend()
        val m = make(fake)
        val rel = Release(albumId = "mb1", title = "Kid A")
        fake.everywhere = Result.success(EverywhereResults(listOf(rel), emptyList()))
        m.setType(SearchType.Everywhere)
        m.setQuery("kid"); advanceTimeBy(301); runCurrent()
        assertTrue(m.state.value.everywhere is SearchEverywhere.Loaded)
        assertFalse(m.hasPending)
        fake.requestStatus = "exists"
        m.request(rel)
        assertEquals("exists", m.stateOf(rel))
        assertTrue(m.hasPending)
        val before = fake.everywhereCalls
        advanceTimeBy(4_001); runCurrent()
        assertEquals(before + 1, fake.everywhereCalls)
        // Hidden: the poll skips its turn.
        m.hidden = true
        advanceTimeBy(4_000); runCurrent()
        assertEquals(before + 1, fake.everywhereCalls)
        m.hidden = false
        // The server now has it: polling stops.
        fake.everywhere = Result.success(EverywhereResults(listOf(rel.copy(inLibrary = "al1")), emptyList()))
        advanceTimeBy(4_000); runCurrent()
        assertFalse(m.hasPending)
        val settled = fake.everywhereCalls
        advanceTimeBy(20_000); runCurrent()
        assertEquals(settled, fake.everywhereCalls)
    }

    @Test fun pollStopsAfterThirtyMinutes() = runTest {
        val fake = SearchFakeBackend()
        val m = make(fake)
        val rel = Release(albumId = "mb1", title = "Kid A")
        fake.everywhere = Result.success(EverywhereResults(listOf(rel), emptyList()))
        fake.requestStatus = "queued"
        m.setType(SearchType.Everywhere)
        m.setQuery("kid"); advanceTimeBy(301); runCurrent()
        m.request(rel)
        advanceTimeBy(31 * 60_000L); runCurrent()
        val settled = fake.everywhereCalls
        advanceTimeBy(60_000); runCurrent()
        assertEquals(settled, fake.everywhereCalls)
        assertTrue(settled in 440..460)
    }

    @Test fun failedRequestShowsFailed() = runTest {
        val fake = SearchFakeBackend()
        val m = make(fake)
        val rel = Release(albumId = "mb2", title = "x")
        m.backend = fake.backend.copy(request = { throw ApiError.Http(502, "lidarr down") })
        m.request(rel)
        assertEquals("error", m.stateOf(rel))
        assertEquals(L("Failed"), SearchRequestState.ui(m.stateOf(rel)).label)
        assertEquals("lidarr down", m.state.value.error)
    }
}
