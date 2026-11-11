package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.model.Gain
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamPolicyTest {
    @Test fun qualityMapping() {
        assertEquals("alac", StreamPolicy.profile("original"))
        assertEquals("aac-320", StreamPolicy.profile("high"))
        assertEquals("aac-160", StreamPolicy.profile("normal"))
        assertEquals("aac-96", StreamPolicy.profile("low"))
        assertEquals("aac-320", StreamPolicy.profile(null))
    }

    @Test fun phoneVsTabletPref() {
        assertEquals("high", StreamPolicy.quality(emptyMap(), tablet = false))
        assertEquals("original", StreamPolicy.quality(emptyMap(), tablet = true))
        val p = mapOf("phoneQuality" to JsonPrimitive("low"), "quality" to JsonPrimitive("normal"))
        assertEquals("low", StreamPolicy.quality(p, tablet = false))
        assertEquals("normal", StreamPolicy.quality(p, tablet = true))
    }

    @Test fun normModeAlbumOnlyFromItsAlbum() {
        val t = playerTrack("a", album = "al1")
        assertEquals("album", StreamPolicy.normMode(t, "al1", true))
        assertEquals("track", StreamPolicy.normMode(t, "pl_x", true))
        assertEquals("track", StreamPolicy.normMode(t, null, true))
        assertNull(StreamPolicy.normMode(t, "al1", false))
        assertTrue(StreamPolicy.normalize(emptyMap()))
        assertFalse(StreamPolicy.normalize(mapOf("normalize" to JsonPrimitive(false))))
    }

    @Test fun gainRule() {
        val both = playerTrack("a", gain = Gain(-6.0, -4.0))
        assertEquals(-4.0, StreamPolicy.gainDb(both, "album"), 0.0)
        assertEquals(-6.0, StreamPolicy.gainDb(both, "track"), 0.0)
        assertEquals("album falls back to track", -3.0, StreamPolicy.gainDb(playerTrack("b", gain = Gain(-3.0, null)), "album"), 0.0)
        assertEquals("unmeasured plays as is", 0.0, StreamPolicy.gainDb(playerTrack("c"), "track"), 0.0)
        assertEquals(0.0, StreamPolicy.gainDb(both, null), 0.0)
    }

    @Test fun clientGainOnlyForLossless() {
        val t = playerTrack("a", gain = Gain(-6.0206, null))
        assertEquals(1f, StreamPolicy.clientGain(t, null, true, "aac-320"), 0f)
        assertEquals(0.5f, StreamPolicy.clientGain(t, null, true, "alac"), 0.001f)
        assertEquals(1f, StreamPolicy.clientGain(t, null, false, "alac"), 0f)
        assertEquals("positive gain capped", 1f, StreamPolicy.clientGain(playerTrack("b", gain = Gain(4.0, null)), null, true, "alac"), 0f)
    }

    @Test fun transitionPlan() {
        val a = playerTrack("a", album = "al1")
        val b = playerTrack("b", album = "al1")
        val c = playerTrack("c", album = "al2", ms = 9_000)
        assertEquals("album in order never fades", AudioTransition.Gapless, StreamPolicy.transition(a, b, "al1", 5.0, true, false, false))
        assertEquals(AudioTransition.Crossfade(5.0), StreamPolicy.transition(a, b, "pl", 5.0, true, false, false))
        assertEquals("a third of the shorter song", AudioTransition.Crossfade(3.0), StreamPolicy.transition(a, c, null, 5.0, true, false, false))
        assertEquals(AudioTransition.None, StreamPolicy.transition(a, b, null, 0.0, false, false, false))
        assertEquals(AudioTransition.None, StreamPolicy.transition(a, b, null, 5.0, true, false, true))
        assertEquals(AudioTransition.None, StreamPolicy.transition(a, b, null, 5.0, true, true, false))
        assertEquals(12.0, StreamPolicy.crossfadeSetting(mapOf("crossfade" to JsonPrimitive(30))), 0.0)
        assertTrue(StreamPolicy.gapless(emptyMap()))
        assertFalse(StreamPolicy.gapless(mapOf("gapless" to JsonPrimitive(false))))
    }

    @Test fun warmIds() {
        val rows = playerTracks("a", "b", "c", "d", "e").map { QueueEntry(it) }
        assertEquals(listOf("b", "c", "d"), StreamPolicy.warmIds(rows, 0, false))
        assertEquals(emptyList<String>(), StreamPolicy.warmIds(rows, 4, false))
        assertEquals(listOf("a"), StreamPolicy.warmIds(rows, 4, true))
    }

    @Test fun dislikesDropped() {
        val p = mapOf("dislikes" to JsonObject(mapOf("b" to JsonPrimitive(1))))
        assertEquals(listOf("a", "c"), StreamPolicy.dropDisliked(playerTracks("a", "b", "c"), p).map { it.id })
    }

    @Test fun volumeStepper() {
        val s = VolumeStepper()
        assertEquals(55.0, s.step(50.0, 1, 1000.0)!!, 0.0)
        assertNull("one step per 300 ms", s.step(55.0, 1, 1100.0))
        assertEquals(60.0, s.step(55.0, 1, 1400.0)!!, 0.0)
        assertEquals(65.0, s.step(60.0, 1, 1800.0)!!, 0.0)
        assertEquals(70.0, s.step(65.0, 1, 2200.0)!!, 0.0)
        assertNull("a run goes at most 20 up", s.step(70.0, 1, 2600.0))
        assertEquals("after a 3 s rest", 75.0, s.step(70.0, 1, 6000.0)!!, 0.0)
        assertEquals(70.0, s.step(75.0, -1, 6400.0)!!, 0.0)
    }

    @Test fun cappedProfileAndLinkWatch() {
        assertEquals("aac-320", StreamPolicy.capped("alac"))
        assertEquals("aac-96", StreamPolicy.capped("aac-96"))
        var cell = true
        var t = 0.0
        val w = LinkWatch({ cell }, { t })
        assertEquals("aac-320", w.profile("aac-320"))
        w.noteStarve()
        assertEquals("aac-160", w.profile("aac-320"))
        cell = false
        assertEquals("Wi-Fi is left alone", "aac-320", w.profile("aac-320"))
        cell = true
        t += LinkWatch.CAP_FOR_MS + 1
        assertEquals("the cap ends", "aac-320", w.profile("aac-320"))
        cell = false
        w.noteStarve()
        cell = true
        assertEquals("a Wi-Fi stall caps nothing", "aac-320", w.profile("aac-320"))
    }

    @Test fun hlsPlaylistParsing() {
        val master = """
            #EXTM3U
            #EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"
            aac-96g-5.2/index.m3u8?token=T&abr=1
            #EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS="mp4a.40.2"
            aac-320g-5.2/index.m3u8?token=T&abr=1
        """.trimIndent()
        assertEquals("aac-96g-5.2/index.m3u8?token=T&abr=1", HlsPlaylist.variants(master).first())
        val alac = """
            #EXTM3U
            #EXT-X-TARGETDURATION:5
            #EXT-X-MAP:URI="init.mp4?token=T"
            #EXTINF:4.017063,
            s0000.m4s?token=T
            #EXTINF:4.017063,
            s0001.m4s?token=T
            #EXTINF:4.017063,
            s0002.m4s?token=T
            #EXT-X-ENDLIST
        """.trimIndent()
        assertEquals(listOf("init.mp4?token=T", "s0000.m4s?token=T", "s0001.m4s?token=T"), HlsPlaylist.segments(alac, 2))
        assertEquals(listOf("s0000.ts"), HlsPlaylist.segments("#EXTM3U\n#EXTINF:4,\ns0000.ts\n", 2))
    }

    @Test fun deliveredFromUrl() {
        assertNull(SlopifyPlayer.delivered(AudioItem("a", "")))
        assertEquals(DeliveredProfile.File, SlopifyPlayer.delivered(AudioItem("a", "file:/tmp/a.m4a")))
        assertEquals(DeliveredProfile.Hls("alac"), SlopifyPlayer.delivered(AudioItem("a", "http://h/api/stream/a/hls/master.m3u8?max=alac&token=t")))
        assertEquals(DeliveredProfile.Hls("aac-320"), SlopifyPlayer.delivered(AudioItem("a", "http://h/x.m3u8")))
    }
}
