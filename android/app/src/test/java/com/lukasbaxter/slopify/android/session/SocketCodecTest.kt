package com.lukasbaxter.slopify.android.session

import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.session.Command
import com.lukasbaxter.slopify.android.core.session.LanDevice
import com.lukasbaxter.slopify.android.core.session.SleepState
import com.lukasbaxter.slopify.android.core.session.SocketMessage
import com.lukasbaxter.slopify.android.core.session.SocketOutgoing
import com.lukasbaxter.slopify.android.core.session.encode
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandCodecTest {
    private fun roundTrip(c: Command): JsonObject {
        val wire = SlopifyJson.parseToJsonElement(c.encode().toString()).jsonObject
        assertEquals(c, Command.decode(wire))
        return wire
    }

    @Test fun everyActionRoundTrips() {
        val transfer = Command.TransferPayload(listOf("a", "b"), listOf(false, true), 1, 12.5, true, "pl_1", listOf("b", "a"), "local")
        val all = listOf(
            Command.Play(listOf("a"), 0, "alb", 3.5) to "play",
            Command.Play(listOf("a", "b"), 1, null, null) to "play",
            Command.Transfer(transfer) to "transfer",
            Command.Enqueue(listOf("x")) to "enqueue",
            Command.QueueRemove(4) to "queueRemove",
            Command.QueueMove(1, 3) to "queueMove",
            Command.QueueClear to "queueClear",
            Command.SkipTo(2) to "skipTo",
            Command.Toggle to "toggle",
            Command.SetPlaying(false) to "setPlaying",
            Command.Seek(81.42) to "seek",
            Command.SetVolume(80.0) to "setVolume",
            Command.VolumeStep(-1) to "volumeStep",
            Command.Next to "next",
            Command.Previous to "previous",
            Command.SetRepeat("one") to "setRepeat",
            Command.SetShuffle("smart") to "setShuffle",
            Command.PatchLiked("t1", true) to "patchLiked",
            Command.Yield to "yield",
            Command.Unknown("dance") to "dance",
        )
        for ((c, action) in all) assertEquals(action, roundTrip(c)["action"]?.jsonPrimitive?.content)
    }

    @Test fun flatWireKeys() {
        val t = roundTrip(Command.Transfer(Command.TransferPayload(listOf("a"), null, 0, 1.0, false, null, null, "bluos:1")))
        assertEquals("bluos:1", t["deviceId"]?.jsonPrimitive?.content)
        assertEquals(1.0, t["position"]!!.jsonPrimitive.double, 0.0)
        assertTrue("queued" !in t && "ctx" !in t)
        assertEquals(2.0, roundTrip(Command.Seek(2.0))["pos"]!!.jsonPrimitive.double, 0.0)
        assertEquals(3.0, roundTrip(Command.SetVolume(3.0))["level"]!!.jsonPrimitive.double, 0.0)
        assertEquals(1, roundTrip(Command.VolumeStep(1))["step"]!!.jsonPrimitive.int)
        assertEquals("all", roundTrip(Command.SetRepeat("all"))["mode"]!!.jsonPrimitive.content)
        assertEquals(true, roundTrip(Command.SetPlaying(true))["playing"]!!.jsonPrimitive.boolean)
        val mv = roundTrip(Command.QueueMove(5, 6))
        assertEquals(5, mv["from"]!!.jsonPrimitive.int); assertEquals(6, mv["to"]!!.jsonPrimitive.int)
    }

    @Test fun decodesWebShapes() {
        val json = """{"action":"transfer","trackIds":["a","b"],"queued":[false,false],"index":1,"position":81.4,"playing":true,"ctx":"artist:a9","original":["a","b"],"deviceId":"local"}"""
        val c = Command.decode(SlopifyJson.parseToJsonElement(json)) as Command.Transfer
        assertEquals(1, c.transfer.index); assertEquals(81.4, c.transfer.position, 0.0); assertEquals("artist:a9", c.transfer.ctx)
        assertEquals(Command.Play(listOf("a")), Command.decode(SlopifyJson.parseToJsonElement("""{"action":"play","trackIds":["a"]}""")))
        assertEquals(Command.Play(listOf("a")), Command.decode(SlopifyJson.parseToJsonElement("""{"action":"play","trackIds":["a"],"index":0,"ctx":null}""")))
    }
}

/** Frames copied from API.md §20.4 / §20.5 (placeholders filled in). */
class SocketMessageTest {
    companion object {
        const val NOW_PLAYING = """{ "itemId": "0f6c", "title": "Paranoid Android", "artist": "Radiohead", "album": "OK Computer",
          "artUrl": "https://music.example.com/api/image/0f6c?size=128&token=x", "albumId": "1a2b", "artistId": "a9b8",
          "artists": [{ "Id": "a9b8", "Name": "Radiohead" }], "liked": true,
          "device": { "id": "local", "kind": "local", "name": "Pixel 9" }, "queueIndex": 3,
          "playing": true, "held": false, "position": 81.42, "duration": 383.0, "volume": 80, "repeat": "off", "shuffle": "off",
          "at": 1762800000000, "serverAt": 1762800000031 }"""
        const val QUEUE_ITEM = """{ "Id": "0f6c", "Name": "Paranoid Android", "Artists": ["Radiohead"], "AlbumArtist": "Radiohead", "Album": "OK Computer",
          "AlbumId": "1a2b", "RunTimeTicks": 3830000000,
          "ArtistItems": [{ "Id": "a9b8", "Name": "Radiohead" }], "AlbumArtists": [{ "Id": "a9b8", "Name": "Radiohead" }],
          "UserData": { "IsFavorite": true }, "_queued": false, "_gain": { "track": -6.3, "album": -5.8 } }"""
    }

    @Test fun helloOk() {
        val m = SocketMessage.parse("""{ "type": "hello-ok", "clientId": "c_k3j2h1", "userId": "3f2a", "offsets": { "cast:abc": 0.12, "x": null }, "now": 1762800000000, "sleep": { "at": 1762803600000, "endOfTrack": false }, "web": "assets/index-abc123.js" }""")
        assertEquals(SocketMessage.HelloOk("c_k3j2h1", "3f2a", mapOf("cast:abc" to 0.12), 1762800000000.0, SleepState(1762803600000.0, false)), m)
        val h = SocketMessage.parse("""{"type":"hello-ok","clientId":"c_x","sleep":null}""") as SocketMessage.HelloOk
        assertNull(h.sleep); assertEquals(emptyMap<String, Double>(), h.offsets)
    }

    @Test fun pong() = assertEquals(SocketMessage.Pong(5.0, 3.0), SocketMessage.parse("""{ "type": "pong", "now": 5, "t": 3 }"""))

    @Test fun roster() {
        val json = """{ "type": "roster",
          "players": [
            { "id": "c_desktop1", "name": "Lukas MacBook", "kind": "desktop", "form": "laptop", "canPlay": true, "nowPlaying": $NOW_PLAYING, "sameNetwork": true },
            { "id": "server:3f2a", "name": "Home speakers", "kind": "server", "form": null, "canPlay": false, "nowPlaying": null, "sameNetwork": true },
            { "broken": true }
          ],
          "lanDevices": [
            { "id": "bluos:192.168.1.20", "kind": "bluos", "name": "Node", "model": "NODE 2i", "host": "192.168.1.20", "port": 11000,
              "group": ["bluos:192.168.1.20", "bluos:192.168.1.21"],
              "state": { "volume": 30, "muted": false, "state": "pause", "playing": false, "title": null, "artist": null, "album": null, "image": null, "input": null, "inputs": [{ "id": "x", "name": "TV" }] },
              "viaClient": "server:3f2a" },
            { "id": "tv:192.168.1.50", "kind": "tv", "name": "Living Room TV", "model": "Slopify TV", "host": "192.168.1.50", "port": 7781, "viaClient": "server:3f2a" }
          ],
          "activeClientId": "c_desktop1" }"""
        val r = SocketMessage.parse(json) as SocketMessage.Roster
        assertEquals(listOf("c_desktop1", "server:3f2a"), r.players.map { it.id })
        assertTrue(r.players[1].isServer)
        assertEquals(81.42, r.players[0].nowPlaying!!.position, 0.0)
        assertEquals(1762800000031.0, r.players[0].nowPlaying!!.serverAt)
        assertEquals("Radiohead", r.players[0].nowPlaying!!.artists!![0].name)
        assertEquals(2, r.lanDevices.size)
        assertEquals(30.0, r.lanDevices[0].state?.volume)
        assertEquals(2, r.lanDevices[0].group?.size)
        assertEquals("c_desktop1", r.activeClientId)
        val empty = SocketMessage.parse("""{"type":"roster","players":[],"lanDevices":[],"activeClientId":null}""") as SocketMessage.Roster
        assertNull(empty.activeClientId)
        assertEquals(LanDevice::class, r.lanDevices[1]::class)
    }

    @Test fun queueAndSession() {
        val q = SocketMessage.parse("""{ "type": "queue", "from": "c_a", "queue": [$QUEUE_ITEM] }""") as SocketMessage.Queue
        assertEquals("c_a", q.from); assertEquals(3830000000L, q.queue!![0].runTimeTicks); assertEquals(-6.3, q.queue!![0].gain?.track)
        assertEquals(true, q.queue!![0].userData?.isFavorite)
        assertEquals(SocketMessage.Queue("c_a", null), SocketMessage.parse("""{ "type": "queue", "from": "c_a", "queue": null }"""))
        val s = SocketMessage.parse("""{ "type": "session", "nowPlaying": $NOW_PLAYING, "queue": [$QUEUE_ITEM], "at": 1762800000000 }""") as SocketMessage.Session
        assertEquals("0f6c", s.nowPlaying.itemId); assertEquals(1, s.queue.size); assertEquals(1762800000000.0, s.at, 0.0)
    }

    @Test fun commandLikePrefsSleepOffset() {
        assertEquals(SocketMessage.CommandFrom(Command.SetPlaying(false), "server"),
            SocketMessage.parse("""{ "type": "command", "from": "server", "command": { "action": "setPlaying", "playing": false } }"""))
        assertEquals(SocketMessage.CommandFrom(Command.Yield, "c_b"), SocketMessage.parse("""{ "type": "command", "from": "c_b", "command": { "action": "yield" } }"""))
        assertEquals(SocketMessage.Like("t1", true), SocketMessage.parse("""{ "type": "like", "itemId": "t1", "liked": true, "at": 1 }"""))
        assertEquals(SocketMessage.PrefsPatch(mapOf("_libraryLayout" to JsonPrimitive("r7"), "theme" to JsonObject(mapOf("a" to JsonPrimitive(1))))),
            SocketMessage.parse("""{ "type": "prefs", "prefs": { "_libraryLayout": "r7", "theme": { "a": 1 } } }"""))
        assertEquals(SocketMessage.Sleep(SleepState(null, true)), SocketMessage.parse("""{ "type": "sleep", "sleep": { "at": null, "endOfTrack": true } }"""))
        assertEquals(SocketMessage.Sleep(null), SocketMessage.parse("""{ "type": "sleep", "sleep": null }"""))
        assertEquals(SocketMessage.Offset("cast:abc", 0.2), SocketMessage.parse("""{ "type": "offset", "id": "cast:abc", "offset": 0.2 }"""))
        assertEquals(SocketMessage.Offset("cast:abc", null), SocketMessage.parse("""{ "type": "offset", "id": "cast:abc", "offset": null }"""))
    }

    @Test fun ignoredFrames() {
        assertEquals(SocketMessage.Unknown("future-thing"), SocketMessage.parse("""{ "type": "future-thing", "x": 1 }"""))
        assertNull(SocketMessage.parse("[1,2]"))
        assertNull(SocketMessage.parse("not json"))
        assertNull(SocketMessage.parse("""{ "type": "pong" }"""))
        assertNull(SocketMessage.parse("""{ "type": "command", "command": { "action": "seek" } }"""))
    }

    private fun obj(m: SocketOutgoing) = SlopifyJson.parseToJsonElement(m.text()).jsonObject

    @Test fun outgoingShapes() {
        val h = obj(SocketOutgoing.Hello("tok", "c_1234", "i_x", "Pixel", "phone", "phone", true))
        assertEquals("hello", h["type"]!!.jsonPrimitive.content); assertEquals("tok", h["token"]!!.jsonPrimitive.content)
        assertEquals("phone", h["kind"]!!.jsonPrimitive.content); assertEquals(true, h["canPlay"]!!.jsonPrimitive.boolean)
        val nilNp = obj(SocketOutgoing.NowPlayingReport(null))
        assertEquals("nowplaying", nilNp["type"]!!.jsonPrimitive.content); assertEquals(JsonNull, nilNp["nowPlaying"])
        assertEquals(1, obj(SocketOutgoing.Claim(null)).size)
        val re = obj(SocketOutgoing.Claim(1234.4))
        assertEquals(true, re["reassert"]!!.jsonPrimitive.boolean); assertEquals(1234L, re["ago"]!!.jsonPrimitive.long)
        val cmd = obj(SocketOutgoing.CommandTo(Command.Seek(4.0), "c_b"))
        assertEquals("c_b", cmd["to"]!!.jsonPrimitive.content); assertEquals("seek", cmd["command"]!!.jsonObject["action"]!!.jsonPrimitive.content)
        assertEquals(1440, obj(SocketOutgoing.Sleep(SocketOutgoing.SleepRequest.Minutes(5000)))["minutes"]!!.jsonPrimitive.int)
        assertEquals(1, obj(SocketOutgoing.Sleep(SocketOutgoing.SleepRequest.Minutes(0)))["minutes"]!!.jsonPrimitive.int)
        assertEquals(true, obj(SocketOutgoing.Sleep(SocketOutgoing.SleepRequest.EndOfTrack))["endOfTrack"]!!.jsonPrimitive.boolean)
        val done = obj(SocketOutgoing.Sleep(SocketOutgoing.SleepRequest.Done))
        assertEquals(true, done["off"]!!.jsonPrimitive.boolean); assertEquals(true, done["done"]!!.jsonPrimitive.boolean)
        assertEquals(2, obj(SocketOutgoing.Sleep(SocketOutgoing.SleepRequest.Off)).size)
        assertEquals(true, obj(SocketOutgoing.PrefsPatch(mapOf("a" to JsonPrimitive(true))))["prefs"]!!.jsonObject["a"]!!.jsonPrimitive.boolean)
        assertEquals(JsonNull, obj(SocketOutgoing.Offset("cast:a", null))["offset"])
        // URLs stay unescaped like the iOS encoder (no "\/").
        val np = SocketOutgoing.NowPlayingReport(
            com.lukasbaxter.slopify.android.core.session.NowPlaying(itemId = "t", title = "T", artist = "A", artUrl = "https://x/y", playing = true, position = 1.0),
        ).text()
        assertTrue(np.contains("https://x/y")); assertTrue(!np.contains("\"album\""))
    }
}
