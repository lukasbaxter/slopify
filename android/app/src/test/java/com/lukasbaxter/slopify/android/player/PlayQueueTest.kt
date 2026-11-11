package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class PlayQueueTest {
    private val rng = Random(7)
    private fun ids(q: PlayQueue) = q.entries.map { it.track.id }

    @Test fun startUnshuffledKeepsOrderAndIndex() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b", "c"), 1, "al1", rng)
        assertEquals(listOf("a", "b", "c"), ids(q))
        assertEquals(1, q.index)
        assertEquals("al1", q.context)
    }

    @Test fun startShuffledPutsChosenFirst() {
        val q = PlayQueue(shuffle = ShuffleMode.On)
        q.start(playerTracks("a", "b", "c", "d", "e"), 3, null, rng)
        assertEquals(0, q.index)
        assertEquals("d", q.entries[0].track.id)
        assertEquals(setOf("a", "b", "c", "d", "e"), ids(q).toSet())
        assertEquals(listOf("a", "b", "c", "d", "e"), q.original.map { it.track.id })
    }

    @Test fun addToQueueGoesAfterCurrentAndEarlierQueued() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b", "c"), 0, null, rng)
        q.add(playerTracks("x"))
        q.add(playerTracks("y", "z"))
        assertEquals(listOf("a", "x", "y", "z", "b", "c"), ids(q))
        assertEquals(listOf(false, true, true, true, false, false), q.entries.map { it.queued })
    }

    @Test fun addToEmptyQueueBecomesQueue() {
        val q = PlayQueue()
        assertTrue(q.add(playerTracks("x", "y")))
        assertEquals(listOf("x", "y"), ids(q))
        assertEquals(listOf(false, false), q.entries.map { it.queued })
    }

    @Test fun insertNextGoesStraightAfterCurrent() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b"), 0, null, rng)
        q.add(playerTracks("x"))
        q.insertNext(playerTracks("n"))
        assertEquals(listOf("a", "n", "x", "b"), ids(q))
    }

    @Test fun removeNeverCurrentAndShiftsIndex() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b", "c", "d"), 2, null, rng)
        assertFalse(q.remove(2))
        assertTrue(q.remove(0))
        assertEquals(listOf("b", "c", "d"), ids(q))
        assertEquals(1, q.index)
        assertEquals("c", q.current?.track?.id)
    }

    @Test fun moveOnlyUpcoming() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b", "c", "d"), 1, null, rng)
        assertFalse(q.move(0, 3))
        assertFalse(q.move(2, 1))
        assertTrue(q.move(3, 2))
        assertEquals(listOf("a", "b", "d", "c"), ids(q))
    }

    @Test fun clearQueuedOnlyAfterCurrent() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b"), 0, null, rng)
        q.add(playerTracks("x", "y"))
        q.clearQueued()
        assertEquals(listOf("a", "b"), ids(q))
    }

    @Test fun shuffleThenUnshuffleKeepsCurrent() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b", "c", "d", "e"), 2, null, rng)
        q.setShuffle(ShuffleMode.On, rng)
        assertEquals(0, q.index)
        assertEquals("c", q.current?.track?.id)
        q.index = 2
        val playing = q.current!!.track.id
        q.setShuffle(ShuffleMode.Off, rng)
        assertEquals(listOf("a", "b", "c", "d", "e"), ids(q))
        assertEquals(playing, q.current?.track?.id)
    }

    @Test fun unshuffleDropsSmartPicks() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b", "c", "d", "e", "f", "g"), 0, null, rng)
        q.setShuffle(ShuffleMode.Smart, rng)
        assertEquals(2, q.blendSmart(playerTracks("r1", "r2")))
        assertEquals(2, q.entries.count { it.rec })
        assertTrue(q.entries[4].rec) // after every third upcoming song
        q.setShuffle(ShuffleMode.Off, rng)
        assertFalse(q.entries.any { it.rec })
        assertEquals(7, q.entries.size)
    }

    @Test fun blendSmartNeedsFourLeftAndSkipsKnown() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b", "c"), 0, null, rng)
        assertEquals(0, q.blendSmart(playerTracks("r1")))
        q.start(playerTracks("a", "b", "c", "d"), 0, null, rng)
        assertEquals(0, q.blendSmart(playerTracks("b")))
        assertEquals(1, q.smartWant)
    }

    @Test fun restartShuffledNeverOpensOnLastSong() {
        for (seed in 0 until 30) {
            val r = Random(seed)
            val q = PlayQueue(shuffle = ShuffleMode.On)
            q.start(playerTracks("a", "b", "c"), 0, null, r)
            q.index = 2
            val last = q.current!!.track.id
            q.restartOrder(r)
            assertEquals(0, q.index)
            assertNotEquals(last, q.entries[0].track.id)
        }
    }

    @Test fun advanceRules() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b"), 0, "al1", rng)
        assertEquals(Advance.Skip(1), q.advance(auto = true, sleepEndOfTrack = false))
        q.index = 1
        assertEquals(Advance.Autoplay(orRestart = true), q.advance(auto = true, sleepEndOfTrack = false))
        q.repeatMode = RepeatMode.All
        assertEquals(Advance.Restart, q.advance(auto = true, sleepEndOfTrack = false))
        q.repeatMode = RepeatMode.One
        assertEquals(Advance.Replay, q.advance(auto = true, sleepEndOfTrack = false))
        q.index = 0
        assertEquals("next skips even with repeat one", Advance.Skip(1), q.advance(auto = false, sleepEndOfTrack = false))
        assertEquals(Advance.Replay, q.advance(auto = true, sleepEndOfTrack = false))
        q.repeatMode = RepeatMode.Off; q.context = "artist:ar9"; q.index = 1
        assertEquals(Advance.MoreOfArtist("ar9"), q.advance(auto = true, sleepEndOfTrack = false))
        q.context = null
        assertEquals(Advance.Autoplay(orRestart = false), q.advance(auto = true, sleepEndOfTrack = false))
    }

    @Test fun sleepEndOfTrackParksOnNext() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b"), 0, null, rng)
        assertEquals(Advance.SleepStop(1), q.advance(auto = true, sleepEndOfTrack = true))
        q.index = 1
        assertEquals(Advance.SleepStop(1), q.advance(auto = true, sleepEndOfTrack = true))
        q.repeatMode = RepeatMode.All
        assertEquals(Advance.SleepStop(0), q.advance(auto = true, sleepEndOfTrack = true))
        assertEquals("a manual next is not the timer", Advance.Restart, q.advance(auto = false, sleepEndOfTrack = true))
    }

    @Test fun previousRule() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b"), 1, null, rng)
        assertEquals(Advance.Replay, q.previous(3.5))
        assertEquals(Advance.Skip(0), q.previous(2.0))
        q.index = 0
        assertEquals("first song restarts", Advance.Replay, q.previous(1.0))
    }

    @Test fun autoplayAppendDropsSeedAndKnown() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b"), 1, null, rng)
        assertEquals(2, q.appendAutoplay(playerTracks("b", "a", "c", "d"), "b", rng = rng))
        assertEquals("mix order kept without smart shuffle", listOf("a", "b", "c", "d"), ids(q))
    }

    @Test fun autoplayFallbackAllowsRepeatsButNotSeed() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b"), 1, null, rng)
        assertEquals(0, q.appendAutoplay(playerTracks("b", "a"), "b", rng = rng))
        assertEquals(1, q.appendAutoplay(playerTracks("b", "a"), "b", fallbackAllowNonSeed = true, rng = rng))
        assertEquals(listOf("a", "b", "a"), ids(q))
    }

    @Test fun earlyExtensionWindow() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b", "c", "d"), 0, null, rng)
        assertFalse(q.wantsEarlyExtension(remoteActive = false))
        q.index = 2
        assertTrue(q.wantsEarlyExtension(remoteActive = false))
        assertFalse(q.wantsEarlyExtension(remoteActive = true))
        q.repeatMode = RepeatMode.All
        assertFalse(q.wantsEarlyExtension(remoteActive = false))
        q.repeatMode = RepeatMode.Off; q.context = "artist:x"
        assertFalse(q.wantsEarlyExtension(remoteActive = false))
    }

    @Test fun upcoming() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b"), 1, null, rng)
        assertNull(q.upcomingIndex)
        q.repeatMode = RepeatMode.All
        assertEquals(0, q.upcomingIndex)
        assertEquals("a", q.upcoming?.track?.id)
        q.shuffle = ShuffleMode.On
        assertNull("a shuffled restart reshuffles first", q.upcomingIndex)
        q.repeatMode = RepeatMode.One
        assertEquals(1, q.upcomingIndex)
        assertNull(q.upcoming)
    }

    @Test fun transferPayload() {
        val q = PlayQueue()
        q.start(playerTracks("a", "b", "c"), 1, "pl_1", rng)
        q.add(playerTracks("x"))
        val t = q.transfer(12.0, playing = true, deviceId = "local")
        assertEquals(listOf("a", "b", "x", "c"), t.trackIds)
        assertEquals(listOf(false, false, true, false), t.queued)
        assertEquals(1, t.index)
        assertEquals("pl_1", t.ctx)
        assertNull(t.original)
        q.setShuffle(ShuffleMode.On, rng)
        assertEquals(listOf("a", "b", "x", "c"), q.transfer(0.0, false, "local").original)
    }

    @Test fun markedCarriesFlagsOverSkippedIds() {
        val rows = PlayQueue.marked(playerTracks("a", "c"), listOf("a", "b", "c"), listOf(false, true, true))
        assertEquals(listOf(false, true), rows.map { it.queued })
        assertEquals(listOf(false, false), PlayQueue.marked(playerTracks("a", "c"), listOf("a", "c"), null).map { it.queued })
    }

    @Test fun adoptClampsAndKeepsOriginal() {
        val q = PlayQueue()
        val rows = playerTracks("a", "b").map { QueueEntry(it) }
        q.adopt(rows, 9, context = "x")
        assertEquals(1, q.index)
        assertEquals(rows, q.original)
        q.adopt(rows, 0, original = emptyList(), context = null)
        assertEquals("an empty original falls back to the rows", rows, q.original)
    }

    @Test fun jsonRoundTrip() {
        val q = PlayQueue(repeatMode = RepeatMode.All)
        q.start(playerTracks("a", "b"), 1, "x", rng)
        q.add(playerTracks("q"))
        val back = SlopifyJson.decodeFromString(PlayQueue.serializer(), SlopifyJson.encodeToString(PlayQueue.serializer(), q))
        assertEquals(q, back)
    }
}
