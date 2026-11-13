package com.lukasbaxter.slopify.android.features.nowplaying

import com.lukasbaxter.slopify.android.core.model.Format
import com.lukasbaxter.slopify.android.core.model.Lyrics
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.session.LanDevice
import com.lukasbaxter.slopify.android.core.session.NowPlaying
import com.lukasbaxter.slopify.android.core.session.OutputDevice
import com.lukasbaxter.slopify.android.core.session.RosterPlayer
import com.lukasbaxter.slopify.android.core.session.SessionState
import com.lukasbaxter.slopify.android.core.session.SleepState
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.RepeatGlyphMode
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyphMode
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.player.DeliveredProfile
import com.lukasbaxter.slopify.android.player.PlayerState
import com.lukasbaxter.slopify.android.player.RepeatMode
import com.lukasbaxter.slopify.android.player.ShuffleMode
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal fun npTrack(id: String, artists: List<String> = listOf("A"), ids: List<String> = listOf("a1"), albumId: String = "al1", format: Format? = null) = Track(
    id = id, title = "T$id", artist = artists.joinToString(", "), artists = artists, artistIds = ids, albumId = albumId,
    album = "Alb", albumArtist = artists.firstOrNull() ?: "", durationMs = 1000, format = format,
)

class NowPlayingMathTest {
    @Test fun timeFormat() {
        assertEquals("0:00", NowPlayingMath.time(0.0))
        assertEquals("1:05", NowPlayingMath.time(65.9))
        assertEquals("62:05", NowPlayingMath.time(3725.0))
        assertEquals("0:00", NowPlayingMath.time(-3.0))
        assertEquals("0:00", NowPlayingMath.time(Double.NaN))
        assertEquals("-2:50", NowPlayingMath.remaining(30.0, 200.0))
        assertEquals("-0:00", NowPlayingMath.remaining(250.0, 200.0))
    }

    @Test fun scrubValueClampsAndScales() {
        assertEquals(100.0, NowPlayingMath.scrubValue(50f, 100f, 200.0), 1e-9)
        assertEquals(0.0, NowPlayingMath.scrubValue(-20f, 100f, 200.0), 1e-9)
        assertEquals(200.0, NowPlayingMath.scrubValue(150f, 100f, 200.0), 1e-9)
        // Range is 0..max(1, duration).
        assertEquals(1.0, NowPlayingMath.scrubValue(100f, 100f, 0.0), 1e-9)
        assertEquals(0.0, NowPlayingMath.scrubValue(10f, 0f, 200.0), 1e-9)
        assertEquals(1.5, NowPlayingMath.scrubHold(mirroring = true), 1e-9)
        assertEquals(0.25, NowPlayingMath.scrubHold(mirroring = false), 1e-9)
    }

    @Test fun fraction() {
        assertEquals(0.25, NowPlayingMath.fraction(50.0, 200.0), 1e-9)
        assertEquals(1.0, NowPlayingMath.fraction(500.0, 200.0), 1e-9)
        assertEquals(0.0, NowPlayingMath.fraction(5.0, 0.0), 1e-9)
    }

    @Test fun skipSwipe() {
        assertEquals(NowPlayingMath.Skip.Next, NowPlayingMath.skip(-61f, 10f, 0.3))
        assertEquals(NowPlayingMath.Skip.Previous, NowPlayingMath.skip(61f, -10f, 0.3))
        assertNull(NowPlayingMath.skip(60f, 0f, 0.3))
        assertNull(NowPlayingMath.skip(-100f, 40f, 0.3))
        assertNull(NowPlayingMath.skip(-100f, 0f, 0.6))
        val (offset, opacity) = NowPlayingMath.skipFollow(-120f)
        assertEquals(-80f, offset, 1e-6f)
        assertEquals(0.6, opacity, 1e-9)
        assertEquals(0f, NowPlayingMath.skipFollow(5f).first, 0f)
        assertTrue(NowPlayingMath.abandonsSwipe(3f, 8f))
        assertFalse(NowPlayingMath.abandonsSwipe(8f, 20f))
    }

    @Test fun nowPlayingDismiss() {
        assertTrue(NowPlayingMath.dismissesNowPlaying(141f, 2.0))
        assertTrue(NowPlayingMath.dismissesNowPlaying(61f, 0.2))
        assertFalse(NowPlayingMath.dismissesNowPlaying(61f, 0.4))
        assertFalse(NowPlayingMath.dismissesNowPlaying(140f, 1.0))
    }

    @Test fun reorderTargetClampsToUpcoming() {
        // current index 2, 10 rows: only 3..9 are valid slots.
        assertEquals(7, NowPlayingMath.reorderTarget(5, 130f, 64f, 2, 10))
        assertEquals(3, NowPlayingMath.reorderTarget(5, -1000f, 64f, 2, 10))
        assertEquals(9, NowPlayingMath.reorderTarget(5, 1000f, 64f, 2, 10))
        assertEquals(5, NowPlayingMath.reorderTarget(5, 31f, 64f, 2, 10))
        assertEquals(6, NowPlayingMath.reorderTarget(5, 33f, 0f, 2, 10))
        assertEquals(4, NowPlayingMath.reorderTarget(5, -33f, 64f, 2, 10))
    }

    @Test fun reorderShift() {
        // Dragging 3 down to 5: rows 4 and 5 move up.
        assertEquals(-64f, NowPlayingMath.reorderShift(4, 3, 5, 64f))
        assertEquals(-64f, NowPlayingMath.reorderShift(5, 3, 5, 64f))
        assertEquals(0f, NowPlayingMath.reorderShift(6, 3, 5, 64f))
        // Dragging 6 up to 4: rows 4 and 5 move down.
        assertEquals(64f, NowPlayingMath.reorderShift(4, 6, 4, 64f))
        assertEquals(0f, NowPlayingMath.reorderShift(3, 6, 4, 64f))
    }

    @Test fun sleepLabels() {
        val now = 1_000_000.0
        assertEquals("Sleep timer", NowPlayingMath.sleepLabel(null, false, now))
        assertEquals("Sleep timer: end of track", NowPlayingMath.sleepLabel(null, true, now))
        assertEquals("Sleep timer: 1 min left", NowPlayingMath.sleepLabel(now + 10_000, false, now))
        assertEquals("Sleep timer: 30 min left", NowPlayingMath.sleepLabel(now + 29.5 * 60_000, false, now))
        assertEquals("Sleep timer: 2 h left", NowPlayingMath.sleepLabel(now + 120 * 60_000, false, now))
        assertEquals("Sleep timer: 1 h 15 min left", NowPlayingMath.sleepLabel(now + 75 * 60_000, false, now))
    }

    @Test fun volumeValueAndThrottle() {
        assertEquals(33.0, NowPlayingMath.volumeValue(33.4f, 100f), 1e-9)
        assertEquals(0.0, NowPlayingMath.volumeValue(-5f, 100f), 1e-9)
        assertEquals(100.0, NowPlayingMath.volumeValue(500f, 100f), 1e-9)
        val t = NowPlayingThrottle(0.12)
        assertEquals(NowPlayingThrottle.Decision.Send(10.0), t.offer(10.0, 1.0))
        val w = t.offer(20.0, 1.05) as NowPlayingThrottle.Decision.Wait
        assertEquals(0.07, w.delay, 1e-9)
        t.offer(30.0, 1.08)
        assertEquals(30.0, t.flush(1.12)!!, 1e-9)
        assertNull(t.flush(1.2))
        assertEquals(NowPlayingThrottle.Decision.Send(40.0), t.offer(40.0, 1.3))
    }

    @Test fun swipeDismissRegions() {
        // Album tab: anywhere.
        assertTrue(NowPlayingMath.swipeDismissAllowed(false, 600f, 115f))
        // Lyrics tab: only from the header (chevron, title, artist), never from the lines.
        assertTrue(NowPlayingMath.swipeDismissAllowed(true, 80f, 115f))
        assertTrue(NowPlayingMath.swipeDismissAllowed(true, 115f, 115f))
        assertFalse(NowPlayingMath.swipeDismissAllowed(true, 116f, 115f))
        assertFalse(NowPlayingMath.swipeDismissAllowed(true, 500f, 115f))
    }

    @Test fun queueSwipeStartRule() {
        // Header: always, even with the list scrolled.
        assertTrue(NowPlayingMath.queueSwipeDismissAllowed(90f, 115f, 400f, onHandle = false))
        // List at its top: yes; scrolled down: no (the swipe scrolls the list).
        assertTrue(NowPlayingMath.queueSwipeDismissAllowed(400f, 115f, 0f, onHandle = false))
        assertTrue(NowPlayingMath.queueSwipeDismissAllowed(400f, 115f, 1f, onHandle = false))
        assertFalse(NowPlayingMath.queueSwipeDismissAllowed(400f, 115f, 1.5f, onHandle = false))
        assertTrue(NowPlayingMath.queueSwipeDismissAllowed(400f, 115f, -20f, onHandle = false))
        // A drag handle is a reorder: never closes, wherever the list is.
        assertFalse(NowPlayingMath.queueSwipeDismissAllowed(400f, 115f, 0f, onHandle = true))
    }

    @Test fun lyricsBackdropValues() {
        // Brighter than the web's brightness(.32) saturate(1.3), on purpose.
        assertEquals(0.42, NowPlayingMath.LYRICS_BACKDROP_BRIGHTNESS, 0.0)
        assertEquals(1.4, NowPlayingMath.LYRICS_BACKDROP_SATURATION, 0.0)
    }

    @Test fun lightCoverGetsScrimSoWhiteTextStaysReadable() {
        val white = RGB.hex(0xffffff)
        for (cover in listOf(white, RGB.hex(0xf2e6c8))) {
            val a = NowPlayingMath.lyricsScrimOpacity(cover)
            assertTrue(a > 0)
            val k = NowPlayingMath.LYRICS_BACKDROP_BRIGHTNESS * (1 - a)
            val bg = RGB(cover.r * k, cover.g * k, cover.b * k)
            assertTrue(white.contrast(bg) >= 7)
            // The 50 % upcoming lines still read against it.
            val half = RGB(255 * 0.5 + bg.r * 0.5, 255 * 0.5 + bg.g * 0.5, 255 * 0.5 + bg.b * 0.5)
            assertTrue(half.contrast(bg) >= 2.4)
        }
        // Without the scrim a white cover at 0.55 would be too bright for white text.
        assertTrue(white.contrast(RGB(255 * 0.55, 255 * 0.55, 255 * 0.55)) < 4.5)
    }

    @Test fun darkCoverNoScrim() {
        assertEquals(0.0, NowPlayingMath.lyricsScrimOpacity(RGB.hex(0x2a1a40)), 0.0)
        assertEquals(0.0, NowPlayingMath.lyricsScrimOpacity(RGB.hex(0x000000)), 0.0)
    }

    @Test fun averageColor() {
        assertNull(NowPlayingMath.averageColor(IntArray(0)))
        val px = intArrayOf(255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0)
        val avg = NowPlayingMath.averageColor(px)!!
        assertEquals(127.5, avg.r, 1e-9)
        assertEquals(127.5, avg.b, 1e-9)
        assertEquals(0.0, avg.g, 1e-9)
    }
}

class NowPlayingLyricsTest {
    private fun line(t: String, s: Double?) = NowPlayingLyricLine(t, s)

    @Test fun serverMillisecondsBecomeSeconds() {
        val out = NowPlayingLyrics.lines(Lyrics("synced", null, listOf(Lyrics.Line(12340, "a"), Lyrics.Line(null, "b"))))
        assertEquals(12.34, out[0].start!!, 1e-9)
        assertNull(out[1].start)
    }

    @Test fun plainLinesDropBlanksOnly() {
        val out = NowPlayingLyrics.phoneLines(listOf(line("a", null), line("  ", null), line("", null), line("b", null)))
        assertEquals(listOf("a", "b"), out.map { it.text })
        assertFalse(NowPlayingLyrics.isSynced(out))
    }

    @Test fun gapMarkersUseMedianThreshold() {
        // Spacing 3 s -> median 3 -> threshold max(5, 7.5) = 7.5.
        val out = NowPlayingLyrics.phoneLines(listOf(line("a", 2.0), line("b", 5.0), line("c", 8.0), line("", 9.0), line("d", 11.0), line("e", 30.0)))
        assertEquals(listOf("a", "b", "c", "d", "♪", "e"), out.map { it.text })
        assertTrue(out[4].gap)
        assertEquals(16.0, out[4].start!!, 1e-9) // 11 + min(5, 19/2)
    }

    @Test fun leadingGapMarker() {
        val out = NowPlayingLyrics.phoneLines(listOf(line("a", 20.0), line("b", 22.0), line("c", 24.0)))
        assertEquals("♪", out.first().text)
        assertEquals(0.0, out.first().start!!, 0.0)
        assertEquals(4, out.size)
    }

    @Test fun shortGapNoMarker() {
        assertEquals(3, NowPlayingLyrics.phoneLines(listOf(line("a", 1.0), line("b", 3.0), line("c", 5.5))).size)
    }

    @Test fun activeLineTiming() {
        val lines = listOf(line("a", 10.0), line("b", 12.0), line("c", 15.0))
        assertEquals(-1, NowPlayingLyrics.activeIndex(lines, 9.9))
        assertEquals(0, NowPlayingLyrics.activeIndex(lines, 10.0))
        assertEquals(1, NowPlayingLyrics.activeIndex(lines, 14.99))
        assertEquals(2, NowPlayingLyrics.activeIndex(lines, 100.0))
        // The 0.25 s lead shows a line slightly early; a speaker delay pushes it later.
        assertEquals(1, NowPlayingLyrics.activeIndex(lines, NowPlayingLyrics.lookupTime(11.8, 0.0)))
        assertEquals(0, NowPlayingLyrics.activeIndex(lines, NowPlayingLyrics.lookupTime(11.8, 0.5)))
    }

    @Test fun topFadePredicate() {
        assertFalse(NowPlayingLyrics.showsTopFade(0f, -1))
        assertFalse(NowPlayingLyrics.showsTopFade(1f, 0))
        assertFalse(NowPlayingLyrics.showsTopFade(-30f, 0)) // overscroll bounce
        assertTrue(NowPlayingLyrics.showsTopFade(1.5f, 0))
        assertTrue(NowPlayingLyrics.showsTopFade(0f, 1))
    }

    @Test fun newSongResetsScrollOnce() {
        val r = NowPlayingLyricsReset()
        assertTrue(r.loaded("a"))
        // Same song again (sync finished, reload): never moves the list.
        assertFalse(r.loaded("a"))
        // Next song, even joined mid-way: its top, once (owner 11-13).
        assertTrue(r.loaded("b"))
        assertFalse(r.loaded("b"))
        // Back to the first song: it is new again.
        assertTrue(r.loaded("a"))
    }

    @Test fun retryDelays() {
        assertEquals(2.0, NowPlayingLyrics.retryDelay(0)!!, 0.0)
        assertEquals(4.0, NowPlayingLyrics.retryDelay(1)!!, 0.0)
        assertEquals(8.0, NowPlayingLyrics.retryDelay(2)!!, 0.0)
        assertNull(NowPlayingLyrics.retryDelay(3))
    }
}

class NowPlayingDevicesTest {
    private fun player(id: String, name: String, form: String? = null, canPlay: Boolean = true, np: NowPlaying? = null) =
        RosterPlayer(id = id, name = name, kind = "phone", form = form, canPlay = canPlay, nowPlaying = np, sameNetwork = true)

    private fun np(device: OutputDevice?) = NowPlaying(itemId = "t1", title = "T", artist = "A", device = device, playing = true, position = 0.0)

    private fun lan(id: String, kind: String, name: String, model: String? = null, group: List<String>? = null) =
        LanDevice(id = id, kind = kind, name = name, model = model, group = group, viaClient = "server:u1")

    @Test fun listOrderAndModels() {
        val players = listOf(player("c1", "MacBook", "laptop"), player("c2", "Off", canPlay = false), player("server:u1", "Server", canPlay = false))
        val devs = NowPlayingDevices.devices(players, listOf(lan("b1", "bluos", "Kitchen"), lan("b1", "bluos", "Dup"), lan("r1", "roku", "Den", model = "Roku Ultra")))
        assertEquals(listOf("relay:c1", "b1", "r1"), devs.map { it.id })
        assertEquals("Laptop", devs[0].model)
        assertEquals("Bluesound", devs[1].model)
        assertEquals("tv", devs[2].form)
        assertEquals(Icon.DeviceLaptop, NowPlayingDevices.icon(devs[0]))
        assertEquals(Icon.DeviceSpeaker, NowPlayingDevices.icon(devs[1]))
        assertEquals(Icon.DeviceTV, NowPlayingDevices.icon(devs[2]))
        assertEquals(Icon.DevicePhone, NowPlayingDevices.icon(NowPlayingDevice.local))
    }

    @Test fun tvRegex() {
        assertTrue(NowPlayingDevices.looksLikeTV("upnp", "Sony BRAVIA"))
        assertTrue(NowPlayingDevices.looksLikeTV("cast", "Living Room TV"))
        assertFalse(NowPlayingDevices.looksLikeTV("cast", "Nest Audio"))
        assertFalse(NowPlayingDevices.looksLikeTV("bridge", "TVX"))
    }

    @Test fun sessionDeviceHereIsLocal() {
        assertEquals("local", NowPlayingDevices.sessionDevice("me", "me", emptyList(), emptyList()).id)
        assertNull(NowPlayingDevices.elsewhereLabel(null, "me", emptyList()))
    }

    @Test fun sessionDeviceOtherClient() {
        val players = listOf(player("c1", "MacBook", "laptop", np = np(OutputDevice.local("This Computer"))))
        val devs = NowPlayingDevices.devices(players, emptyList())
        val d = NowPlayingDevices.sessionDevice("c1", "me", players, devs)
        assertEquals("relay:c1", d.id)
        assertEquals("MacBook", NowPlayingDevices.elsewhereLabel("c1", "me", players))
        // This Phone is offered first among the others, the active client is not.
        assertEquals(listOf("local"), NowPlayingDevices.others(devs, d).map { it.id })
    }

    @Test fun sessionDeviceSpeakerGroup() {
        val sp = OutputDevice(id = "k", kind = "bridge", name = "Kitchen", members = listOf("d"))
        val players = listOf(player("server:u1", "Server", canPlay = false, np = np(sp)))
        val devs = NowPlayingDevices.devices(players, listOf(lan("k", "bridge", "Kitchen", group = listOf("k", "d")), lan("d", "bridge", "Den"), lan("o", "cast", "Office")))
        val all = listOf(NowPlayingDevice.local) + devs
        val d = NowPlayingDevices.sessionDevice("server:u1", "me", players, devs)
        assertEquals(listOf("k", "d"), d.playingOn)
        assertEquals("Kitchen + Den", NowPlayingDevices.label(d, all))
        assertEquals("Grouped with Den", NowPlayingDevices.subtitle(d, all))
        assertEquals("Kitchen", NowPlayingDevices.elsewhereLabel("server:u1", "me", players))
        assertEquals(listOf("local", "o"), NowPlayingDevices.others(devs, d).map { it.id })
    }

    @Test fun missingRelayRowIsSynthesised() {
        val d = NowPlayingDevices.sessionDevice("c9", "me", listOf(player("c9", "Tablet", "tablet", canPlay = false)), emptyList())
        assertEquals("relay:c9", d.id)
        assertEquals("Tablet", d.name)
        assertEquals(Icon.DeviceTablet, NowPlayingDevices.icon(d))
    }

    @Test fun sublineFallsBackToKind() {
        assertEquals("Google Cast", NowPlayingDevices.subline(NowPlayingDevice("x", "cast", "C", ""), emptyList()))
        assertEquals("Phone playback", NowPlayingDevices.subline(NowPlayingDevice.local, emptyList()))
        assertEquals("This Phone", NowPlayingDevices.nameFor(NowPlayingDevice.local))
    }
}

class NowPlayingSessionTest {
    private val flac = Format(codec = "FLAC", lossless = true, bitDepth = 24.0, sampleRate = 96000.0)

    @Test fun localDeliveryFollowsTheStreamProfile() {
        val t = npTrack("1", format = flac)
        val p = PlayerState(queue = listOf(t), deliveredProfile = DeliveredProfile.Hls("aac-160"))
        val s = NowPlayingSession(p, SessionState(clientId = "me", activeClientId = "me"))
        assertFalse(s.casting)
        assertEquals("AAC", s.deliveredFormat(t)?.codec)
        assertEquals(160_000.0, s.deliveredFormat(t)?.bitrate)
        // A downloaded song that is not loaded yet plays the original file.
        val other = npTrack("2", format = flac)
        assertEquals(flac, NowPlayingSession(p, SessionState(clientId = "me")) { it == "2" }.deliveredFormat(other))
    }

    @Test fun castingGetsTheOriginalAndSpeakerDelay() {
        val t = npTrack("1", format = flac)
        val sp = OutputDevice(id = "k", kind = "bridge", name = "Kitchen")
        val players = listOf(RosterPlayer(id = "server:u1", name = "S", canPlay = false, nowPlaying = NowPlaying(itemId = "1", title = "T", artist = "A", device = sp, playing = true, position = 0.0)))
        val s = NowPlayingSession(PlayerState(queue = listOf(t), remoteClientId = "server:u1"), SessionState(clientId = "me", players = players, activeClientId = "server:u1", offsets = mapOf("k" to 0.4)))
        assertTrue(s.casting)
        assertTrue(s.mirroring)
        assertEquals(flac, s.deliveredFormat(t))
        assertEquals(0.4, s.speakerDelay, 0.0)
        assertEquals("Kitchen", s.elsewhere)
    }
}

class NowPlayingFromTest {
    @Test fun immediateContexts() {
        assertEquals(NowPlayingFrom("PLAYING FROM", "Your Library"), NowPlayingFrom.immediate(null))
        assertEquals("Liked Songs", NowPlayingFrom.immediate("liked")?.name)
        assertEquals("Release Radar", NowPlayingFrom.immediate("radar")?.name)
        assertEquals(NowPlayingFrom("PLAYING FROM GENRE", "Jazz"), NowPlayingFrom.immediate("genre:Jazz"))
        assertNull(NowPlayingFrom.immediate("al123"))
        assertEquals("ar1", NowPlayingFrom.itemId("artist:ar1"))
        assertEquals("ar2", NowPlayingFrom.itemId("mix:ar2"))
        assertEquals("al1", NowPlayingFrom.itemId("al1"))
    }

    @Test fun aRadioIsNamedAfterItsSeed() = runTest {
        assertEquals("ar9", NowPlayingFrom.itemId("radio:ar9"))
        com.lukasbaxter.slopify.android.core.StubServer().use { s ->
            s.answers["/api/items/ar9"] = 200 to """{"kind":"artist","item":{"id":"ar9","name":"Drake"}}"""
            assertEquals(NowPlayingFrom("PLAYING FROM PLAYLIST", "Drake Radio"), NowPlayingFrom.resolve("radio:ar9", s.client()))
        }
    }

    @Test fun withoutAnApiFallsBack() = runTest {
        assertEquals(NowPlayingFrom.fallback, NowPlayingFrom.resolve("al1", null))
    }

    @Test fun modeCycles() {
        assertEquals(ShuffleMode.On, ShuffleMode.Off.nowPlayingNext)
        assertEquals(ShuffleMode.Smart, ShuffleMode.On.nowPlayingNext)
        assertEquals(ShuffleMode.Off, ShuffleMode.Smart.nowPlayingNext)
        assertEquals(RepeatMode.One, RepeatMode.All.nowPlayingNext)
        assertEquals(RepeatMode.Off, RepeatMode.One.nowPlayingNext)
        assertEquals(RepeatGlyphMode.One, RepeatMode.One.nowPlayingGlyph)
        assertEquals(ShuffleGlyphMode.Smart, ShuffleMode.Smart.nowPlayingGlyph)
    }

    @Test fun artistLinkParts() {
        assertEquals(listOf("A" to "a1", "B" to "b1"), nowPlayingArtistParts(npTrack("1", listOf("A", "B"), listOf("a1", "b1"))))
        // No credit ids: one fallback name, tapping goes to the first id if any.
        assertEquals(listOf("A, B" to null), nowPlayingArtistParts(npTrack("1", listOf("A", "B"), emptyList())))
    }
}

class NowPlayingQueueTest {
    private val tracks = (0 until 6).map { npTrack("$it") }

    @Test fun sectionsSplitQueuedRunFromContext() {
        val p = PlayerState(queue = tracks, queuedFlags = listOf(false, false, true, true, false, false), index = 1, context = "al1")
        val s = QueueSections.of(p)
        assertEquals(1, s.nowPlaying)
        assertEquals(2..3, s.queued)
        assertEquals(4..5, s.context)
        assertFalse(s.endOfQueue)
    }

    @Test fun lastSongIsTheEnd() {
        val s = QueueSections.of(PlayerState(queue = tracks, queuedFlags = List(6) { false }, index = 5))
        assertTrue(s.queued.isEmpty())
        assertTrue(s.context.isEmpty())
        assertTrue(s.endOfQueue)
    }

    @Test fun contextIsCappedAt80() {
        val many = (0 until 200).map { npTrack("$it") }
        val s = QueueSections.of(PlayerState(queue = many, queuedFlags = List(200) { false }, index = 0))
        assertEquals(1..80, s.context)
    }

    @Test fun sleepItemOffersOffOnlyWhileSet() {
        val off = nowPlayingSleepItem(null, 0.0) {}
        assertEquals(L("Sleep timer"), off.label)
        assertEquals(Icon.Moon, off.icon)
        assertEquals(listOf("5 minutes", "10 minutes", "15 minutes", "30 minutes", "45 minutes", "1 hour", "End of track"), off.sub!!.map { it.label })
        val picks = mutableListOf<NowPlayingSleepPick>()
        val on = nowPlayingSleepItem(SleepState(at = 600_000.0, endOfTrack = false), 0.0) { picks += it }
        assertEquals("Sleep timer: 10 min left", on.label)
        assertEquals(MenuItem.Kind.Separator, on.sub!![7].kind)
        on.sub!!.last().action!!()
        on.sub!![1].action!!()
        assertEquals(listOf(NowPlayingSleepPick.Off, NowPlayingSleepPick.Minutes(10)), picks)
    }
}
