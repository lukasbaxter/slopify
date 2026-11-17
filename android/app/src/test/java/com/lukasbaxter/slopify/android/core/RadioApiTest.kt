package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.api.dailyMixes
import com.lukasbaxter.slopify.android.core.api.homeMixTracks
import com.lukasbaxter.slopify.android.core.api.homeMixes
import com.lukasbaxter.slopify.android.core.api.homeStations
import com.lukasbaxter.slopify.android.core.api.radio
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Go to radio and the Made For You tiles (API.md §14.3, §14.4); JSON shapes from there. */
class RadioApiTest {
    private val track = """{"id":"t1","title":"T","artist":"A","artists":["A"],"artistIds":["a1"],"albumId":"al","album":"Al","albumArtist":"A","trackNo":1,"discNo":1,"year":2020,"genres":[],"durationMs":1000,"codec":null,"bitrate":null,"cover":null,"format":null,"gain":{"track":null,"album":null},"identity":{"state":"matched","score":1},"addedAt":1}"""
    private val radio = """{"id":"radio:a1","made":1794553562334,"from":"brain","seed":{"kind":"artist","id":"a1","name":"A","artistId":"a1","albumId":null},"artists":[{"id":"a1","name":"A"},{"id":"b1","name":"B"}],"items":[$track],"extra":1}"""

    @Test fun radioPostsWithoutABodyAndDecodes() = runTest {
        StubServer().use { s ->
            s.answers["/api/radio/a1"] = 200 to radio
            val r = s.client().radio("a1")
            val req = s.seen.single()
            assertEquals("POST", req.method)
            assertEquals("/api/radio/a1", req.requestUrl!!.encodedPath)
            assertNull(req.requestUrl!!.queryParameter("refresh"))
            assertEquals(0L, req.bodySize)
            assertEquals("radio:a1", r.id)
            assertEquals("artist", r.seed.kind); assertEquals("A", r.seed.name); assertNull(r.seed.albumId)
            assertEquals(listOf("A", "B"), r.artists.map { it.name })
            assertEquals(listOf("t1"), r.items.map { it.id })
        }
    }

    @Test fun refreshAsksForANewOne() = runTest {
        StubServer().use { s ->
            s.answers["/api/radio/a1"] = 200 to radio
            s.client().radio("a1", refresh = true)
            assertEquals("1", s.seen.single().requestUrl!!.queryParameter("refresh"))
        }
    }

    @Test fun dailyMixesSendsTheSeedsAndTheDayOffset() = runTest {
        StubServer().use { s ->
            s.answers["/api/daily-mixes"] = 200 to """{"items":[{"artistId":"a1","day":"2026-11-13","from":"brain","artists":[{"id":"a1","name":"A"},{"id":"c1","name":"C"}]}]}"""
            val got = s.client().dailyMixes(listOf("a1", "b1"))
            val url = s.seen.single().requestUrl!!
            assertEquals("GET", s.seen.single().method)
            assertEquals("a1,b1", url.queryParameter("ids"))
            assertTrue(url.queryParameter("tzo") != null)
            assertEquals("2026-11-13", got.single().day)
            assertEquals(listOf("A", "C"), got.single().artists.map { it.name })
        }
    }

    @Test fun noSeedsNoRequest() = runTest {
        StubServer().use { s ->
            assertEquals(emptyList<Any>(), s.client().dailyMixes(emptyList()))
            assertTrue(s.seen.isEmpty())
        }
    }

    @Test fun dailyMixesCarryTheDrawnArt() = runTest {
        StubServer().use { s ->
            s.answers["/api/daily-mixes"] = 200 to """{"items":[{"artistId":"a1","day":"2026-11-17","artists":[],"cover":{"id":"c1"},"art":"art_0123456789abcdef0123456789abcdef01234567"},{"artistId":"b1"}]}"""
            val got = s.client().dailyMixes(listOf("a1", "b1"))
            assertEquals("art_0123456789abcdef0123456789abcdef01234567", got[0].art)
            assertNull(got[1].art) // an older server: no art, the tile keeps its band
        }
    }

    @Test fun homeStationsSendSkipAndDecodeWith() = runTest {
        StubServer().use { s ->
            s.answers["/api/home/stations"] = 200 to """{"items":[{"id":"a9","name":"Nine","with":[{"id":"x","name":"X"}],"color":"#148a08","art":"art_1"},{"id":"a8"}]}"""
            val got = s.client().homeStations(listOf("a1", "b1"))
            val url = s.seen.single().requestUrl!!
            assertEquals("/api/home/stations", url.encodedPath)
            assertEquals("a1,b1", url.queryParameter("skip"))
            assertTrue(url.queryParameter("tzo") != null)
            assertEquals(listOf("X"), got[0].withArtists.map { it.name })
            assertEquals("art_1", got[0].art)
            assertTrue(got[1].withArtists.isEmpty())
            assertNull(got[1].art)
        }
    }

    @Test fun topMixesDecodeAndTheirSongsEscapeTheGenre() = runTest {
        StubServer().use { s ->
            s.answers["/api/home/mixes"] = 200 to """{"items":[{"genre":"R&B/Soul","name":"R&B/Soul Mix","artists":[{"id":"a1","name":"A"}],"color":"#e8115b","art":"art_2","day":"2026-11-17"}]}"""
            s.answers["/api/home/mixes/R&B%2FSoul"] = 200 to """{"items":[$track]}"""
            val m = s.client().homeMixes().single()
            assertEquals("R&B/Soul", m.genre)
            assertEquals("R&B/Soul Mix", m.name)
            assertEquals("art_2", m.art)
            val songs = s.client().homeMixTracks(m.genre)
            assertEquals("/api/home/mixes/R&B%2FSoul", s.seen.last().requestUrl!!.encodedPath)
            assertEquals(listOf("t1"), songs.map { it.id })
        }
    }
}
