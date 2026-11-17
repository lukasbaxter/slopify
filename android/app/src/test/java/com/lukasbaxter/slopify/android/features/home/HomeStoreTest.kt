package com.lukasbaxter.slopify.android.features.home

import com.lukasbaxter.slopify.android.core.StubServer
import com.lukasbaxter.slopify.android.features.home.HomeLogic.Section
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files

/** Canned server answers (JSON shapes from API.md §6, §8, §14.2, §15.3); no real server. */
class HomeStoreTest {
    private fun track(id: String, artist: String, artistId: String, plays: Int) =
        """{"id":"$id","title":"T","artist":"$artist","artists":["$artist"],"artistIds":["$artistId"],"albumId":"al","album":"A","albumArtist":"$artist","trackNo":1,"discNo":1,"year":2020,"genres":[],"durationMs":1000,"codec":null,"bitrate":null,"cover":null,"format":null,"gain":{"track":null,"album":null},"identity":{"state":"matched","score":1},"addedAt":1,"plays":$plays}"""

    private lateinit var bodies: Map<String, String>

    @Before fun setUp() {
        bodies = linkedMapOf(
            "/api/home" to """{"recents":[{"kind":"album","id":"r1","name":"Recent","artist":"X","artistId":"x","year":2020,"trackCount":3,"cover":null}],"recentAlbums":[{"id":"r1","name":"Recent","artist":"X","artistId":"x","year":2020,"trackCount":3,"cover":null}],"topTracks":[${track("1", "Low", "a", 1)},${track("2", "High", "b", 9)}],"newestAlbums":[]}""",
            "/api/top-songs" to """{"years":[{"year":2026,"songs":40,"plays":300,"top":null}]}""",
            "/api/radar" to """{"releases":[{"album_id":"m1","title":"New","rtype":"EP","date":"2026-11-01","image":null,"artistId":"b","artistName":"High","inLibrary":"lib_new","localName":null,"requestStatus":null},{"album_id":"m2","title":"Elsewhere","rtype":"Single","date":"2026-11-02","image":null,"artistId":"a","artistName":"Low","inLibrary":null,"localName":null,"requestStatus":null}]}""",
            "/api/playlists" to """{"items":[{"id":"pl_1","name":"Mine","userId":"u","created":1,"updated":1,"trackCount":2,"cover":null,"aiPrompt":null}]}""",
            "/api/albums" to """{"items":[{"id":"l1","name":"Lib","artist":"Y","artistId":null,"year":null,"trackCount":1,"durationMs":1,"cover":null,"addedAt":1}],"total":1}""",
            "/api/artists" to """{"items":[{"id":"z","name":"Zed","trackCount":1,"albumCount":1,"image":null,"banner":null}],"total":1}""",
            "/api/home/stations" to """{"items":[{"id":"s1","name":"Station","with":[{"id":"w1","name":"W1"},{"id":"w2","name":"W2"}],"color":"#1e3264","art":"art_${"a".repeat(40)}"}]}""",
            "/api/home/mixes" to """{"items":[{"genre":"Hip-Hop","name":"Hip-Hop Mix","artists":[{"id":"b","name":"High"},{"id":"a","name":"Low"}],"color":"#e8115b","art":"art_${"b".repeat(40)}","day":"2026-11-17"}]}""",
        )
    }

    private fun StubServer.serve(overrides: Map<String, String> = emptyMap(), failing: Set<String> = emptySet()) {
        synchronized(answers) {
            answers.clear()
            for ((path, body) in bodies + overrides) answers[path] = if (path in failing) 500 to """{"error":"boom"}""" else 200 to body
        }
    }

    @Test fun loadFillsEverySectionInWebOrder() = runTest {
        StubServer().use { s ->
            s.serve()
            val store = HomeStore(backgroundScope)
            store.load(s.client())
            val d = store.data
            assertEquals(listOf("b", "a"), d.topArtists.map { it.id })
            assertEquals(listOf("b", "a"), d.mixSeeds.map { it.id })
            assertEquals(listOf("__liked__", "al:r1", "pl:pl_1", "al:l1"), d.shortcuts.map { it.id })
            // Home's radar shelf: only what is in the library (the page keeps the full list).
            assertEquals(listOf("lib_new"), d.radarShelf.map { it.inLibrary })
            assertEquals(2, d.radar.size)
            assertTrue(store.state.value.radarLoaded)
            // No last-played dates in /api/home: Jump back in stays hidden, as on the web. No Recently
            // played; Your Top Songs last.
            assertEquals(
                listOf(Section.Shortcuts, Section.MadeForYou, Section.Stations, Section.TopMixes, Section.Radar, Section.TopArtists, Section.TopSongs),
                d.sections(HomeLogic.Filter.All),
            )
        }
    }

    @Test fun failuresAreSilentAndKeepOldData() = runTest {
        StubServer().use { s ->
            s.serve()
            val store = HomeStore(backgroundScope)
            store.load(s.client())
            s.serve(failing = setOf("/api/home", "/api/radar"))
            store.load(s.client())
            assertEquals(listOf("r1"), store.data.picks.map { it.id })
            assertEquals(2, store.data.radar.size)
            assertNotNull(store.state.value.radarError)
            assertEquals("boom", store.state.value.radarError)
        }
    }

    @Test fun reloadHomeAsksOncePerSongAndOnlyForHome() = runTest {
        StubServer().use { s ->
            s.serve()
            val store = HomeStore(backgroundScope)
            store.load(s.client())
            val first = s.seen.size
            val picked = """{"recents":[{"kind":"artist","id":"ar9","name":"Nine","image":null},{"kind":"playlist","id":"pl_1","name":"Mine","userId":"u","created":1,"updated":1,"trackCount":2,"cover":null,"aiPrompt":null}],"recentAlbums":[],"topTracks":[],"newestAlbums":[]}"""
            s.serve(mapOf("/api/home" to picked))
            store.reloadHome(s.client(), "t1")
            assertEquals(first + 1, s.seen.size)
            assertEquals("/api/home", s.seen.last().requestUrl?.encodedPath)
            assertEquals(listOf("__liked__", "ar:ar9", "pl:pl_1", "al:l1"), store.data.shortcuts.map { it.id })
            // The same song again (paused and resumed, Home reopened): no request.
            store.reloadHome(s.client(), "t1")
            assertEquals(first + 1, s.seen.size)
            store.reloadHome(s.client(), "t2")
            assertEquals(first + 2, s.seen.size)
        }
    }

    @Test fun anOlderServerWithoutRecentsStillLoads() = runTest {
        StubServer().use { s ->
            s.serve(mapOf("/api/home" to """{"recentAlbums":[{"id":"r1","name":"Recent","artist":"X"}],"topTracks":[],"newestAlbums":[]}"""))
            val store = HomeStore(backgroundScope)
            store.load(s.client())
            assertTrue(store.data.picks.isEmpty())
            assertEquals(listOf("__liked__", "pl:pl_1", "al:l1"), store.data.shortcuts.map { it.id })
        }
    }

    @Test fun maxAgeSkipsAFreshLoad() = runTest {
        StubServer().use { s ->
            s.serve()
            var clock = 1_000L
            val store = HomeStore(backgroundScope, now = { clock })
            store.load(s.client())
            val first = s.seen.size
            store.load(s.client(), maxAgeMs = 60_000)
            assertEquals(first, s.seen.size)
            clock += 61_000
            store.load(s.client(), maxAgeMs = 60_000)
            assertTrue(s.seen.size > first)
        }
    }

    @Test fun keptCopyPaintsFirstAndAccountsDoNotMix() = runTest {
        val dir = Files.createTempDirectory("home-test").toFile()
        try {
            StubServer().use { s ->
                s.serve()
                val a = HomeStore(backgroundScope, cacheDir = dir)
                a.use("https://example.com|u1")
                a.load(s.client())

                val b = HomeStore(backgroundScope, cacheDir = dir)
                b.use("https://example.com|u1")
                assertEquals(listOf("r1"), b.data.picks.map { it.id })
                assertEquals(listOf("b", "a"), b.data.topArtists.map { it.id })
                // The new shelves are kept too.
                assertEquals(listOf("W1", "W2"), b.data.stations.single().withArtists.map { it.name })
                assertEquals("Hip-Hop", b.data.topMixes.single().genre)
                assertFalse(b.state.value.radarLoaded) // kept list, but not answered in this run
                b.use("https://example.com|u2")
                assertTrue(b.data.picks.isEmpty())
                assertTrue(b.data.stations.isEmpty())
            }
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun noMixesHidesMadeForYou() = runTest {
        StubServer().use { s ->
            s.serve(mapOf("/api/home" to """{"recentAlbums":[],"topTracks":[],"newestAlbums":[]}""", "/api/artists" to """{"items":[],"total":0}"""))
            val store = HomeStore(backgroundScope)
            store.load(s.client())
            assertFalse(store.data.sections(HomeLogic.Filter.All).contains(Section.MadeForYou))
        }
    }

    @Test fun requestStatusPatchesTheRadar() = runTest {
        StubServer().use { s ->
            s.serve()
            val store = HomeStore(backgroundScope)
            store.load(s.client())
            store.setRequestStatus("m1", "queued")
            assertEquals("queued", store.data.radar.first().requestStatus)
            s.serve(mapOf("/api/radar" to """{"releases":[]}"""))
            store.reloadRadar(s.client())
            assertTrue(store.state.value.radarLoaded)
            assertTrue(store.data.radar.isEmpty())
        }
    }

    @Test fun dailyMixTilesNameTodaysArtists() = runTest {
        StubServer().use { s ->
            s.serve(mapOf("/api/daily-mixes" to """{"items":[{"artistId":"b","day":"2026-11-13","from":"brain","artists":[{"id":"b","name":"High"},{"id":"q","name":"Q"}]}]}"""))
            val store = HomeStore(backgroundScope)
            store.load(s.client())
            val req = s.seen.single { it.requestUrl!!.encodedPath == "/api/daily-mixes" }
            assertEquals("b,a", req.requestUrl!!.queryParameter("ids"))
            assertEquals(listOf("High", "Q"), store.data.mixArtists["b"]!!.map { it.name })
            // A new answer replaces the kept one.
            s.serve(mapOf("/api/daily-mixes" to """{"items":[{"artistId":"b","day":"2026-11-14","artists":[{"id":"b","name":"High"},{"id":"r","name":"R"}]}]}"""))
            store.load(s.client())
            assertEquals(listOf("High", "R"), store.data.mixArtists["b"]!!.map { it.name })
        }
    }

    @Test fun dailyMixTilesKeepTheDrawnArt() = runTest {
        StubServer().use { s ->
            val art = "art_" + "c".repeat(40)
            s.serve(mapOf("/api/daily-mixes" to """{"items":[{"artistId":"b","day":"2026-11-17","artists":[{"id":"b","name":"High"}],"cover":{"id":"q","image":null},"art":"$art"},{"artistId":"a","day":"2026-11-17","artists":[]}]}"""))
            val store = HomeStore(backgroundScope)
            store.load(s.client())
            assertEquals(mapOf("b" to art), store.data.mixArt)
            assertEquals("q", store.data.mixCovers["b"]!!.id)
        }
    }

    @Test fun stationsSkipTheDailyMixSeeds() = runTest {
        StubServer().use { s ->
            s.serve()
            val store = HomeStore(backgroundScope)
            store.load(s.client())
            val req = s.seen.single { it.requestUrl!!.encodedPath == "/api/home/stations" }
            assertEquals("b,a", req.requestUrl!!.queryParameter("skip"))
            assertNotNull(req.requestUrl!!.queryParameter("tzo"))
            val st = store.data.stations.single()
            assertEquals("s1", st.id)
            assertEquals("#1e3264", st.color)
            assertEquals("art_" + "a".repeat(40), st.art)
            val m = store.data.topMixes.single()
            assertEquals("Hip-Hop Mix", m.name)
            assertEquals(listOf("High", "Low"), m.artists.map { it.name })
            assertEquals("art_" + "b".repeat(40), m.art)
        }
    }

    @Test fun anOlderServerWithoutTheNewShelvesHidesThem() = runTest {
        StubServer().use { s ->
            s.serve(failing = setOf("/api/home/stations", "/api/home/mixes"))
            val store = HomeStore(backgroundScope)
            store.load(s.client())
            assertTrue(store.data.stations.isEmpty())
            assertTrue(store.data.topMixes.isEmpty())
            assertTrue(store.data.mixArt.isEmpty())
            val sections = store.data.sections(HomeLogic.Filter.All)
            assertFalse(sections.contains(Section.Stations))
            assertFalse(sections.contains(Section.TopMixes))
        }
    }
}
