package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.model.AlbumDetail
import com.lukasbaxter.slopify.android.core.model.ArtistDetail
import com.lukasbaxter.slopify.android.core.model.DownloadsPage
import com.lukasbaxter.slopify.android.core.model.HistoryStats
import com.lukasbaxter.slopify.android.core.model.PlaylistDetail
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.model.User
import com.lukasbaxter.slopify.android.core.model.asString
import com.lukasbaxter.slopify.android.core.session.QueueItem
import com.lukasbaxter.slopify.android.core.session.toTrack
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelDecodingTest {
    // JSON from ios/docs/API.md §5.1
    private val trackJson = """{"id":"0f6c1a5e9b2d4c3a8e7f6a5b4c3d2e1f","title":"Paranoid Android","artist":"Radiohead","artists":["Radiohead"],"artistIds":["a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4"],"albumId":"1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d","album":"OK Computer","albumArtist":"Radiohead","trackNo":2,"discNo":1,"year":1997,"genres":["Alternative Rock"],"durationMs":383000,"codec":"FLAC","bitrate":1011000,"cover":"5f1d","format":{"codec":"FLAC","lossless":true,"bitrate":1011000,"sampleRate":44100,"bitDepth":16},"gain":{"track":-6.3,"album":-5.8},"identity":{"state":"matched","score":0.97},"addedAt":1760000000000}"""

    @Test fun track() {
        val t = SlopifyJson.decodeFromString(Track.serializer(), trackJson)
        assertEquals(383.0, t.duration, 0.0)
        assertEquals(-5.8, t.gain?.album)
        assertEquals("a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4", t.artistCredits.first().id)
        val q = QueueItem.of(t)
        assertEquals(3_830_000_000L, q.runTimeTicks)
        // PascalCase on the wire, and back to a Track.
        val wire = SlopifyJson.encodeToString(QueueItem.serializer(), q)
        assertTrue(wire.contains("\"RunTimeTicks\":3830000000") && wire.contains("\"ArtistItems\"") && wire.contains("\"_queued\":false"))
        val back = q.toTrack()
        assertEquals(t.id, back.id); assertEquals(t.durationMs, back.durationMs); assertEquals(t.artistIds, back.artistIds)
    }

    @Test fun trackNeedsItsRequiredFields() {
        val r = runCatching { SlopifyJson.decodeFromString(Track.serializer(), """{"id":"x","title":"T"}""") }
        assertTrue(r.isFailure)
    }

    @Test fun albumDetailFlattened() {
        val json = """{"id":"a","name":"OK Computer","artist":"Radiohead","artistId":"b","year":1997,"trackCount":0,"durationMs":0,"cover":null,"addedAt":1,"tracks":[]}"""
        val d = SlopifyJson.decodeFromString(AlbumDetail.serializer(), json)
        assertEquals("OK Computer", d.album.name)
        assertEquals(0, d.tracks.size)
        assertEquals(d, SlopifyJson.decodeFromString(AlbumDetail.serializer(), SlopifyJson.encodeToString(AlbumDetail.serializer(), d)))
    }

    @Test fun artistAndPlaylistDetailDefaults() {
        val a = SlopifyJson.decodeFromString(ArtistDetail.serializer(), """{"id":"a","name":"R","followed":null}""")
        assertFalse(a.followed); assertTrue(a.albums.isEmpty()); assertTrue(a.tracks.isEmpty())
        val p = SlopifyJson.decodeFromString(PlaylistDetail.serializer(), """{"id":"pl_1","name":"Mix"}""")
        assertEquals("Mix", p.playlist.name); assertTrue(p.tracks.isEmpty())
    }

    @Test fun prefsKeepUnknownKeys() {
        val json = """{"theme":{"accent":"#1ed760"},"normalize":false,"weird":[1,"x",null]}"""
        val p = SlopifyJson.parseToJsonElement(json).jsonObject
        assertEquals("#1ed760", p["theme"]?.jsonObject?.get("accent").asString())
        assertEquals(JsonPrimitive(false), p["normalize"])
        assertEquals(p, SlopifyJson.parseToJsonElement(JsonObject(p).toString()))
    }

    @Test fun releaseYearStringOrNumber() {
        val a = SlopifyJson.decodeFromString(Release.serializer(), """{"album_id":"m","title":"New","year":2026,"artistId":"a"}""")
        assertEquals("2026", a.year); assertEquals("m:a", a.key)
        val b = SlopifyJson.decodeFromString(Release.serializer(), """{"title":"Old","year":"1999","total_tracks":9}""")
        assertEquals("1999", b.year); assertEquals(9, b.totalTracks); assertEquals("Old:", b.key)
        val c = SlopifyJson.decodeFromString(Release.serializer(), """{"title":"X","year":null}""")
        assertNull(c.year)
        assertEquals(a, SlopifyJson.decodeFromString(Release.serializer(), SlopifyJson.encodeToString(Release.serializer(), a)))
        assertFalse(SlopifyJson.encodeToString(Release.serializer(), c).contains("year"))
    }

    @Test fun userFlags() {
        val g = SlopifyJson.decodeFromString(User.serializer(), """{"id":"u","name":"Guest 12","role":"admin"}""")
        assertTrue(g.isGuest); assertFalse(g.isAdmin)
    }

    @Test fun historyStatsLenient() {
        val s = SlopifyJson.decodeFromString(
            HistoryStats.reader,
            """{"connected":true,"total":4.0,"sources":{"spotify":2},"streams":3,"minutes":9.6,"prev":{"streams":1},
               "topTracks":[{"name":"A","count":2,"seconds":10.5},{"broken":true}],"byHour":"nope","perDay":[{"day":"2026-11-01","count":1,"minutes":3}]}""",
        )
        assertTrue(s.connected); assertEquals(4, s.total); assertEquals(2, s.spotify)
        assertEquals(3, s.numbers.streams); assertEquals(10, s.numbers.minutes); assertEquals(1, s.prev?.streams)
        assertEquals(1, s.topTracks.size); assertEquals(24, s.byHour.size); assertEquals(1, s.perDay.size)
        assertEquals(false, SlopifyJson.decodeFromString(HistoryStats.reader, "{}").connected)
    }

    @Test fun downloadsLenient() {
        val d = SlopifyJson.decodeFromString(
            DownloadsPage.reader,
            """{"scope":"all","items":[{"id":7,"title":"T","state":"failed","total":10,"done":2,"year":1999},{"title":"no id"}],"stuckAfterMs":1000,"watcher":null,"now":1}""",
        )
        assertEquals(1, d.items.size); assertEquals(7, d.items[0].id); assertEquals("1999", d.items[0].year)
        assertEquals(1000.0, d.stuckAfterMs); assertNull(d.watcher)
    }
}
