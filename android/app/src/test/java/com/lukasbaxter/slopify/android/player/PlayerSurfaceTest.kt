package com.lukasbaxter.slopify.android.player

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** clearError, recFlags, deliveredProfile, prewarm (ios PlayerSurfaceTests). */
@OptIn(ExperimentalCoroutinesApi::class)
class PlayerSurfaceTest {
    @Test fun recFlagsFollowTheQueue() = runTest {
        val r = makePlayer()
        r.b.mixes["a"] = playerTracks("r1", "r2", "r3", "r4", "r5")
        r.p.play(playerTracks("a", "b", "c", "d", "e", "f"))
        assertEquals(List(6) { false }, r.s.recFlags)
        r.p.setShuffle(ShuffleMode.Smart)
        runCurrent()
        assertEquals(r.s.queue.size, r.s.recFlags.size)
        assertTrue(r.s.recFlags.contains(true))
        for ((t, rec) in r.s.queue.zip(r.s.recFlags)) assertEquals(t.id, t.id.startsWith("r"), rec)
        assertEquals(Triple("a", 3, "smart"), r.b.mixCalls.last())
    }

    @Test fun deliveredProfileIsWhatWasLoaded() = runTest {
        val r = makePlayer(prefs = mapOf("phoneQuality" to JsonPrimitive("normal")))
        assertNull(r.s.deliveredProfile)
        r.p.play(playerTracks("a"))
        assertEquals(DeliveredProfile.Hls("aac-160"), r.s.deliveredProfile)
        val r2 = makePlayer()
        r2.p.localFile = { File("/tmp/a.m4a") }
        r2.p.play(playerTracks("a"))
        assertEquals(DeliveredProfile.File, r2.s.deliveredProfile)
    }

    @Test fun prewarmOncePerMinuteAndNotForFiles() = runTest {
        val r = makePlayer()
        r.p.prewarm(playerTrack("a"))
        r.p.prewarm(playerTrack("a"))
        r.p.localFile = { if (it == "f") File("/tmp/f.m4a") else null }
        r.p.prewarm(playerTrack("f"))
        runCurrent()
        assertEquals(1, r.b.prewarms.size)
        assertTrue(r.b.prewarms[0], "/a/hls/master.m3u8" in r.b.prewarms[0])
        advanceTimeBy(61_000); runCurrent()
        r.p.prewarm(playerTrack("a"))
        runCurrent()
        assertEquals("a minute later it warms again", 2, r.b.prewarms.size)
    }

    @Test fun signedOutStateStartsEmpty() = runTest {
        val r = makePlayer()
        assertEquals(emptyList<String>(), r.ids)
        assertEquals("local", r.s.output.id)
        assertEquals(100.0, r.s.volume, 0.0)
    }
}
