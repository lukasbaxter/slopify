package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.model.Gain
import com.lukasbaxter.slopify.android.core.session.Command
import com.lukasbaxter.slopify.android.core.session.LanDevice
import com.lukasbaxter.slopify.android.core.session.QueueItem
import com.lukasbaxter.slopify.android.core.session.RosterPlayer
import com.lukasbaxter.slopify.android.core.session.SessionConnection
import com.lukasbaxter.slopify.android.core.session.SessionSnapshot
import com.lukasbaxter.slopify.android.core.session.SleepState
import com.lukasbaxter.slopify.android.core.session.toTrack
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files

@OptIn(ExperimentalCoroutinesApi::class)
class SlopifyPlayerTest {
    private fun TestScope.settle() = runCurrent()

    // Local start

    @Test fun playClaimsLoadsReportsAndPublishes() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b", "c"), 1, "pl_1")
        assertEquals(1, r.l.claims)
        assertEquals(1, r.e.loads.size)
        assertEquals("b", r.e.loads[0].first.id)
        val url = r.e.loads[0].first.url
        assertTrue(url, "max=aac-320" in url)
        assertTrue(url, "norm=track" in url)
        assertEquals("b", r.s.current?.id)
        assertTrue(r.s.isPlaying)
        assertTrue(r.s.isLoading)
        assertFalse(r.s.isRemote)
        val last = r.l.reports.last()!!
        assertEquals("b", last.itemId)
        assertEquals(1, last.queueIndex)
        assertTrue(last.playing)
        assertEquals(true, last.held)
        assertEquals("local", last.device?.id)
        assertTrue(last.artUrl!!.contains("token=tok"))
        assertEquals(listOf("a", "b", "c"), r.l.published.last().map { it.id })
        assertEquals(1, r.focus.activations)
        r.p.audioHeard("b")
        assertFalse(r.s.isLoading)
        assertEquals(false, r.l.reports.last()?.held)
    }

    @Test fun albumContextUsesAlbumGainAndLosslessAppliesGain() = runTest {
        val r = makePlayer(prefs = mapOf("phoneQuality" to JsonPrimitive("original")))
        r.p.play(listOf(playerTrack("a", album = "al1", gain = Gain(-6.0206, -12.0412))), 0, "al1")
        val item = r.e.loads[0].first
        assertTrue("max=alac" in item.url)
        assertEquals("album gain applied by the player for lossless", 0.25f, item.gain, 0.001f)
        val r2 = makePlayer()
        r2.p.play(listOf(playerTrack("a", album = "al1")), 0, "al1")
        assertTrue("norm=album" in r2.e.loads[0].first.url)
    }

    @Test fun tabletReadsQualityPref() = runTest {
        val r = makePlayer(prefs = mapOf("quality" to JsonPrimitive("low")))
        r.p.isTablet = true
        r.p.play(playerTracks("a"))
        assertTrue("max=aac-96" in r.e.loads[0].first.url)
    }

    @Test fun localFileWinsOverStream() = runTest {
        val r = makePlayer()
        val file = File("/tmp/a.m4a")
        r.p.localFile = { if (it == "a") file else null }
        r.p.play(playerTracks("a"))
        assertEquals(file.toURI().toString(), r.e.loads[0].first.url)
    }

    @Test fun shuffleArgumentKeepsChosenFirst() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b", "c", "d"), 2, shuffle = true)
        assertEquals(ShuffleMode.On, r.s.shuffle)
        assertEquals(0, r.s.index)
        assertEquals("c", r.s.current?.id)
        r.p.setShuffle(ShuffleMode.Off)
        assertEquals(listOf("a", "b", "c", "d"), r.ids)
        assertEquals("c", r.s.current?.id)
    }

    @Test fun addToQueueFlagsAndPreview() = runTest {
        val r = makePlayer()
        r.p.addToQueue(playerTracks("x"))
        assertEquals(listOf("x"), r.ids)
        assertFalse("an empty queue just shows them paused", r.s.isPlaying)
        r.p.play(playerTracks("a", "b"))
        r.p.addToQueue(playerTracks("q1"))
        r.p.addToQueue(playerTracks("q2"))
        assertEquals(listOf("a", "q1", "q2", "b"), r.ids)
        assertEquals(listOf(false, true, true, false), r.s.queuedFlags)
        r.p.playNext(playerTracks("n"))
        assertEquals(listOf("a", "n", "q1", "q2", "b"), r.ids)
        r.p.clearQueued()
        assertEquals(listOf("a", "b"), r.ids)
    }

    @Test fun queueEditsLocally() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b", "c", "d"), 1)
        r.p.removeFromQueue(1)
        assertEquals("the current song stays", listOf("a", "b", "c", "d"), r.ids)
        r.p.removeFromQueue(0)
        assertEquals(listOf("b", "c", "d"), r.ids)
        assertEquals(0, r.s.index)
        r.p.moveInQueue(2, 1)
        assertEquals(listOf("b", "d", "c"), r.ids)
    }

    @Test fun previousRestartsPastThreeSeconds() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b"), 1)
        r.e.currentTime = 12.0
        r.p.previous()
        assertEquals(listOf(0.0), r.e.seeks)
        assertEquals("b", r.s.current?.id)
        r.e.currentTime = 1.0
        r.p.previous()
        assertEquals("a", r.s.current?.id)
    }

    @Test fun nextAtEndAutoplaysDroppingSeed() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b"), 1)
        settle() // the early extension found nothing
        r.b.mixes["b"] = playerTracks("b", "c", "d")
        r.b.mixCalls.clear()
        r.p.audioEnded("b")
        settle()
        assertEquals(Triple("b", 25, "continue"), r.b.mixCalls.first())
        assertEquals(listOf("a", "b", "c", "d"), r.ids)
        assertEquals("c", r.s.current?.id)
        assertEquals("c", r.e.loads.last().first.id)
    }

    @Test fun autoplayWithNothingParksOrRestarts() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b"), 1)
        settle()
        r.p.audioEnded("b")
        settle()
        assertEquals("no context: park on the last song", "b", r.s.current?.id)
        assertFalse(r.s.isPlaying)
        assertEquals(0.0, r.position, 0.0)
        val r2 = makePlayer()
        r2.p.play(playerTracks("a", "b"), 1, "pl_1")
        settle()
        r2.p.audioEnded("b")
        settle()
        assertEquals("with a context: from the top", "a", r2.s.current?.id)
        assertTrue(r2.s.isPlaying)
    }

    @Test fun smartShuffleAutoplayAsksSmart() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"), 0, shuffle = true)
        r.p.setShuffle(ShuffleMode.Smart)
        settle()
        r.b.mixCalls.clear()
        r.p.next()
        settle()
        assertEquals("smart", r.b.mixCalls.first().third)
    }

    @Test fun artistContextPlaysMoreOfArtistThenRestarts() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b"), 1, "artist:ar1")
        settle()
        assertTrue("no early extension for artist pages", r.b.mixCalls.isEmpty())
        r.b.mixes["ar1"] = playerTracks("x")
        r.p.audioEnded("b")
        settle()
        assertEquals("the artist fetch failed, its mix filled in", listOf("a", "b", "x"), r.ids)
        assertEquals("x", r.s.current?.id)
    }

    @Test fun earlyExtensionAppendsBeforeTheEnd() = runTest {
        val r = makePlayer()
        r.b.mixes["c"] = playerTracks("c", "x", "y")
        r.p.play(playerTracks("a", "b", "c"), 1)
        settle()
        assertEquals(listOf("a", "b", "c", "x", "y"), r.ids)
    }

    @Test fun dislikedNeverAutoplayed() = runTest {
        val r = makePlayer(prefs = mapOf("dislikes" to kotlinx.serialization.json.JsonObject(mapOf("x" to JsonPrimitive(1)))))
        r.b.mixes["c"] = playerTracks("x", "y")
        r.p.play(playerTracks("a", "b", "c"), 1)
        settle()
        assertEquals(listOf("a", "b", "c", "y"), r.ids)
    }

    @Test fun repeatAllRestartsAndRepeatOneReplays() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b"), 1)
        r.p.setRepeat(RepeatMode.All)
        r.p.audioEnded("b")
        assertEquals("a", r.s.current?.id)
        r.p.setRepeat(RepeatMode.One)
        r.p.audioEnded("a")
        assertEquals("a", r.s.current?.id)
        assertEquals(listOf("b", "a", "a"), r.e.loads.map { it.first.id })
        assertEquals(RepeatMode.One, r.s.repeatMode)
    }

    @Test fun repeatOnePreparesTheSameSongGapless() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b"))
        r.p.setRepeat(RepeatMode.One)
        r.p.audioHeard("a")
        settle()
        assertEquals("a", r.e.next?.first?.id)
        assertEquals(AudioTransition.Gapless, r.e.next?.second)
    }

    @Test fun sleepEndOfTrackParksPaused() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b"))
        r.p.audioHeard("a")
        settle()
        assertEquals("b", r.e.next?.first?.id)
        r.l.edit { it.copy(sleep = SleepState(null, endOfTrack = true)) }
        settle()
        assertNull("the timer drops the prepared song", r.e.next?.first)
        r.p.audioEnded("a")
        assertEquals("b", r.s.current?.id)
        assertFalse(r.s.isPlaying)
        assertEquals(0.0, r.position, 0.0)
        assertEquals(1, r.l.sleepDones)
        assertTrue(r.e.unloads > 0)
    }

    @Test fun gaplessPreloadAndAutomaticAdvance() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b"), 0, "pl_1")
        r.p.audioHeard("a")
        settle()
        assertEquals("b", r.e.next?.first?.id)
        assertEquals(AudioTransition.Gapless, r.e.next?.second)
        r.p.audioAdvanced("b")
        assertEquals("b", r.s.current?.id)
        assertEquals("no reload for a gapless hand-over", 1, r.e.loads.size)
        assertEquals("b", r.l.reports.last()?.itemId)
    }

    @Test fun nextWaitsForTheHeadStart() = runTest {
        val r = makePlayer()
        r.p.headStartMs = 4000.0
        r.p.play(playerTracks("a", "b"))
        settle()
        assertNull("nothing heard yet", r.e.next?.first)
        r.p.audioHeard("a")
        advanceTimeBy(2000); settle()
        assertNull(r.e.next?.first)
        advanceTimeBy(2500); settle()
        assertEquals("b", r.e.next?.first?.id)
    }

    @Test fun advanceUnderAMovedQueuePlaysWhatTheQueueSays() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b", "c"))
        r.p.audioHeard("a")
        settle()
        r.p.audioAdvanced("zzz")
        assertEquals("b", r.s.current?.id)
        assertEquals("b", r.e.loads.last().first.id)
    }

    @Test fun crossfadePref() = runTest {
        val r = makePlayer(prefs = mapOf("crossfade" to JsonPrimitive(5)))
        r.p.play(playerTracks("a", "b"), 0, "pl_1")
        r.p.audioHeard("a")
        settle()
        assertEquals(AudioTransition.Crossfade(5.0), r.e.next?.second)
    }

    @Test fun gaplessOffOnlyBuffers() = runTest {
        val r = makePlayer(prefs = mapOf("gapless" to JsonPrimitive(false)))
        r.p.play(playerTracks("a", "b"), 0, "pl_1")
        r.p.audioHeard("a")
        settle()
        assertEquals(AudioTransition.None, r.e.next?.second)
    }

    @Test fun warmsUpcoming() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b", "c", "d", "e"))
        r.p.audioHeard("a")
        advanceTimeBy(3300); settle()
        assertEquals(listOf("b", "c", "d"), r.b.warms.last())
    }

    @Test fun pausePositionAndReports() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.p.audioHeard("a")
        r.e.currentTime = 42.0
        r.p.togglePlay()
        assertFalse(r.s.isPlaying)
        assertFalse(r.e.playing)
        assertEquals(42.0, r.position, 0.0)
        assertEquals(false, r.l.reports.last()?.playing)
        assertEquals(42.0, r.l.reports.last()!!.position, 0.0)
        r.p.togglePlay()
        assertTrue(r.e.playing)
        assertEquals("no reload to resume", 1, r.e.loads.size)
    }

    @Test fun tickerMovesProgressWhilePlaying() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.p.audioHeard("a")
        val tick = r.p.progress.value.tick
        r.e.currentTime = 3.0
        advanceTimeBy(1100); settle()
        assertEquals(3.0, r.position, 0.0)
        assertTrue(r.p.progress.value.tick >= tick + 2)
        r.p.setPlaying(false)
        val stopped = r.p.progress.value.tick
        advanceTimeBy(2000); settle()
        assertEquals("the ticker stops when paused", stopped, r.p.progress.value.tick)
    }

    @Test fun playAfterRestoreLoadsAtSavedPosition() = runTest {
        val r = makePlayer()
        r.p.addToQueue(playerTracks("a"))
        r.p.seek(30.0)
        r.p.setPlaying(true)
        assertEquals(1, r.l.claims)
        assertEquals("a", r.e.loads.last().first.id)
        assertEquals(30.0, r.e.loads.last().second, 0.0)
    }

    @Test fun playsPostedOnlyWithoutSocket() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.p.audioHeard("a")
        r.p.countListen(9.0)
        settle()
        assertEquals("socket up: the server logs it", emptyList<String>(), r.b.plays)
        r.l.edit { it.copy(connection = SessionConnection.Disconnected) }
        r.p.previous() // replay from the top counts again
        r.p.audioHeard("a")
        r.p.countListen(5.0)
        settle()
        assertEquals(emptyList<String>(), r.b.plays)
        r.p.countListen(4.0)
        settle()
        assertEquals(listOf("a"), r.b.plays)
    }

    @Test fun offlinePlayGoesToTheHook() = runTest {
        val r = makePlayer()
        val queued = mutableListOf<String>()
        r.p.onOfflinePlay = { id, _ -> queued += id }
        r.l.edit { it.copy(connection = SessionConnection.Disconnected) }
        r.b.offline = true
        r.p.play(playerTracks("a"))
        r.p.audioHeard("a")
        r.p.countListen(9.0)
        settle()
        assertEquals(listOf("a"), queued)
    }

    @Test fun startRadioPlaysTheMixOrShowsTheError() = runTest {
        val r = makePlayer()
        r.b.mixes["seed"] = playerTracks("r1", "r2")
        r.p.startRadio("seed", "mix:seed")
        assertEquals(Triple("seed", 100, "radio"), r.b.mixCalls.last())
        assertEquals(listOf("r1", "r2"), r.ids)
        assertEquals("mix:seed", r.s.context)
        assertTrue(r.s.isPlaying)
    }

    @Test fun failureShowsErrorAndNewPlayClearsIt() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.p.audioFailed("a", "boom")
        assertEquals("boom", r.s.error)
        assertFalse(r.s.isPlaying)
        r.p.audioFailed("other", "ignored")
        assertEquals("boom", r.s.error)
        r.p.play(playerTracks("b"))
        assertNull(r.s.error)
    }

    @Test fun streamDurationReplacesLibraryLength() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.p.audioDuration("a", 187.5)
        assertEquals(187.5, r.p.progress.value.duration, 0.0)
    }

    // Audio focus and the media session

    @Test fun focusLossPausesAndTransientGainResumes() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.p.audioHeard("a")
        r.focus.onInterruptionBegan?.invoke()
        assertFalse(r.s.isPlaying)
        assertFalse(r.e.playing)
        r.focus.onInterruptionEnded?.invoke(true)
        assertTrue(r.s.isPlaying)
        assertTrue(r.e.playing)
        r.p.setPlaying(false)
        r.focus.onInterruptionBegan?.invoke()
        r.focus.onInterruptionEnded?.invoke(true)
        assertFalse("paused by the user: no resume", r.s.isPlaying)
    }

    @Test fun becomingNoisyPauses() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.focus.onRouteLost?.invoke()
        assertFalse(r.s.isPlaying)
        r.focus.onInterruptionEnded?.invoke(true)
        assertFalse(r.s.isPlaying)
    }

    @Test fun lockScreenFollowsLocalPlayback() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b"), 1)
        val info = r.lock.updates.last()!!
        assertEquals("b", info.id)
        assertEquals(1, info.index)
        assertEquals(2, info.queue.size)
        assertTrue(info.playing)
        assertTrue(info.loaded)
        assertTrue(info.artUrl!!.contains("size=640"))
        val h = r.p.lockScreenHandlers()
        assertTrue(h.pause())
        assertFalse(r.s.isPlaying)
        assertFalse(r.lock.updates.last()!!.playing)
        assertTrue(h.previous())
        assertEquals("a", r.s.current?.id)
        assertTrue(h.next())
        assertEquals("b", r.s.current?.id)
        assertTrue(h.skipTo(0))
        assertEquals("a", r.s.current?.id)
        advanceTimeBy(400); settle() // rapid skips load once the taps stop
        assertEquals("a", r.e.currentId)
        assertTrue(h.seek(20.0))
        assertEquals(20.0, r.e.seeks.last(), 0.0)
        assertEquals(20.0, h.position(), 0.0)
        assertEquals("a seek republishes the playhead", 20.0, r.lock.updates.last()!!.elapsed, 0.0)
    }

    @Test fun lockScreenHandlersRefuseWithNothingQueued() = runTest {
        val r = makePlayer()
        assertFalse(r.p.lockScreenHandlers().play())
        assertFalse(r.p.lockScreenHandlers().like(true))
    }

    @Test fun lockScreenLikeOverridesTheReport() = runTest {
        val r = makePlayer()
        r.p.likes = com.lukasbaxter.slopify.android.core.stores.Likes()
        r.p.play(playerTracks("a"))
        assertTrue(r.p.lockScreenHandlers().like(true))
        assertEquals(true, r.l.reports.last()?.liked)
        assertTrue(r.lock.updates.last()!!.liked)
    }

    @Test fun outputLagOnlyWhilePlayingHere() = runTest {
        val r = makePlayer()
        assertEquals(0.0, r.p.outputLag(), 0.0)
        r.p.play(playerTracks("a"))
        assertEquals(0.25, r.p.outputLag(), 0.0)
        r.p.setPlaying(false)
        assertEquals(0.0, r.p.outputLag(), 0.0)
    }

    @Test fun volumeGoesToTheEngine() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.p.setVolume(140.0)
        assertEquals(100.0, r.s.volume, 0.0)
        r.p.setVolume(30.0)
        assertEquals(0.3f, r.e.level, 0.001f)
        assertEquals(30.0, r.l.reports.last()!!.volume!!, 0.0)
    }

    // Mirror

    private fun mirror(r: PlayerRig, playing: Boolean = true) {
        r.l.edit {
            it.copy(
                activeClientId = "desk",
                players = listOf(RosterPlayer("desk", "Desk", "desktop", "laptop", true, playerNp("y", 1, playing, 33.0), true)),
                queues = mapOf("desk" to playerTracks("x", "y", "z").map { t -> QueueItem.of(t) }),
            )
        }
        r.p.sessionChanged()
    }

    @Test fun mirrorRendersRemoteAndRoutesControls() = runTest {
        val r = makePlayer()
        mirror(r)
        assertTrue(r.s.isRemote)
        assertEquals("desk", r.s.remoteClientId)
        assertEquals("Desk", r.s.output.name)
        assertEquals(listOf("x", "y", "z"), r.ids)
        assertEquals(1, r.s.index)
        assertTrue(r.s.isPlaying)
        assertEquals(33.0, r.position, 0.0)
        assertEquals(33.0, r.p.positionNow(), 0.0)
        assertEquals(70.0, r.s.volume, 0.0)
        assertEquals(RepeatMode.All, r.s.repeatMode)
        assertNull("mirrors show no notification", r.lock.updates.lastOrNull())
        val reportsBefore = r.l.reports.size
        r.p.togglePlay()
        r.p.next(); r.p.previous(); r.p.seek(5.0); r.p.skipTo(2); r.p.setVolume(20.0)
        r.p.setRepeat(RepeatMode.One); r.p.setShuffle(ShuffleMode.On); r.p.addToQueue(playerTracks("n")); r.p.removeFromQueue(2)
        r.p.moveInQueue(2, 1); r.p.clearQueued()
        r.p.play(playerTracks("k", "m"), 1, "al9")
        assertEquals(List(13) { "desk" }, r.l.sent.map { it.second })
        assertEquals(
            listOf(
                Command.SetPlaying(false), Command.Next, Command.Previous, Command.Seek(5.0), Command.SkipTo(2), Command.SetVolume(20.0),
                Command.SetRepeat("one"), Command.SetShuffle("on"), Command.Enqueue(listOf("n")), Command.QueueRemove(2),
                Command.QueueMove(2, 1), Command.QueueClear, Command.Play(listOf("k", "m"), 1, "al9", null),
            ),
            r.l.sent.map { it.first },
        )
        assertEquals("mirrors never report", reportsBefore, r.l.reports.size)
        assertEquals(0, r.l.claims)
        assertTrue(r.e.loads.isEmpty())
    }

    @Test fun mirrorFollowsTheSessionFlow() = runTest {
        val r = makePlayer()
        r.l.edit {
            it.copy(
                activeClientId = "desk",
                players = listOf(RosterPlayer("desk", "Desk", nowPlaying = playerNp("y", playing = false))),
            )
        }
        settle()
        assertTrue(r.s.isRemote)
        assertEquals("no published queue: the song alone", listOf("y"), r.ids)
        assertFalse(r.s.isPlaying)
    }

    @Test fun mirrorResolvesProvisionalTracks() = runTest {
        val r = makePlayer()
        r.b.library["y"] = playerTrack("y").copy(title = "Full Y", cover = "hash")
        mirror(r)
        settle()
        assertEquals("Full Y", r.s.queue[1].title)
    }

    @Test fun mirrorEndsBackToLocal() = runTest {
        val r = makePlayer()
        r.p.addToQueue(playerTracks("a"))
        mirror(r)
        assertTrue(r.s.isRemote)
        r.l.edit { it.copy(activeClientId = null, players = emptyList()) }
        r.p.sessionChanged()
        assertFalse(r.s.isRemote)
        assertEquals(listOf("a"), r.ids)
        assertEquals(100.0, r.s.volume, 0.0)
    }

    @Test fun handOffToClientStopsHere() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a", "b"), 1, "pl_1")
        r.e.currentTime = 50.0
        r.p.transferToClient("desk")
        val (cmd, to) = r.l.sent.last()
        val t = (cmd as? Command.Transfer)?.transfer ?: return@runTest fail("no transfer")
        assertEquals("desk", to)
        assertEquals(listOf("a", "b"), t.trackIds)
        assertEquals(1, t.index)
        assertEquals(50.0, t.position, 0.0)
        assertTrue(t.playing)
        assertEquals("pl_1", t.ctx)
        assertEquals("local", t.deviceId)
        assertFalse(r.s.isPlaying)
        assertTrue(r.e.unloads > 0)
        assertNull(r.lock.updates.last())
        assertEquals(1, r.focus.deactivations)
        assertNull(r.s.deliveredProfile)
    }

    @Test fun speakerTransferGoesViaClient() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.p.transferToSpeaker(LanDevice("bluos:1", "bluos", "Node", viaClient = "server:u1"))
        val (cmd, to) = r.l.sent.last()
        assertEquals("server:u1", to)
        assertEquals("bluos:1", (cmd as Command.Transfer).transfer.deviceId)
        r.l.edit { it.copy(players = listOf(RosterPlayer("server:u9", "Server"))) }
        r.p.play(playerTracks("a"))
        r.p.transferToSpeaker(LanDevice("bluos:2", "bluos", "Node 2"))
        assertEquals("no viaClient: the server client", "server:u9", r.l.sent.last().second)
    }

    @Test fun takeOverFromMirror() = runTest {
        val r = makePlayer()
        mirror(r)
        r.p.transferToClient(null)
        assertEquals(1, r.l.claims)
        assertFalse(r.s.isRemote)
        assertEquals(listOf("x", "y", "z"), r.ids)
        assertEquals("y", r.e.loads.last().first.id)
        assertEquals(33.0, r.e.loads.last().second, 0.0)
        assertTrue(r.s.isPlaying)
        assertEquals("roster lag after the claim does not re-mirror", false, run { r.p.sessionChanged(); r.s.isRemote })
    }

    @Test fun transferToSelfWhenLocalResumes() = runTest {
        val r = makePlayer()
        r.p.addToQueue(playerTracks("a"))
        r.p.transferToClient("me")
        assertTrue(r.s.isPlaying)
        assertEquals("a", r.e.loads.last().first.id)
    }

    @Test fun mirrorHandOffBuildsFromActiveQueue() = runTest {
        val r = makePlayer()
        mirror(r)
        r.p.transferToClient("tv")
        val (cmd, to) = r.l.sent.last()
        val t = (cmd as Command.Transfer).transfer
        assertEquals("tv", to)
        assertEquals(listOf("x", "y", "z"), t.trackIds)
        assertEquals(1, t.index)
        assertEquals(33.0, t.position, 0.0)
    }

    // Commands

    @Test fun transferCommandStartsThenFillsQueue() = runTest {
        val r = makePlayer()
        for (t in playerTracks("x", "y", "z")) r.b.library[t.id] = t
        r.p.handle(
            Command.Transfer(Command.TransferPayload(listOf("x", "y", "z"), listOf(false, false, true), 1, 20.0, true, "pl_2", null, "local")),
            "desk",
        )
        assertEquals(1, r.l.claims)
        settle()
        assertEquals("y", r.e.loads.first().first.id)
        assertEquals(20.0, r.e.loads.first().second, 0.0)
        assertEquals("the queue fill does not restart the song", 1, r.e.loads.size)
        assertEquals(listOf("x", "y", "z"), r.ids)
        assertEquals(listOf(false, false, true), r.s.queuedFlags)
        assertEquals(1, r.s.index)
        assertEquals("pl_2", r.s.context)
    }

    @Test fun transferOfUnknownTrackShowsError() = runTest {
        val r = makePlayer()
        r.p.handle(Command.Transfer(Command.TransferPayload(listOf("gone"), null, 0, 0.0, true, null, null, "local")), "desk")
        settle()
        assertEquals("Could not take over playback: track not found", r.s.error)
        r.p.clearError()
        assertNull(r.s.error)
    }

    @Test fun pausedTransferShowsWithoutLoading() = runTest {
        val r = makePlayer()
        r.b.library["x"] = playerTrack("x")
        r.p.handle(Command.Transfer(Command.TransferPayload(listOf("x"), null, 0, 9.0, false, null, null, "local")), "desk")
        settle()
        assertEquals("x", r.s.current?.id)
        assertEquals(9.0, r.position, 0.0)
        assertFalse(r.s.isPlaying)
        assertTrue(r.e.loads.isEmpty())
    }

    @Test fun playCommandHonoursShuffle() = runTest {
        val r = makePlayer()
        for (t in playerTracks("a", "b", "c", "d")) r.b.library[t.id] = t
        r.p.setShuffle(ShuffleMode.On)
        r.p.handle(Command.Play(listOf("a", "b", "c", "d"), 2, null, null), "phone2")
        settle()
        assertEquals("c", r.e.loads.first().first.id)
        assertEquals("c", r.s.current?.id)
        assertEquals(0, r.s.index)
        assertEquals(setOf("a", "b", "c", "d"), r.ids.toSet())
    }

    @Test fun simpleCommands() = runTest {
        val r = makePlayer()
        r.b.library["n"] = playerTrack("n")
        r.p.play(playerTracks("a", "b", "c"))
        r.p.handle(Command.SetVolume(30.0), "x")
        assertEquals(30.0, r.s.volume, 0.0)
        assertEquals(0.3f, r.e.level, 0.001f)
        r.p.handle(Command.VolumeStep(1), "x")
        assertEquals(35.0, r.s.volume, 0.0)
        r.p.handle(Command.SetRepeat("all"), "x")
        assertEquals(RepeatMode.All, r.s.repeatMode)
        r.p.handle(Command.Seek(12.0), "x")
        assertEquals(12.0, r.e.seeks.last(), 0.0)
        r.p.handle(Command.Next, "x")
        assertEquals("b", r.s.current?.id)
        r.p.handle(Command.SkipTo(0), "x")
        advanceTimeBy(400); settle()
        assertEquals("a", r.s.current?.id)
        r.p.handle(Command.Enqueue(listOf("n")), "x")
        settle()
        assertEquals(listOf("a", "n", "b", "c"), r.ids)
        r.p.handle(Command.QueueRemove(1), "x")
        assertEquals(listOf("a", "b", "c"), r.ids)
        r.p.handle(Command.PatchLiked("a", true), "x")
        assertEquals(true, r.l.reports.last()?.liked)
        r.p.handle(Command.SetPlaying(false), "server")
        assertFalse(r.s.isPlaying)
        r.p.handle(Command.Toggle, "x")
        assertTrue(r.s.isPlaying)
        r.p.handle(Command.SetShuffle("smart"), "x")
        assertEquals(ShuffleMode.Smart, r.s.shuffle)
        r.p.handle(Command.Previous, "x")
        r.p.handle(Command.Unknown("dance"), "x")
        assertTrue("commands are executed here, never routed back", r.l.sent.isEmpty())
    }

    @Test fun yieldUnloadsAndStopsReporting() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.p.handle(Command.Yield, "desk")
        assertFalse(r.s.isPlaying)
        assertNull(r.e.currentId)
        val n = r.l.reports.size
        r.p.setVolume(10.0)
        assertEquals("nothing loaded and not active: no reports", n, r.l.reports.size)
    }

    @Test fun onCommandIsWired() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.l.onCommand?.invoke(Command.SetPlaying(false), "desk")
        assertFalse(r.s.isPlaying)
    }

    @Test fun becomingActiveRepublishes() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        val n = r.l.published.size
        r.l.edit { it.copy(activeClientId = "me") }
        settle()
        assertEquals(n + 1, r.l.published.size)
    }

    // Session snapshot (§20.4)

    @Test fun adoptsSessionWhenEmpty() = runTest {
        val r = makePlayer()
        r.l.edit { it.copy(lastSession = SessionSnapshot(playerNp("y", 1, false, 77.0), playerTracks("x", "y").map { t -> QueueItem.of(t) }, 1000.0)) }
        r.p.sessionChanged()
        assertEquals(listOf("x", "y"), r.ids)
        assertEquals(1, r.s.index)
        assertEquals(77.0, r.position, 0.0)
        assertFalse(r.s.isPlaying)
        assertTrue(r.e.loads.isEmpty())
    }

    @Test fun ignoresSessionWhilePlayingHere() = runTest {
        val r = makePlayer()
        r.p.play(playerTracks("a"))
        r.l.edit { it.copy(lastSession = SessionSnapshot(playerNp("y", playing = false), playerTracks("y").map { t -> QueueItem.of(t) }, PLAYER_T0 + 10_000)) }
        r.p.sessionChanged()
        assertEquals("a", r.s.current?.id)
    }

    @Test fun sessionWithoutMatchingQueueShowsTrackAlone() = runTest {
        val r = makePlayer()
        r.l.edit { it.copy(lastSession = SessionSnapshot(playerNp("q", 0, false, 5.0), emptyList(), 1000.0)) }
        r.p.sessionChanged()
        assertEquals(listOf("q"), r.ids)
        assertEquals("Tq", r.s.current?.title)
    }

    // Persistence

    private fun tempStore(): PlayerPersistence = PlayerPersistence(Files.createTempDirectory("player").toFile())

    @Test fun persistenceRoundTrip() = runTest {
        val store = tempStore()
        try {
            val r = makePlayer(store = store)
            r.p.play(playerTracks("a", "b", "c"), 1)
            r.p.addToQueue(playerTracks("q"))
            r.p.setRepeat(RepeatMode.All)
            r.p.setVolume(60.0)
            r.e.currentTime = 64.0
            r.p.flushPersistence()

            val r2 = makePlayer(store = store)
            assertEquals(listOf("a", "b", "q", "c"), r2.ids)
            assertEquals(listOf(false, false, true, false), r2.s.queuedFlags)
            assertEquals("b", r2.s.current?.id)
            assertEquals(64.0, r2.position, 0.0)
            assertEquals(RepeatMode.All, r2.s.repeatMode)
            assertEquals(60.0, r2.s.volume, 0.0)
            assertFalse("a relaunch shows the last song paused", r2.s.isPlaying)
            assertTrue(r2.e.loads.isEmpty())
            assertTrue(r2.p.savedAt > 0)
        } finally {
            store.dir.deleteRecursively()
        }
    }

    @Test fun debouncedQueueSaveLands() = runTest {
        val store = tempStore()
        try {
            val r = makePlayer(store = store)
            r.p.play(playerTracks("a", "b"))
            advanceTimeBy(1500); settle()
            store.flush(null, null) // drain the writer
            assertEquals(listOf("a", "b"), store.load()?.queue?.entries?.map { it.track.id })
        } finally {
            store.dir.deleteRecursively()
        }
    }

    @Test fun persistenceClampsAndPrefersTrackId() {
        val store = tempStore()
        try {
            val q = PlayQueue()
            q.start(playerTracks("a", "b", "c"), 0, null, kotlin.random.Random(1))
            store.flush(q, PlayerPersistence.Playhead("c", 0, 999.0, RepeatMode.One, ShuffleMode.Off, null, 5.0))
            val saved = store.load()!!
            assertEquals(2, saved.queue.index)
            assertEquals(200.0, saved.position, 0.0)
            assertEquals(RepeatMode.One, saved.queue.repeatMode)
            assertNull(saved.volume)
            assertNull(PlayerPersistence(File(store.dir, "nothing")).load())
        } finally {
            store.dir.deleteRecursively()
        }
    }

    @Test fun forAccountSanitisesTheFolder() {
        val p = PlayerPersistence.forAccount(File("/tmp/root"), "https://a.example.com|u1")
        assertEquals("https___a_example_com_u1", p.dir.name)
        assertEquals("player", p.dir.parentFile?.name)
    }

    @Test fun newerOwnPlayheadBeatsOlderSession() = runTest {
        val store = tempStore()
        try {
            val r = makePlayer(store = store)
            r.p.play(playerTracks("a"))
            r.p.flushPersistence()
            val r2 = makePlayer(store = store)
            r2.l.edit { it.copy(lastSession = SessionSnapshot(playerNp("old", playing = false), emptyList(), 1000.0)) }
            r2.p.sessionChanged()
            assertEquals("a", r2.s.current?.id)
            r2.l.edit { it.copy(lastSession = SessionSnapshot(playerNp("new", playing = false), emptyList(), PLAYER_T0 + 60_000)) }
            r2.p.sessionChanged()
            assertEquals("new", r2.s.current?.id)
        } finally {
            store.dir.deleteRecursively()
        }
    }

    // Report shape

    @Test fun nowPlayingReportShape() {
        val t = playerTrack("a", album = "al1", artistId = "ar1")
        val rep = SessionReports.nowPlaying(
            SessionReports.LocalState(
                t, 2, playing = true, held = false, position = 10.0, duration = 200.0, volume = 80.0,
                repeatMode = RepeatMode.One, shuffle = ShuffleMode.Smart, liked = true,
                device = com.lukasbaxter.slopify.android.core.session.OutputDevice.local("This Phone"), artUrl = null, now = 5.0,
            ),
        )
        assertEquals("a", rep.itemId)
        assertEquals(listOf(com.lukasbaxter.slopify.android.core.session.NameId("ar1", "Artist")), rep.artists)
        assertEquals("ar1", rep.artistId)
        assertEquals("one", rep.repeat)
        assertEquals("smart", rep.shuffle)
        assertEquals(false, rep.held)
        assertEquals(2, rep.queueIndex)
    }

    @Test fun trackFromQueueItemRoundTrip() {
        val t = playerTrack("a", ms = 383_000, gain = Gain(-6.3, -5.8))
        val back = QueueItem.of(t).toTrack()
        assertEquals("a", back.id)
        assertEquals(383_000, back.durationMs)
        assertEquals(t.gain, back.gain)
        assertEquals(listOf("ar1"), back.artistIds)
        assertEquals("al1", back.albumId)
    }

    @Test fun takeOverIndexTrustsOnlyMatchingQueueIndex() {
        val q = playerTracks("x", "y").map { QueueItem.of(it) }
        assertEquals(1, SessionReports.queueIndex(playerNp("y", 1), q))
        assertNull(SessionReports.queueIndex(playerNp("y", 0), q))
        val t = SessionReports.takeOver(playerNp("y", 0), q)
        assertEquals(listOf("y"), t.ids)
        assertNotNull(SessionReports.takeOver(playerNp("y", 1), q).queued)
    }
}
