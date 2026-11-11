package com.lukasbaxter.slopify.android.features.detail

import com.lukasbaxter.slopify.android.core.StubServer
import com.lukasbaxter.slopify.android.core.model.AlbumDetail
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.design.L
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

private const val DETAIL_ALBUM_JSON = """
{"id":"al1","name":"OK Computer","artist":"Radiohead","artistId":"ar1","year":1997,"trackCount":1,"durationMs":383000,"cover":null,"addedAt":1,
 "tracks":[{"id":"t1","title":"Paranoid Android","artist":"Radiohead","artists":["Radiohead"],"artistIds":["ar1"],"albumId":"al1","album":"OK Computer",
 "albumArtist":"Radiohead","trackNo":2,"discNo":1,"year":1997,"genres":[],"durationMs":383000,"codec":"FLAC","bitrate":1011000,"cover":null}]}
"""

private const val DETAIL_ARTIST_JSON = """
{"id":"ar1","name":"Radiohead","trackCount":3,"albumCount":1,"image":null,"banner":null,"followed":true,
 "albums":[{"id":"al1","name":"OK Computer","artist":"Radiohead","artistId":"ar1","year":1997,"trackCount":12,"durationMs":3180000}],
 "appearsOn":[],
 "tracks":[
  {"id":"t1","title":"A","artist":"Radiohead","artists":["Radiohead"],"artistIds":["ar1"],"albumId":"al1","album":"OK Computer","albumArtist":"Radiohead","durationMs":1000},
  {"id":"t2","title":"B","artist":"Radiohead","artists":["Radiohead"],"artistIds":["ar1"],"albumId":"al1","album":"OK Computer","albumArtist":"Radiohead","durationMs":1000},
  {"id":"t3","title":"C","artist":"Radiohead","artists":["Radiohead"],"artistIds":["ar1"],"albumId":"al1","album":"OK Computer","albumArtist":"Radiohead","durationMs":1000}]}
"""

class DetailCacheTest {
    private val dir: File = Files.createTempDirectory("detail-cache").toFile()

    @After fun cleanUp() {
        dir.deleteRecursively()
        DetailArtistModel.forgetSession()
    }

    private val mapSer = MapSerializer(String.serializer(), Int.serializer())

    @Test fun roundTripPerScopeAndTrim() {
        val c = DetailCache(dir)
        c.save(mapOf("x" to 1), "al.1", "u1", mapSer)
        assertEquals(mapOf("x" to 1), c.load("al.1", "u1", mapSer))
        assertNull(c.load("al.1", "u2", mapSer))
        // A fresh instance reads from disk.
        assertEquals(mapOf("x" to 1), DetailCache(dir).load("al.1", "u1", mapSer))
        val listSer = ListSerializer(Int.serializer())
        for (i in 0 until DetailCache.LIMIT + 5) c.save(listOf(i), "al.n$i", "u1", listSer)
        val files = dir.listFiles()!!.filter { it.name.endsWith(".json") }
        assertEquals(DetailCache.LIMIT, files.size)
        // Oldest written go first: the newest survives, the first one is gone.
        assertEquals(listOf(DetailCache.LIMIT + 4), DetailCache(dir).load("al.n${DetailCache.LIMIT + 4}", "u1", listSer))
        assertNull(DetailCache(dir).load("al.1", "u1", mapSer))
    }

    @Test fun albumDetailDecodesFromApiShapeAndSurvivesTheCache() {
        val d = SlopifyJson.decodeFromString(AlbumDetail.serializer(), DETAIL_ALBUM_JSON)
        assertEquals("ar1", d.album.artistId)
        assertEquals("ar1", d.tracks.first().artistCredits.first().id)
        val c = DetailCache(dir)
        c.save(d, "al.al1", "u1", AlbumDetail.serializer())
        assertEquals(d, DetailCache(dir).load("al.al1", "u1", AlbumDetail.serializer()))
    }

    @Test fun albumModelPaintsKeptCopyThenFailsQuietly() = runBlocking {
        StubServer().use { s ->
            s.answers["/api/albums/al1"] = 200 to DETAIL_ALBUM_JSON
            val cache = DetailCache(dir)
            val first = DetailAlbumModel("al1", Dispatchers.Unconfined)
            first.load(s.client(), "u1", cache)
            assertEquals("OK Computer", first.album?.name)
            assertFalse(first.loading)
            assertNull(first.emptyNote)

            // The server now fails: the kept copy still paints, no failure note.
            s.answers["/api/albums/al1"] = 500 to """{"error":"boom"}"""
            val again = DetailAlbumModel("al1", Dispatchers.Unconfined)
            again.load(s.client(), "u1", cache)
            assertEquals(listOf("t1"), again.tracks.map { it.id })
            assertFalse(again.loadFailed)

            // Another account has nothing kept: the failure note shows.
            val other = DetailAlbumModel("al1", Dispatchers.Unconfined)
            other.load(s.client(), "u2", cache)
            assertTrue(other.loadFailed)
            assertEquals(L("Couldn’t load this — try again."), other.emptyNote)
        }
    }

    @Test fun artistModelOrdersPopularAndTracksRequests() = runBlocking {
        StubServer().use { s ->
            s.answers["/api/artists/ar1/popular"] = 200 to """{"ids":["t3","t1"]}"""
            s.answers["/api/artists/ar1"] = 200 to DETAIL_ARTIST_JSON
            s.answers["/api/discography/ar1"] = 200 to
                """{"releases":[{"album_id":"m1","title":"Kid A","rtype":"Album","year":"2000"},{"album_id":"m2","title":"OK Computer","inLibrary":"al1","year":"1997"}]}"""
            s.answers["/api/similar/ar1"] = 200 to """{"artists":[{"name":"Muse","id":"ar9"},{"name":"Nobody"}]}"""
            s.answers["/api/requests"] = 200 to """{"status":"queued"}"""
            val m = DetailArtistModel("ar1", Dispatchers.Unconfined)
            m.load(s.client(), "u1", DetailCache(dir))
            assertEquals(listOf("t3", "t1", "t2"), m.tracks.map { it.id })
            assertTrue(m.followed)
            assertTrue(m.discog is DetailDiscog.Loaded)
            assertEquals(2, m.similar.size)
            assertEquals("library album listed by the catalogue is not added twice", 2, m.entries.size)
            assertFalse(m.hasPending)

            val kidA = m.entries.first { it.mbid == "m1" }
            m.request(kidA, s.client())
            assertEquals("queued", m.requestState(m.entries.first { it.mbid == "m1" }))
            assertTrue(m.hasPending)

            // The kept page paints the popular order before the network answers.
            val kept = DetailCache(dir).load("ar.ar1", "u1", DetailArtistPage.serializer())
            assertNotNull(kept)
            assertEquals(listOf("t3", "t1"), kept?.popular)
        }
    }

    @Test fun artistRequestFailureMarksError() = runBlocking {
        StubServer().use { s ->
            s.answers["/api/discography/ar2"] = 200 to """{"releases":[{"album_id":"m1","title":"X"}]}"""
            s.answers["/api/requests"] = 500 to """{"error":"lidarr down"}"""
            val m = DetailArtistModel("ar2", Dispatchers.Unconfined)
            m.loadDiscography(s.client())
            val e = m.entries.first()
            val thrown = runCatching { m.request(e, s.client()) }.exceptionOrNull()
            assertNotNull(thrown)
            assertEquals("error", m.requestState(e))
            assertEquals("Failed", DetailLogic.requestLabel(m.requestState(e)).key)
        }
    }
}
