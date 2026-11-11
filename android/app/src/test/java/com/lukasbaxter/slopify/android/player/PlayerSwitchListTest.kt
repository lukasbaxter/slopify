package com.lukasbaxter.slopify.android.player

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ios PlayerSwitchListTests (owner report: "played a daily mix, then went to a personal
 * playlist and was unable to start the song"). Each test plays a mix, leaves the Player in
 * one of the states a mix can leave behind, then plays another list: it must start there.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PlayerSwitchListTest {
    private val mixContext = "mix:ar1"
    private val playlist = "pl_mine"

    private fun mixTracks() = (1..6).map { playerTrack("m$it", album = "al$it") }
    private fun listTracks() = (1..5).map { playerTrack("p$it", album = "bl$it") }

    private fun assertStarted(r: PlayerRig, id: String) {
        assertEquals(id, r.s.current?.id)
        assertEquals(playlist, r.s.context)
        assertTrue(r.s.isPlaying)
        assertNull(r.s.error)
        assertFalse(r.s.isRemote)
        assertEquals("the engine must hold the tapped song", id, r.e.currentId)
        assertEquals(id, r.e.loads.last().first.id)
        assertTrue(r.e.playing)
    }

    @Test fun mixThenPrewarmThenPlaylistRowStarts() = runTest {
        val r = makePlayer()
        r.p.play(mixTracks(), 0, mixContext)
        r.p.audioHeard("m1")
        runCurrent()
        assertEquals("the mix had its next song prepared", "m2", r.e.next?.first?.id)
        val list = listTracks()
        r.p.prewarm(list[2])
        runCurrent()
        assertEquals(1, r.b.prewarms.size)
        r.p.play(list, 2, playlist)
        assertStarted(r, "p3")
        assertEquals(list.map { it.id }, r.ids)
        assertEquals("p3", r.l.reports.last()?.itemId)
        r.p.audioHeard("p3")
        runCurrent()
        assertEquals("the next song follows the new list, not the mix", "p4", r.e.next?.first?.id)
    }

    @Test fun pendingSkipDebounceDoesNotSwallowTheNewPlay() = runTest {
        val r = makePlayer()
        r.p.play(mixTracks(), 0, mixContext)
        r.p.next(); r.p.next() // rapid: the load waits 300 ms
        r.p.play(listTracks(), 1, playlist)
        assertStarted(r, "p2")
        advanceTimeBy(400); runCurrent()
        assertStarted(r, "p2") // the stale deferred load must not replace it
    }

    @Test fun autoplayInFlightDoesNotOverrideTheNewPlay() = runTest {
        val r = makePlayer()
        r.p.play(mixTracks(), 5, mixContext)
        runCurrent()
        r.b.mixes["m6"] = (1..3).map { playerTrack("x$it") }
        r.p.audioEnded("m6") // autoplay job starts
        r.p.play(listTracks(), 0, playlist)
        runCurrent()
        assertStarted(r, "p1")
        assertEquals("no mix songs appended to the new list", listTracks().map { it.id }, r.ids)
    }

    @Test fun failedMixSongDoesNotBlock() = runTest {
        val r = makePlayer()
        r.p.play(mixTracks(), 0, mixContext)
        r.p.audioFailed("m1", "transcode failed")
        assertNotNull(r.s.error)
        assertFalse(r.s.isPlaying)
        r.p.play(listTracks(), 3, playlist)
        assertStarted(r, "p4")
    }

    @Test fun pausedMixThenPlaylist() = runTest {
        val r = makePlayer()
        r.p.play(mixTracks(), 0, mixContext)
        r.p.togglePlay()
        assertFalse(r.s.isPlaying)
        r.p.play(listTracks(), 0, playlist)
        assertStarted(r, "p1")
    }

    @Test fun sameSongInMixAndPlaylist() = runTest {
        val r = makePlayer()
        val list = listTracks().toMutableList().also { it[1] = playerTrack("m2", album = "al2") }
        r.p.play(mixTracks(), 0, mixContext)
        r.p.audioHeard("m1")
        runCurrent()
        assertEquals("m2", r.e.next?.first?.id)
        r.p.play(list, 1, playlist)
        assertStarted(r, "m2")
    }

    @Test fun shuffleFromMixKeepsTappedRowFirst() = runTest {
        val r = makePlayer()
        r.p.play(mixTracks(), 0, mixContext, shuffle = true)
        r.p.play(listTracks(), 4, playlist)
        assertStarted(r, "p5")
        assertEquals(0, r.s.index)
    }
}
