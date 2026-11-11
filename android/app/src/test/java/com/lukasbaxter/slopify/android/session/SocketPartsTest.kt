package com.lukasbaxter.slopify.android.session

import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.session.NowPlaying
import com.lukasbaxter.slopify.android.core.session.QueueItem
import com.lukasbaxter.slopify.android.core.session.SocketBackoff
import com.lukasbaxter.slopify.android.core.session.SocketClaim
import com.lukasbaxter.slopify.android.core.session.SocketClock
import com.lukasbaxter.slopify.android.core.session.SocketCloseAction
import com.lukasbaxter.slopify.android.core.session.SocketIdentity
import com.lukasbaxter.slopify.android.core.session.SocketQueueTrim
import com.lukasbaxter.slopify.android.core.storage.MemoryStore
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SocketBackoffTest {
    @Test fun doublesToTwentySeconds() {
        val b = SocketBackoff()
        assertEquals(listOf(1.0, 2.0, 4.0, 8.0, 16.0, 20.0, 20.0, 20.0), (0 until 8).map { b.take() })
    }

    @Test fun resetOnlyAfterLongConnection() {
        val b = SocketBackoff()
        b.take(); b.take() // next = 4
        b.connectionEnded(3.0); assertEquals(4.0, b.next, 0.0)
        b.connectionEnded(null); assertEquals(4.0, b.next, 0.0)
        b.connectionEnded(5.0); assertEquals(4.0, b.next, 0.0)
        b.connectionEnded(5.1); assertEquals(1.0, b.next, 0.0)
    }

    @Test fun closeActions() {
        assertEquals(SocketCloseAction.Replaced, SocketCloseAction.of(4000))
        assertEquals(SocketCloseAction.Reconnect, SocketCloseAction.of(4001))
        assertEquals(SocketCloseAction.SignedOut, SocketCloseAction.of(4003))
        assertEquals(SocketCloseAction.ShrinkAndReconnect, SocketCloseAction.of(1009))
        assertEquals(SocketCloseAction.Reconnect, SocketCloseAction.of(1006))
        assertEquals(SocketCloseAction.Reconnect, SocketCloseAction.of(null))
    }
}

class SocketClockTest {
    private fun np(playing: Boolean = true, held: Boolean? = null, position: Double = 10.0, serverAt: Double? = null) =
        NowPlaying(itemId = "t", title = "T", artist = "A", playing = playing, held = held, position = position, serverAt = serverAt)

    @Test fun pongPicksShortRoundTrips() {
        val c = SocketClock()
        c.pong(5000.0, 1000.0, 1100.0) // rtt 100
        assertEquals(3950.0, c.offset); assertEquals(100.0, c.bestRtt, 0.0)
        c.pong(9000.0, 2000.0, 2200.0) // rtt 200 > 100 + 15: ignored
        assertEquals(3950.0, c.offset)
        c.pong(6000.0, 2000.0, 2110.0) // rtt 110 within slack: taken
        assertEquals(6000.0 - 2055, c.offset); assertEquals(100.0, c.bestRtt, 0.0)
        c.pong(6000.0, 3000.0, 2990.0) // negative rtt: ignored
        assertEquals(6000.0 - 2055, c.offset)
    }

    @Test fun helloOkOnlyWhenUnknown() {
        val c = SocketClock()
        c.helloOk(10_000.0, 2000.0, 1800.0) // rtt 200
        assertEquals(10_000.0 - (2000 - 100), c.offset); assertEquals(200.0, c.bestRtt, 0.0)
        c.helloOk(99_999.0, 3000.0, 2900.0)
        assertEquals(8100.0, c.offset)
        assertEquals(8200.0, c.serverNow(100.0), 0.0)
    }

    @Test fun playheadFrozenWhenPausedOrHeld() {
        val c = SocketClock(); c.pong(1000.0, 0.0, 0.0)
        assertEquals(10.0, c.playhead(np(playing = false, serverAt = 0.0), 0.0, 50_000.0), 0.0)
        assertEquals(10.0, c.playhead(np(held = true, serverAt = 0.0), 0.0, 50_000.0), 0.0)
    }

    @Test fun playheadUsesServerClock() {
        val c = SocketClock()
        c.pong(100_000.0, 1000.0, 1000.0) // offset 99_000
        // serverNow = 3000 + 99_000 = 102_000, reported at 100_500 -> 1.5 s later
        assertEquals(11.5, c.playhead(np(serverAt = 100_500.0), 0.0, 3000.0), 1e-9)
        // A report stamped "in the future" never moves the playhead back.
        assertEquals(10.0, c.playhead(np(serverAt = 200_000.0), null, 3000.0), 0.0)
    }

    @Test fun playheadFallsBackToReceiptTime() {
        val c = SocketClock() // no offset yet
        assertEquals(12.5, c.playhead(np(serverAt = 1.0), 1000.0, 3500.0), 1e-9)
        assertEquals(10.0, c.playhead(np(), null, 3500.0), 0.0)
    }
}

class SocketClaimAndIdentityTest {
    @Test fun claim() {
        val c = SocketClaim()
        assertNull(c.reassertAgo(5.0))
        c.claim(1000.0)
        assertEquals(500.0, c.reassertAgo(1500.0))
        assertEquals(0.0, c.reassertAgo(500.0))
        assertEquals(SocketClaim.MAX_AGO, c.reassertAgo(1e15))
        c.yielded()
        assertNull(c.reassertAgo(1500.0))
    }

    @Test fun identity() {
        val d = MemoryStore()
        val id = SocketIdentity.clientId(d)
        assertTrue(id.startsWith("c_")); assertTrue(SocketIdentity.isValid(id))
        assertEquals(id, SocketIdentity.clientId(d))
        d.putString(SocketIdentity.STORE_KEY, "server:abc")
        assertNotEquals("server:abc", SocketIdentity.clientId(d))
        assertFalse(SocketIdentity.isValid("abc")); assertFalse(SocketIdentity.isValid("c_é1234"))
        assertTrue(SocketIdentity.isValid("c_A-b_9"))
        assertTrue(SocketIdentity.instance.startsWith("i_"))
        assertEquals("wss://music.example.com/api/ws", SocketIdentity.webSocketUrl("https://music.example.com"))
        assertEquals("ws://192.168.1.85:8080/api/ws", SocketIdentity.webSocketUrl("http://192.168.1.85:8080"))
        assertEquals("wss://m.example.com/sub/api/ws", SocketIdentity.webSocketUrl("https://m.example.com/sub/"))
    }
}

class SocketQueueTrimTest {
    private fun items(n: Int, nameLength: Int = 100): List<QueueItem> {
        val name = "x".repeat(nameLength)
        val json = "[" + (0 until n).joinToString(",") { """{"Id":"${"%032x".format(it)}","Name":"$name"}""" } + "]"
        return SlopifyJson.decodeFromString(ListSerializer(QueueItem.serializer()), json)
    }

    @Test fun smallQueueUntouched() {
        val q = items(10)
        val r = SocketQueueTrim.frame(q)
        assertEquals(q, r.queue)
        val obj = SlopifyJson.parseToJsonElement(r.frame).jsonObject
        assertEquals("queue", obj["type"]!!.jsonPrimitive.content)
        assertEquals(10, obj["queue"]!!.jsonArray.size)
    }

    @Test fun cutsToEightyPercentUntilItFits() {
        val q = items(100)
        val budget = SocketQueueTrim.byteSize(SocketQueueTrim.encode(q.take(50)))
        val r = SocketQueueTrim.frame(q, budget)
        // 100 -> 80 -> 64 -> 52 -> 42: first count whose frame fits.
        assertEquals(42, r.queue.size)
        assertEquals(q.take(42), r.queue)
        assertTrue(SocketQueueTrim.byteSize(r.frame) <= budget)
    }

    @Test fun neverBelowOneItem() = assertEquals(1, SocketQueueTrim.frame(items(5, 1000), 10).queue.size)

    /** Regression: 2 items over budget used to loop forever on the web (ceil(1.6) == 2). */
    @Test fun twoItemsOverBudgetEnds() {
        assertEquals(1, SocketQueueTrim.frame(items(2, 1000), 10).queue.size)
        // One item over the limit is sent as-is, like the web (its loop needs > 1 item).
        assertEquals(1, SocketQueueTrim.frame(items(1, 1000), 10).queue.size)
    }

    @Test fun realBudgetHoldsFiveThousand() {
        val r = SocketQueueTrim.frame(items(5000, 700))
        assertTrue(SocketQueueTrim.byteSize(r.frame) <= SocketQueueTrim.MAX_BYTES)
        assertTrue(r.queue.size < 5000)
    }
}
