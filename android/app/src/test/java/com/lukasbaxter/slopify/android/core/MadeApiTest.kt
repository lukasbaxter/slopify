package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.made
import com.lukasbaxter.slopify.android.core.api.madeList
import com.lukasbaxter.slopify.android.core.api.search
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Made For You themed playlists (server madeforyou.ts): `/api/made`, `/api/made/{id}` and search's `made`. */
class MadeApiTest {
    private val track = """{"id":"t1","title":"T","artist":"A","artists":["A"],"artistIds":["a1"],"albumId":"al","album":"Al","albumArtist":"A","trackNo":1,"discNo":1,"year":2020,"genres":[],"durationMs":1000,"codec":null,"bitrate":null,"cover":null,"format":null,"gain":{"track":null,"album":null},"identity":{"state":"matched","score":1},"addedAt":1}"""
    private val rock = """{"id":"rock","title":"Rock Classics","kind":"genre","description":"Rock legends and anthems","color":"#B3261E","art":"art_0123456789abcdef0123456789abcdef01234567","count":50,"artists":[{"id":"a1","name":"A"}]}"""
    private val thisIs = """{"id":"thisis:a1","title":"This Is A","kind":"thisis","description":"The essential A","color":"#1E3264","art":null,"count":40,"artists":[{"id":"a1","name":"A"}]}"""

    @Test fun listDecodesInTheServersOrder() = runTest {
        StubServer().use { s ->
            s.answers["/api/made"] = 200 to """{"items":[$rock,$thisIs],"building":false,"extra":1}"""
            val got = s.client().madeList()
            assertEquals("/api/made", s.seen.single().requestUrl!!.encodedPath)
            assertEquals(listOf("rock", "thisis:a1"), got.map { it.id })
            assertEquals("Rock Classics", got[0].title)
            assertEquals("genre", got[0].kind)
            assertEquals("Rock legends and anthems", got[0].description)
            assertEquals("#B3261E", got[0].color)
            assertEquals("art_0123456789abcdef0123456789abcdef01234567", got[0].art)
            assertEquals(50, got[0].count)
            assertEquals(listOf("A"), got[0].artists.map { it.name })
            assertNull(got[1].art) // no cover drawn yet
        }
    }

    @Test fun stillBuildingIsAnEmptyList() = runTest {
        StubServer().use { s ->
            s.answers["/api/made"] = 200 to """{"items":[],"building":true}"""
            assertTrue(s.client().madeList().isEmpty())
        }
    }

    @Test fun detailEscapesTheIdAsOnePathSegment() = runTest {
        StubServer().use { s ->
            s.answers["/api/made/thisis:a1"] = 200 to """${thisIs.dropLast(1)},"items":[$track]}"""
            val d = s.client().made("thisis:a1")
            assertEquals("/api/made/thisis:a1", s.seen.single().requestUrl!!.encodedPath)
            assertEquals("This Is A", d.title)
            assertEquals("The essential A", d.summary.description)
            assertEquals(listOf("t1"), d.items.map { it.id })
        }
        // "/" and "?" in an id stay inside the one segment.
        val api = ApiClient("https://m.example.com", null)
        assertEquals("https://m.example.com/api/made/a%2Fb%3F", api.url("api/made/${ApiClient.segment("a/b?")}").toString())
    }

    @Test fun searchCarriesTheThemedPlaylists() = runTest {
        StubServer().use { s ->
            s.answers["/api/search"] = 200 to """{"tracks":[$track],"albums":[],"artists":[],"made":[$rock]}"""
            val r = s.client().search("rock")
            assertEquals(listOf("rock"), r.made.map { it.id })
            assertEquals(listOf("t1"), r.tracks.map { it.id })
        }
    }

    @Test fun olderServerSearchHasNoThemedPlaylists() = runTest {
        StubServer().use { s ->
            s.answers["/api/search"] = 200 to """{"tracks":[$track],"albums":[],"artists":[]}"""
            assertTrue(s.client().search("rock").made.isEmpty())
        }
    }
}
