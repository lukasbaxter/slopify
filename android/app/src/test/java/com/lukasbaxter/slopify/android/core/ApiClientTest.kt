package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.api.albums
import com.lukasbaxter.slopify.android.core.api.artists
import com.lukasbaxter.slopify.android.core.api.browse
import com.lukasbaxter.slopify.android.core.api.changePassword
import com.lukasbaxter.slopify.android.core.api.createPlaylist
import com.lukasbaxter.slopify.android.core.api.demoSignIn
import com.lukasbaxter.slopify.android.core.api.downloads
import com.lukasbaxter.slopify.android.core.api.genre
import com.lukasbaxter.slopify.android.core.api.genreMix
import com.lukasbaxter.slopify.android.core.api.genreTracks
import com.lukasbaxter.slopify.android.core.api.historyStats
import com.lukasbaxter.slopify.android.core.api.login
import com.lukasbaxter.slopify.android.core.api.lyricJobs
import com.lukasbaxter.slopify.android.core.api.lyrics
import com.lukasbaxter.slopify.android.core.api.me
import com.lukasbaxter.slopify.android.core.api.myLyricJobs
import com.lukasbaxter.slopify.android.core.api.patchPrefs
import com.lukasbaxter.slopify.android.core.api.putLibraryLayout
import com.lukasbaxter.slopify.android.core.api.radar
import com.lukasbaxter.slopify.android.core.api.removeFromPlaylist
import com.lukasbaxter.slopify.android.core.api.requestAlbum
import com.lukasbaxter.slopify.android.core.api.requestLyricSync
import com.lukasbaxter.slopify.android.core.api.retryDownload
import com.lukasbaxter.slopify.android.core.api.setFolderCover
import com.lukasbaxter.slopify.android.core.api.timezoneOffsetMinutes
import com.lukasbaxter.slopify.android.core.api.tracks
import com.lukasbaxter.slopify.android.core.model.DownloadScope
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ApiClientUrlTest {
    @Test fun mediaUrlsCarryToken() {
        val api = ApiClient("https://m.example.com", "T")
        assertEquals("https://m.example.com/api/stream/x/hls/master.m3u8?max=aac-160&norm=track&token=T", api.hlsUrl("x", "aac-160", "track").toString())
        assertEquals("https://m.example.com/api/stream/x/hls/master.m3u8?max=alac&token=T", api.hlsUrl("x", "alac", "track").toString())
        assertEquals("https://m.example.com/api/stream/x/whole/aac-320?norm=album&token=T", api.wholeFileUrl("x", "aac-320", "album").toString())
        assertEquals("https://m.example.com/api/download/x?fmt=original&token=T", api.downloadUrl("x").toString())
        assertEquals("https://m.example.com/api/art/h/320.webp", api.artUrl("h", 200).toString())
        assertEquals("https://m.example.com/api/art/h/640.webp", api.artUrl("h", 2000).toString())
        assertEquals("https://m.example.com/api/users/u1/avatar", api.avatarUrl("u1").toString())
        assertEquals("wss://m.example.com/api/ws", api.webSocketUrl)
        assertEquals("ws://192.168.1.2:8080/api/ws", ApiClient("http://192.168.1.2:8080").webSocketUrl)
    }

    @Test fun plainPathsAndQueriesUnchanged() {
        val api = ApiClient("https://m.example.com/sub", "T")
        assertEquals("https://m.example.com/sub/api/albums/abc?limit=2", api.url("api/albums/abc", mapOf("limit" to "2")).toString())
        assertEquals("https://m.example.com/sub/api/image/pl_1?c=0123456789&size=300", api.imageUrl("pl_1", 300, bust = "0123456789abc").toString())
        assertEquals("https://m.example.com/sub/api/image/a?kind=banner&size=800&w=800", api.imageUrl("a", 800, banner = true).toString())
    }

    /** Regression (iOS): "R&B/Soul" must stay one segment. */
    @Test fun genreNamesStayOneSegment() {
        val api = ApiClient("https://m.example.com")
        assertEquals("https://m.example.com/api/genres/R&B%2FSoul", api.url("api/genres/${ApiClient.segment("R&B/Soul")}").toString())
        assertEquals("https://m.example.com/api/genres/Hip%20Hop%2FRap%3F/mix", api.url("api/genres/${ApiClient.segment("Hip Hop/Rap?")}/mix").toString())
        assertEquals("https://m.example.com/api/genres/K%C3%B6lsch", api.url("api/genres/${ApiClient.segment("Kölsch")}").toString())
    }

    @Test fun queryValuesAreEscapedButCommasKept() {
        val api = ApiClient("https://m.example.com")
        assertEquals("https://m.example.com/api/search?limit=20&q=a%26b%3Dc%2Bd%20e", api.url("api/search", mapOf("q" to "a&b=c+d e", "limit" to "20", "x" to null)).toString())
        assertEquals("https://m.example.com/api/tracks?ids=t1,t2", api.url("api/tracks", mapOf("ids" to "t1,t2")).toString())
    }
}

class ApiClientCallTest {
    @Test fun bearerAndGenrePaths() = runTest {
        StubServer().use { s ->
            val api = s.client()
            s.answers["/tracks"] = 200 to """{"items":[]}"""
            s.answers["/mix"] = 200 to """{"items":[]}"""
            s.answers["Soul"] = 200 to """{"name":"R&B/Soul","topArtists":[],"albums":[],"recent":[]}"""
            api.genre("R&B/Soul"); api.genreTracks("R&B/Soul"); api.genreMix("Hip Hop/Rap?")
            assertEquals(listOf("/api/genres/R&B%2FSoul", "/api/genres/R&B%2FSoul/tracks", "/api/genres/Hip%20Hop%2FRap%3F/mix"), s.seen.map { it.requestUrl!!.encodedPath })
            assertEquals("Bearer T", s.seen[0].getHeader("Authorization"))
            assertEquals("application/json", s.seen[0].getHeader("Accept"))
        }
    }

    @Test fun requestAlbumPostsTheMbid() = runTest {
        StubServer().use { s ->
            s.answers["/api/requests"] = 200 to """{"status":"queued","id":12,"artist":"A","title":"T"}"""
            assertEquals("queued", s.client().requestAlbum("mb-1"))
            val r = s.seen[0]
            assertEquals("POST", r.method)
            assertEquals(mapOf("album_id" to JsonPrimitive("mb-1")), SlopifyJson.parseToJsonElement(r.body.readUtf8()).jsonObject)
        }
    }

    @Test fun radarKeepsArtistName() = runTest {
        StubServer().use { s ->
            s.answers["/api/radar"] = 200 to """{"releases":[{"album_id":"m","title":"New","rtype":"Album","date":"2026-11-01","image":null,"artistId":"a","artistName":"Band","inLibrary":null,"localName":null,"requestStatus":null}]}"""
            val r = s.client().radar()
            assertEquals("Band", r.first().artistName)
            assertEquals("m:a", r.first().key)
            s.answers.clear(); s.answers["/api/radar"] = 200 to """{"releases":null}"""
            assertTrue(s.client().radar().isEmpty())
        }
    }

    @Test fun limitsAndBrowse() = runTest {
        StubServer().use { s ->
            s.answers["/api/albums"] = 200 to """{"items":[],"total":0}"""
            s.answers["/api/artists"] = 200 to """{"items":[],"total":0}"""
            s.answers["/api/browse"] = 200 to """{"tiles":[]}"""
            val api = s.client()
            api.albums(limit = 2); api.artists(limit = 1); api.browse(); api.albums(sortAdded = true, limit = 3)
            assertEquals(listOf("limit=2", "limit=1", null, "limit=3&sort=added"), s.seen.map { it.requestUrl!!.encodedQuery })
        }
    }

    @Test fun tracksInBatchesOfAHundred() = runTest {
        StubServer().use { s ->
            s.answers["/api/tracks"] = 200 to """{"items":[]}"""
            s.client().tracks((0 until 250).map { "t$it" })
            assertEquals(listOf(100, 100, 50), s.seen.map { it.requestUrl!!.queryParameter("ids")!!.split(",").size })
        }
    }

    @Test fun downloadsAndRetry() = runTest {
        StubServer().use { s ->
            s.answers["/api/downloads"] = 200 to """{"scope":"all","items":[{"id":7,"title":"T","state":"failed","total":10,"done":2}],"counts":{},"stuckAfterMs":1000,"watcher":null,"now":1}"""
            s.answers["/retry"] = 200 to """{"ok":true,"id":7}"""
            val api = s.client()
            assertEquals(7, api.downloads(DownloadScope.All).items.first().id)
            api.retryDownload(7)
            assertEquals("scope=all", s.seen[0].requestUrl!!.encodedQuery)
            assertEquals("POST", s.seen[1].method)
            assertEquals("/api/downloads/7/retry", s.seen[1].requestUrl!!.encodedPath)
        }
    }

    @Test fun historyStatsSendsRangeAndOffset() = runTest {
        StubServer().use { s ->
            s.answers["/api/history"] = 200 to """{"connected":true,"streams":3,"minutes":9,"topTracks":[],"byHour":[]}"""
            assertEquals(3, s.client().historyStats("4w").numbers.streams)
            val u = s.seen[0].requestUrl!!
            assertEquals("4w", u.queryParameter("range"))
            assertEquals(timezoneOffsetMinutes().toString(), u.queryParameter("tzo"))
        }
    }

    @Test fun lyricJobLists() = runTest {
        StubServer().use { s ->
            s.answers["/api/lyrics/sync"] = 200 to """{"jobs":[{"trackId":"t1","title":"X","state":"running","step":"align","ahead":0,"result":null,"requested":1,"finished":null}]}"""
            s.answers["/t1/sync"] = 200 to """{"trackId":"t1","title":"X","state":"queued","step":null,"ahead":2,"result":null,"requested":1,"finished":null,"already":true}"""
            s.answers["/api/lyrics/nope"] = 404 to """{"error":"no lyrics"}"""
            val api = s.client()
            assertEquals("running", api.lyricJobs(listOf("t1", "t2")).first().state)
            assertEquals(1, api.myLyricJobs().size)
            assertTrue(api.lyricJobs(emptyList()).isEmpty())
            assertEquals(true, api.requestLyricSync("t1").already)
            assertEquals(listOf("ids=t1,t2", "mine=1", null), s.seen.map { it.requestUrl!!.encodedQuery })
            assertNull(api.lyrics("nope"))
        }
    }

    @Test fun folderCoverCarriesRev() = runTest {
        StubServer().use { s ->
            s.answers["/cover"] = 200 to """{"ok":true,"cover":"abc"}"""
            assertEquals("abc", s.client().setFolderCover("fd_1", byteArrayOf(1, 2, 3), "r123").cover)
            val r = s.seen[0]
            assertEquals("/api/library/folders/fd_1/cover", r.requestUrl!!.encodedPath)
            assertEquals("r123", r.getHeader("X-Slopify-Rev"))
            assertEquals("image/jpeg", r.getHeader("Content-Type"))
            assertEquals(3L, r.bodySize)
        }
    }

    @Test fun bodies() = runTest {
        StubServer().use { s ->
            s.answers["/api/playlists"] = 200 to """{"id":"pl_1","name":"N"}"""
            s.answers["/layout"] = 200 to """{"order":["a"],"folders":[]}"""
            val api = s.client()
            api.changePassword(null, "new")
            api.createPlaylist("N", listOf("t1"))
            api.putLibraryLayout(listOf("a"), mapOf("fd_1" to listOf("pl_1")), "r1")
            api.removeFromPlaylist("pl_1", listOf(1, 5, 3))
            val pw = SlopifyJson.parseToJsonElement(s.seen[0].body.readUtf8()).jsonObject
            assertEquals(setOf("password"), pw.keys)
            assertEquals("t1", SlopifyJson.parseToJsonElement(s.seen[1].body.readUtf8()).jsonObject["trackIds"]!!.jsonArray[0].jsonPrimitive.content)
            assertEquals("PUT", s.seen[2].method); assertEquals("r1", s.seen[2].getHeader("X-Slopify-Rev"))
            assertEquals(listOf("/5", "/3", "/1"), s.seen.drop(3).map { it.requestUrl!!.encodedPath.substringAfterLast("/tracks") })
            assertTrue(s.seen.drop(3).all { it.method == "DELETE" })
        }
    }

    @Test fun prefsPatchRoundTrips() = runTest {
        StubServer().use { s ->
            s.answers["/api/prefs"] = 200 to """{"normalize":false,"x":{"a":1}}"""
            val p = s.client().patchPrefs(mapOf("normalize" to JsonPrimitive(false)))
            assertEquals(JsonPrimitive(false), p["normalize"]); assertTrue("x" in p)
            assertEquals("PATCH", s.seen[0].method)
        }
    }

    @Test fun reachabilityIsReported() = runTest {
        StubServer().use { s ->
            val api = s.client()
            val seen = mutableListOf<Boolean>()
            api.onReachability = { seen += it }
            runCatching { api.me() }
            assertEquals(listOf(true), seen)
            // A refused connect is "unreachable".
            val dead = ApiClient("http://127.0.0.1:1", "T")
            dead.onReachability = { seen += it }
            try { dead.me(); fail() } catch (_: ApiError.Offline) {}
            assertEquals(listOf(true, false), seen)
        }
    }

    @Test fun unauthorizedAndPasswordChange() = runTest {
        StubServer().use { s ->
            val api = s.client()
            var out = 0; var pw = 0
            api.onUnauthorized = { out++ }
            api.onPasswordChangeRequired = { pw++ }
            s.answers["/api/auth/me"] = 401 to """{"error":"unauthorized"}"""
            try { api.me(); fail() } catch (_: ApiError.Unauthorized) {}
            s.answers["/api/auth/login"] = 401 to """{"error":"bad password"}"""
            try { api.login("a", "b", "d"); fail() } catch (e: ApiError.Http) { assertEquals(401, e.status); assertEquals("bad password", e.message) }
            assertEquals(1, out)
            s.answers.clear(); s.answers["/api/albums"] = 403 to """{"error":"password change required"}"""
            try { api.albums(); fail() } catch (_: ApiError.PasswordChangeRequired) {}
            assertEquals(1, pw)
            s.answers["/api/albums"] = 500 to """not json"""
            try { api.albums(); fail() } catch (e: ApiError.Http) { assertEquals(500, e.status) }
            s.answers["/api/albums"] = 200 to """{"nope":1}"""
            try { api.albums(); fail() } catch (_: ApiError.Decoding) {}
        }
    }

    @Test fun demoSignIn() = runTest {
        StubServer().use { s ->
            s.answers["/api/auth/demo"] = 204 to ""
            assertNull(s.client(null).demoSignIn("Pixel"))
            s.answers["/api/auth/demo"] = 200 to """{"token":"g","user":{"id":"u","name":"Guest 1","role":"admin"},"demo":true}"""
            assertEquals("g", s.client(null).demoSignIn("Pixel")?.token)
        }
    }
}
