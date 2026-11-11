package com.lukasbaxter.slopify.android.session

import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.session.Command
import com.lukasbaxter.slopify.android.core.session.NowPlaying
import com.lukasbaxter.slopify.android.core.session.QueueItem
import com.lukasbaxter.slopify.android.core.session.RosterPlayer
import com.lukasbaxter.slopify.android.core.session.SessionClient
import com.lukasbaxter.slopify.android.core.session.SessionConnection
import com.lukasbaxter.slopify.android.core.session.SleepState
import com.lukasbaxter.slopify.android.core.session.SocketEvent
import com.lukasbaxter.slopify.android.core.session.SocketMessage
import com.lukasbaxter.slopify.android.core.session.SocketTransport
import com.lukasbaxter.slopify.android.core.storage.MemoryStore
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FakeSocket(val url: String) : SocketTransport {
    private val channel = Channel<SocketEvent>(Channel.UNLIMITED)
    override val events: Flow<SocketEvent> = channel.receiveAsFlow()
    var started = false
    var closed = false
    val sent = mutableListOf<JsonObject>()
    override fun start() { started = true }
    override fun send(text: String) { sent += SlopifyJson.parseToJsonElement(text).jsonObject }
    override fun close() { closed = true; channel.close() }
    /** Feed an event the way OkHttp would. */
    fun emit(e: SocketEvent) { channel.trySend(e) }
    val types: List<String> get() = sent.mapNotNull { it["type"]?.jsonPrimitive?.content }
}

@OptIn(ExperimentalCoroutinesApi::class)
class SessionClientTest {
    private val sockets = mutableListOf<FakeSocket>()
    private val sock get() = sockets.last()

    private fun TestScope.client(): SessionClient = SessionClient(
        scope = backgroundScope,
        idStore = MemoryStore(),
        deviceName = "Pixel 9 " + "x".repeat(80),
        form = "phone",
        makeSocket = { url -> FakeSocket(url).also { sockets += it } },
        now = { testScheduler.currentTime.toDouble() + 1_000_000 },
        encodeDispatcher = StandardTestDispatcher(testScheduler),
    )

    private fun SessionClient.helloOk(id: String = "c_server_given") =
        handle(SocketEvent.Message(SocketMessage.HelloOk(id, "u", mapOf("cast:a" to 0.1), 1_000.0, null)))

    private fun np(playing: Boolean = true) = NowPlaying(itemId = "t", title = "T", artist = "A", playing = playing, position = 5.0)

    @Test fun helloFirstAndDropsBeforeHelloOk() = runTest {
        val c = client()
        c.connect("https://music.example.com", "tok")
        assertEquals("wss://music.example.com/api/ws", sock.url)
        assertTrue(sock.started)
        assertEquals(SessionConnection.Connecting, c.state.value.connection)
        c.send(Command.Toggle, "c_b") // not open yet: dropped
        c.handle(SocketEvent.Open)
        assertEquals(listOf("hello"), sock.types)
        val h = sock.sent[0]
        assertEquals("tok", h["token"]!!.jsonPrimitive.content); assertEquals("phone", h["kind"]!!.jsonPrimitive.content)
        assertEquals(true, h["canPlay"]!!.jsonPrimitive.boolean); assertEquals("phone", h["form"]!!.jsonPrimitive.content)
        assertEquals(56, h["name"]!!.jsonPrimitive.content.length)
        assertEquals(c.clientId, h["clientId"]!!.jsonPrimitive.content)
        c.sendPrefs(mapOf("a" to JsonPrimitive(true))) // before hello-ok: dropped
        assertEquals(listOf("hello"), sock.types)
        c.helloOk()
        assertEquals(SessionConnection.Connected, c.state.value.connection)
        assertEquals("c_server_given", c.clientId)
        assertEquals(mapOf("cast:a" to 0.1), c.state.value.offsets)
        c.send(Command.Toggle, "c_b")
        assertEquals(listOf("hello", "command"), sock.types)
        assertEquals("c_b", sock.sent[1]["to"]!!.jsonPrimitive.content)
    }

    @Test fun eventsFromTheTransportAreConsumedInOrder() = runTest {
        val c = client()
        c.connect("http://h.test", "t")
        runCurrent()
        sock.emit(SocketEvent.Open)
        sock.emit(SocketEvent.Message(SocketMessage.HelloOk("c_x", null, emptyMap(), null, null)))
        runCurrent()
        assertEquals(SessionConnection.Connected, c.state.value.connection)
        assertEquals("c_x", c.clientId)
    }

    @Test fun connectIsIdempotent() = runTest {
        val c = client()
        c.connect("http://h.test", "t")
        c.connect("http://h.test", "t")
        assertEquals(1, sockets.size)
        c.connect("http://h.test", "t2")
        assertEquals(2, sockets.size); assertTrue(sockets[0].closed)
    }

    @Test fun claimReassertAndYield() = runTest {
        val c = client()
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open); c.helloOk()
        c.claim()
        assertEquals("claim", sock.types.last()); assertNull(sock.sent.last()["reassert"])
        assertTrue(c.claimState.claimed)
        c.report(np()); c.publishQueue(emptyList())
        // Network drop, reconnect: claim reasserted first, then the last nowplaying.
        c.handle(SocketEvent.Closed(1006))
        assertEquals(SessionConnection.Disconnected, c.state.value.connection)
        c.connect("http://h.test", "t") // foreground-style prompt reconnect
        assertEquals(2, sockets.size)
        c.handle(SocketEvent.Open); c.helloOk()
        assertEquals(listOf("hello", "claim", "nowplaying"), sock.types.take(3))
        assertEquals(true, sock.sent[1]["reassert"]!!.jsonPrimitive.boolean)
        assertTrue(sock.sent[1]["ago"]!!.jsonPrimitive.double >= 0)
        // Someone else takes over.
        val got = mutableListOf<Pair<Command, String>>()
        c.onCommand = { cmd, from -> got += cmd to from }
        c.handle(SocketEvent.Message(SocketMessage.CommandFrom(Command.Yield, "c_other")))
        assertEquals(Command.Yield to "c_other", got.first())
        assertFalse(c.claimState.claimed)
        assertEquals("c_other", c.state.value.activeClientId)
        // Mirror now: reports are dropped, and a reconnect does not reassert.
        val before = sock.sent.size
        c.report(np())
        assertEquals(before, sock.sent.size)
        c.handle(SocketEvent.Closed(null))
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open); c.helloOk()
        assertEquals(listOf("hello"), sock.types)
    }

    @Test fun reportGating() = runTest {
        val c = client()
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open); c.helloOk()
        c.report(np()) // nobody active: allowed
        assertEquals("nowplaying", sock.types.last())
        c.handle(SocketEvent.Message(SocketMessage.Roster(emptyList(), emptyList(), "c_other")))
        val n = sock.sent.size
        c.report(np()); c.report(null)
        assertEquals(n, sock.sent.size)
        c.handle(SocketEvent.Message(SocketMessage.Roster(emptyList(), emptyList(), c.clientId)))
        assertTrue(c.state.value.isActiveHere)
        c.report(null)
        assertEquals("nowplaying", sock.types.last()); assertEquals(JsonNull, sock.sent.last()["nowPlaying"])
    }

    @Test fun closeCodes() = runTest {
        val c = client()
        var signedOut = 0
        c.onSignedOut = { signedOut++ }
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open); c.helloOk()
        c.handle(SocketEvent.Closed(4000)) // replaced: no retry scheduled
        assertEquals(SessionConnection.Disconnected, c.state.value.connection)
        assertEquals(1.0, c.backoff.next, 0.0)
        advanceTimeBy(60_000); runCurrent()
        assertEquals(1, sockets.size)
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open)
        c.handle(SocketEvent.Closed(4003))
        assertEquals(1, signedOut)
        advanceTimeBy(60_000); runCurrent()
        assertEquals("stopped: nothing reconnects by itself", 2, sockets.size)
    }

    @Test fun backoffGrowsOnFailuresAndRetries() = runTest {
        val c = client()
        c.connect("http://h.test", "t")
        c.handle(SocketEvent.Closed(null)) // never opened
        assertEquals(2.0, c.backoff.next, 0.0)
        advanceTimeBy(999); runCurrent()
        assertEquals(1, sockets.size)
        advanceTimeBy(2); runCurrent()
        assertEquals("retried after 1 s", 2, sockets.size)
        c.handle(SocketEvent.Closed(null))
        advanceTimeBy(1_500); runCurrent()
        assertEquals(2, sockets.size)
        advanceTimeBy(600); runCurrent()
        assertEquals("then after 2 s", 3, sockets.size)
    }

    @Test fun tooBigShrinksTheQueue() = runTest {
        val c = client()
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open); c.helloOk()
        val q = (0 until 10).map { QueueItem(id = "t$it") }
        c.publishQueue(q)
        advanceTimeBy(400); runCurrent()
        assertEquals(10, (sock.sent.last { it["type"]!!.jsonPrimitive.content == "queue" }["queue"] as kotlinx.serialization.json.JsonArray).size)
        c.handle(SocketEvent.Closed(1009))
        advanceTimeBy(1_100); runCurrent()
        c.handle(SocketEvent.Open); c.helloOk()
        val frame = sock.sent.last { it["type"]!!.jsonPrimitive.content == "queue" }
        assertEquals(5, (frame["queue"] as kotlinx.serialization.json.JsonArray).size)
    }

    @Test fun moveReconnectsSameIdentity() = runTest {
        val c = client()
        c.connect("https://main.test", "t"); c.handle(SocketEvent.Open); c.helloOk("c_kept")
        c.move("http://192.168.1.2:8080")
        assertTrue(sockets[0].closed)
        assertEquals("ws://192.168.1.2:8080/api/ws", sock.url)
        c.handle(SocketEvent.Open)
        assertEquals("c_kept", sock.sent[0]["clientId"]!!.jsonPrimitive.content)
        assertEquals(sockets[0].sent[0]["instance"], sock.sent[0]["instance"])
        c.move("http://192.168.1.2:8080")
        assertEquals(2, sockets.size)
    }

    @Test fun stateFromServer() = runTest {
        val c = client()
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open); c.helloOk()
        val likes = mutableListOf<String>(); val prefs = mutableListOf<Prefs>()
        c.onLike = { id, _ -> likes += id }
        c.onPrefs = { prefs += it }
        val remote = np().copy(serverAt = 1.0)
        c.handle(SocketEvent.Message(SocketMessage.Roster(listOf(RosterPlayer(id = "c_b", name = "B", nowPlaying = remote)), emptyList(), "c_b")))
        assertEquals("c_b", c.state.value.remoteActive?.id)
        assertTrue(c.playhead(remote) >= 5)
        c.handle(SocketEvent.Message(SocketMessage.Queue("c_b", emptyList())))
        assertNotNull(c.state.value.queues["c_b"])
        c.handle(SocketEvent.Message(SocketMessage.Queue("c_b", null)))
        assertNull(c.state.value.queues["c_b"])
        c.handle(SocketEvent.Message(SocketMessage.Session(np(false), emptyList(), 7.0)))
        assertEquals(7.0, c.state.value.lastSession!!.at, 0.0)
        c.handle(SocketEvent.Message(SocketMessage.Sleep(SleepState(9.0, false))))
        assertEquals(9.0, c.state.value.sleep?.at)
        c.handle(SocketEvent.Message(SocketMessage.Sleep(null)))
        assertNull(c.state.value.sleep)
        c.handle(SocketEvent.Message(SocketMessage.Offset("cast:a", null)))
        assertEquals(emptyMap<String, Double>(), c.state.value.offsets)
        c.handle(SocketEvent.Message(SocketMessage.Like("x", true)))
        c.handle(SocketEvent.Message(SocketMessage.PrefsPatch(mapOf("k" to JsonNull))))
        assertEquals(listOf("x"), likes); assertEquals(1, prefs.size)
        c.disconnect()
        assertTrue(c.state.value.players.isEmpty()); assertEquals(SessionConnection.Disconnected, c.state.value.connection)
    }

    @Test fun sleepMessages() = runTest {
        val c = client()
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open); c.helloOk()
        c.setSleep(30); c.setSleep(null); c.setSleepEndOfTrack(); c.sleepDone()
        val s = sock.sent.takeLast(4)
        assertEquals(listOf("sleep", "sleep", "sleep", "sleep"), s.map { it["type"]!!.jsonPrimitive.content })
        assertEquals(30, s[0]["minutes"]!!.jsonPrimitive.int)
        assertEquals(true, s[1]["off"]!!.jsonPrimitive.boolean)
        assertEquals(true, s[2]["endOfTrack"]!!.jsonPrimitive.boolean)
        assertEquals(true, s[3]["done"]!!.jsonPrimitive.boolean)
    }

    @Test fun queueDebounced() = runTest {
        val c = client()
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open); c.helloOk()
        val q = listOf(QueueItem(id = "a"), QueueItem(id = "b"))
        c.publishQueue(q); c.publishQueue(q)
        assertFalse(sock.types.contains("queue"))
        advanceTimeBy(800); runCurrent()
        assertEquals(1, sock.types.count { it == "queue" })
    }

    @Test fun repeatsPlayingReport() = runTest {
        val c = client()
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open); c.helloOk()
        c.report(np())
        advanceTimeBy(2_300); runCurrent()
        val reports = sock.sent.filter { it["type"]!!.jsonPrimitive.content == "nowplaying" }
        assertEquals(2, reports.size)
        assertEquals("advanced 2 s from 5", 7.0, reports[1]["nowPlaying"]!!.jsonObject["position"]!!.jsonPrimitive.double, 0.01)
        c.report(np(false))
        advanceTimeBy(2_300); runCurrent()
        assertEquals(3, sock.sent.count { it["type"]!!.jsonPrimitive.content == "nowplaying" })
    }

    @Test fun pingsAndClock() = runTest {
        val c = client()
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open)
        c.handle(SocketEvent.Message(SocketMessage.HelloOk("c_x", null, emptyMap(), null, null)))
        advanceTimeBy(500); runCurrent()
        assertEquals("ping", sock.types.last())
        advanceTimeBy(25_000); runCurrent()
        assertEquals(2, sock.types.count { it == "ping" })
        val t = sock.sent.last()["t"]!!.jsonPrimitive.double
        c.handle(SocketEvent.Message(SocketMessage.Pong(t + 5_000, t)))
        // rtt 100 ms: offset = 5000 - 50.
        assertEquals(4_950.0, c.serverNow() - (testScheduler.currentTime + 1_000_000), 1.0)
    }

    @Test fun backgroundClosesUnlessPlayingAndForegroundReopens() = runTest {
        val c = client()
        c.connect("http://h.test", "t"); c.handle(SocketEvent.Open); c.helloOk()
        c.onBackground()
        assertTrue(sockets[0].closed)
        assertEquals(SessionConnection.Disconnected, c.state.value.connection)
        c.onForeground()
        assertEquals(2, sockets.size)
        c.handle(SocketEvent.Open); c.helloOk()
        c.report(np())
        c.onBackground()
        assertFalse("playing: kept", sockets[1].closed)
        // Foreground with a live socket: a ping, and no pong within 4 s reopens.
        c.onForeground()
        advanceTimeBy(4_100); runCurrent()
        assertEquals(3, sockets.size)
    }
}
