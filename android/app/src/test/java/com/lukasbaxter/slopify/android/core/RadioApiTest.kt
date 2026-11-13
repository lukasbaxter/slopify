package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.api.dailyMixes
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
}
