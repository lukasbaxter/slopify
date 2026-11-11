package com.lukasbaxter.slopify.android.app

import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.player.NoopPlayer
import com.lukasbaxter.slopify.android.player.RepeatMode
import com.lukasbaxter.slopify.android.player.ShuffleMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class NoopPlayerTest {
    private fun t(id: String) = Track(id, id, "A", listOf("A"), listOf("a"), "al", "Al", "A", durationMs = 1000)

    @Test fun keepsQueueState() {
        val p = NoopPlayer()
        p.play(listOf(t("1"), t("2"), t("3")), startAt = 1, context = "al")
        assertEquals("2", p.state.value.current?.id)
        p.playNext(listOf(t("n")))
        p.addToQueue(listOf(t("q")))
        assertEquals(listOf("1", "2", "n", "3", "q"), p.state.value.queue.map { it.id })
        assertEquals(listOf(false, false, true, false, true), p.state.value.queuedFlags)
        p.clearQueued()
        assertEquals(listOf("1", "2", "3"), p.state.value.queue.map { it.id })
        p.removeFromQueue(0)
        assertEquals("2", p.state.value.current?.id)
        p.moveInQueue(0, 1)
        assertEquals(listOf("3", "2"), p.state.value.queue.map { it.id })
        p.setRepeat(RepeatMode.One); p.setShuffle(ShuffleMode.Smart); p.setVolume(140.0)
        assertEquals(100.0, p.state.value.volume, 0.0)
        assertEquals(RepeatMode.All, RepeatMode.of("all")); assertEquals(ShuffleMode.Off, ShuffleMode.of("weird"))
        assertFalse(p.state.value.isRemote)
    }
}
