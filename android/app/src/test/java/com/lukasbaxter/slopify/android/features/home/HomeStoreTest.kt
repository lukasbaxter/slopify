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
            "/api/home" to """{"recentAlbums":[{"id":"r1","name":"Recent","artist":"X","artistId":"x","year":2020,"trackCount":3,"cover":null}],"topTracks":[${track("1", "Low", "a", 1)},${track("2", "High", "b", 9)}],"newestAlbums":[]}""",
            "/api/top-songs" to """{"years":[{"year":2026,"songs":40,"plays":300,"top":null}]}""",
            "/api/radar" to """{"releases":[{"album_id":"m1","title":"New","rtype":"EP","date":"2026-11-01","image":null,"artistId":"b","artistName":"High","inLibrary":null,"localName":null,"requestStatus":null}]}""",
            "/api/playlists" to """{"items":[{"id":"pl_1","name":"Mine","userId":"u","created":1,"updated":1,"trackCount":2,"cover":null,"aiPrompt":null}]}""",
            "/api/albums" to """{"items":[{"id":"l1","name":"Lib","artist":"Y","artistId":null,"year":null,"trackCount":1,"durationMs":1,"cover":null,"addedAt":1}],"total":1}""",
            "/api/artists" to """{"items":[{"id":"z","name":"Zed","trackCount":1,"albumCount":1,"image":null,"banner":null}],"total":1}""",
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
            assertEquals("High", d.radarShelf.first().artistName)
            assertTrue(store.state.value.radarLoaded)
            // No last-played dates in /api/home: Jump back in stays hidden, as on the web.
            assertEquals(
                listOf(Section.Shortcuts, Section.MadeForYou, Section.TopSongs, Section.Recent, Section.Radar, Section.TopArtists),
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
            assertEquals(listOf("r1"), store.data.recent.map { it.id })
            assertEquals(1, store.data.radar.size)
            assertNotNull(store.state.value.radarError)
            assertEquals("boom", store.state.value.radarError)
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
                assertEquals(listOf("r1"), b.data.recent.map { it.id })
                assertEquals(listOf("b", "a"), b.data.topArtists.map { it.id })
                assertFalse(b.state.value.radarLoaded) // kept list, but not answered in this run
                b.use("https://example.com|u2")
                assertTrue(b.data.recent.isEmpty())
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
}
