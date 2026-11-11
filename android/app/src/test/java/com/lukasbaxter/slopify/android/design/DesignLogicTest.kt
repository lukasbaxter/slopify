package com.lukasbaxter.slopify.android.design

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.dp
import com.lukasbaxter.slopify.android.core.model.Format
import com.lukasbaxter.slopify.android.core.stores.LyricJobEvent
import com.lukasbaxter.slopify.android.core.stores.LyricJobStage
import com.lukasbaxter.slopify.android.design.components.DeliveredFormat
import com.lukasbaxter.slopify.android.design.components.DetailScaffoldMath
import com.lukasbaxter.slopify.android.design.components.MarqueeMath
import com.lukasbaxter.slopify.android.design.components.NowPlayingBarsMath
import com.lukasbaxter.slopify.android.design.components.SwipeToQueue
import com.lukasbaxter.slopify.android.design.components.heroCoverSide
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.PathOp
import com.lukasbaxter.slopify.android.design.icons.SvgPath
import com.lukasbaxter.slopify.android.design.icons.filled
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.image.ImageLoader
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.overlay.ToastLayout
import com.lukasbaxter.slopify.android.design.sheets.MenuItem
import com.lukasbaxter.slopify.android.design.theme.Gestures
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

class DesignSvgPathTest {
    @Test fun basicCommands() {
        val p = SvgPath.parse("M2 2h4v4H2z")
        val b = SvgPath.bounds(p)
        assertEquals(listOf(2f, 2f, 6f, 6f), listOf(b.left, b.top, b.right, b.bottom))
        val rel = SvgPath.bounds(SvgPath.parse("m1 1 2 0 0 2-2 0z")) // implicit lineto after moveto
        assertEquals(listOf(1f, 1f, 3f, 3f), listOf(rel.left, rel.top, rel.right, rel.bottom))
    }

    @Test fun packedNumbersAndArcs() {
        // ".5.5" is two numbers; arc flags may be packed.
        assertEquals(0.5f to 0.5f, SvgPath.end(SvgPath.parse("M0 0l.5.5")))
        val circle = SvgPath.bounds(SvgPath.parse("M0 8a8 8 0 1 0 16 0a8 8 0 1 0 -16 0z"))
        assertEquals(16f, circle.width, 0.05f)
        assertEquals(16f, circle.height, 0.05f)
        assertEquals(16f, SvgPath.end(SvgPath.parse("M8 0a8 8 0 110 16")).second, 0.001f)
        assertTrue(SvgPath.parse("M0 0q1 1 2 0t2 0").count { it is PathOp.Quad } == 2)
        assertTrue(SvgPath.parse("M0 0c1 1 2 1 3 0s2-1 3 0").count { it is PathOp.Cubic } == 2)
        assertEquals(1e-3f, SvgPath.end(SvgPath.parse("M0 0L1e-3 0")).first, 1e-6f)
    }

    @Test fun everyIconParsesInsideItsViewBox() {
        assertEquals(88, Icon.entries.size)
        for (icon in Icon.entries) {
            val spec = icon.spec
            assertTrue(icon.key, spec.elements.isNotEmpty())
            for (el in spec.elements) {
                val b = SvgPath.bounds(SvgPath.ops(el.d))
                assertFalse("${icon.key} empty", b.width == 0f && b.height == 0f)
                val slack = if (el.rotate == null) 1.5f else 6f
                assertTrue(icon.key, b.left >= -slack && b.top >= -slack)
                assertTrue(icon.key, b.right <= spec.viewBox + slack && b.bottom <= spec.viewBox + slack)
            }
        }
    }

    /** The generated table is the iOS one: same names in the same order, same element count. */
    @Test fun iconTableMatchesIOS() {
        val swift = File("../../ios/Slopify/Design/Icons/IconData.swift").takeIf { it.exists() } ?: return
        val text = swift.readText()
        val names = Regex("^\\s*case `?(\\w+)`?\\s*$", RegexOption.MULTILINE).findAll(text.substring(text.indexOf("enum Icon:"))).map { it.groupValues[1] }.toList()
        assertEquals(names, Icon.entries.map { it.key })
        assertEquals(Regex("IconElement\\(").findAll(text).count(), Icon.entries.sumOf { it.spec.elements.size })
        assertTrue(text.contains(Icon.HeartFilled.spec.elements.single().d))
    }

    @Test fun filledPairs() {
        assertEquals(Icon.HeartFilled, Icon.Heart.filled)
        assertEquals(Icon.HomeTabFilled, Icon.HomeTab.filled)
        assertEquals(Icon.Plus, Icon.Plus.filled)
    }
}

class DesignQualityTest {
    @Test fun labels() {
        assertEquals("FLAC 44.1kHz", DeliveredFormat.label(Format("FLAC", true, null, 44100.0, 16.0)))
        assertEquals("FLAC 24-bit 96kHz", DeliveredFormat.label(Format("FLAC", true, null, 96000.0, 24.0)))
        assertEquals("AAC 320kbps", DeliveredFormat.label(Format("AAC", false, 320000.0)))
        assertEquals("MP3", DeliveredFormat.label(Format("MP3", false)))
        assertNull(DeliveredFormat.label(Format()))
    }

    @Test fun delivered() {
        val flac = Format("FLAC", true, 1_000_000.0, 48000.0, 16.0)
        assertEquals(flac, DeliveredFormat.delivered(flac, "bluos"))
        assertEquals(flac, DeliveredFormat.delivered(flac, "local", DeliveredFormat.Mode.File))
        assertEquals("ALAC 48kHz", DeliveredFormat.label(DeliveredFormat.delivered(flac, "local", profile = "alac")))
        assertEquals("AAC 160kbps", DeliveredFormat.label(DeliveredFormat.delivered(flac, "local", profile = "aac-160")))
        assertEquals("MP3 96kbps", DeliveredFormat.label(DeliveredFormat.delivered(flac, "local", DeliveredFormat.Mode.Mp3, "aac-96")))
    }
}

class DesignMenuTest {
    private fun labels(items: List<MenuItem>) = items.map { if (it.kind == MenuItem.Kind.Separator) "-" else it.label }

    @Test fun offlineSubsetTidiesSeparators() {
        val items = listOf(
            MenuItem("Add to queue", offline = true), MenuItem("Add to playlist"), MenuItem.separator,
            MenuItem("Go to song radio"), MenuItem.separator, MenuItem("Go to artist", offline = true), MenuItem("Go to album", offline = true),
            MenuItem.separator, MenuItem("Share"),
        )
        assertEquals(listOf("Add to queue", "-", "Go to artist", "Go to album"), labels(MenuItem.offlineSubset(items)))
        assertEquals(listOf("a", "-", "b"), labels(MenuItem.tidy(listOf(MenuItem.separator, MenuItem("a"), MenuItem.separator, MenuItem.separator, MenuItem("b"), MenuItem.separator))))
    }

    @Test fun offlineSubsetReducesSubMenus() {
        val items = listOf(MenuItem("Go to artist", offline = true, sub = listOf(MenuItem("A", offline = true), MenuItem("Online only"))))
        assertEquals(listOf("A"), MenuItem.offlineSubset(items).single().sub?.map { it.label })
    }
}

class DesignGestureMathTest {
    @Test fun sheetDismissThresholds() {
        assertTrue(Gestures.sheetShouldDismiss(101f, 2000))
        assertFalse(Gestures.sheetShouldDismiss(99f, 2000))
        assertTrue(Gestures.sheetShouldDismiss(41f, 200))
        assertFalse(Gestures.sheetShouldDismiss(41f, 310))
    }

    @Test fun topBarFade() {
        val s = DetailScaffoldMath
        assertEquals(0f, s.progress(40f, 400f))
        assertEquals(0.5f, s.progress(40f + 170, 400f)) // span = 340
        assertEquals(1f, s.progress(1000f, 400f))
        assertEquals(0.5f, s.progress(40f + 60, 100f)) // span floor 120
        assertEquals(0.5f, s.progress(40f + 80, null)) // no hero: 160
        assertEquals(0f, s.titleOpacity(0.5f))
        assertEquals(0.5f, s.titleOpacity(0.75f))
    }

    @Test fun marqueeTiming() {
        // dist 60: D = 6 s per direction; holds 25 % at each end.
        assertEquals(0f, MarqueeMath.offset(0.0, 60f).first, 0f)
        assertEquals(0f, MarqueeMath.offset(1.4, 60f).first, 0f)
        assertEquals(-42f, MarqueeMath.offset(3.0, 60f).first, 0.01f) // halfway: -(60+24)/2
        assertEquals(-84f, MarqueeMath.offset(5.0, 60f).first, 0.01f)
        assertEquals(-42f, MarqueeMath.offset(9.0, 60f).first, 0.01f) // coming back
        assertFalse(MarqueeMath.offset(0.5, 60f).second)
        assertTrue(MarqueeMath.offset(3.0, 60f).second)
    }

    @Test fun heroCoverSide() {
        assertEquals(250.dp, heroCoverSide(393.dp))
        assertEquals(220.dp, heroCoverSide(375.dp))
        assertEquals(216.dp, heroCoverSide(280.dp))
    }

    @Test fun nowPlayingBars() {
        assertEquals(0.4f, NowPlayingBarsMath.scale(0.0), 1e-6f)
        assertEquals(1f, NowPlayingBarsMath.scale(0.45), 1e-6f)
        assertEquals(0.4f, NowPlayingBarsMath.scale(-0.9), 1e-6f)
    }
}

class DesignSwipeToQueueTest {
    @Test fun thresholdAndRubberBand() {
        assertEquals(80f, SwipeToQueue.threshold(400f))
        assertEquals(50f, SwipeToQueue.threshold(200f))
        assertEquals(80f, SwipeToQueue.threshold(0f))
        assertEquals(40f, SwipeToQueue.displayOffset(40f, 80f))
        assertEquals(0f, SwipeToQueue.displayOffset(-5f, 80f))
        val far = SwipeToQueue.displayOffset(10_000f, 80f)
        assertTrue(far > 80f && far < 160f)
        assertEquals(0.5f, SwipeToQueue.progress(40f, 80f))
        assertEquals(1f, SwipeToQueue.progress(200f, 80f))
        assertTrue(SwipeToQueue.isArmed(80f, 80f))
        assertFalse(SwipeToQueue.isArmed(79f, 80f))
    }

    @Test fun deciding() {
        assertTrue(SwipeToQueue.shouldFailEarly(Offset(-7f, 0f)))
        assertTrue(SwipeToQueue.shouldFailEarly(Offset(3f, 7f)))
        assertFalse(SwipeToQueue.shouldFailEarly(Offset(8f, 7f)))
        assertTrue(SwipeToQueue.shouldBegin(100f, Offset(10f, 2f), Offset.Zero, 100, true))
        assertFalse(SwipeToQueue.shouldBegin(10f, Offset(10f, 2f), Offset.Zero, 100, true)) // screen edge
        assertFalse(SwipeToQueue.shouldBegin(100f, Offset(10f, 2f), Offset.Zero, 450, true)) // menu press won
        assertFalse(SwipeToQueue.shouldBegin(100f, Offset(10f, 2f), Offset.Zero, 100, false))
        assertTrue(SwipeToQueue.shouldBegin(100f, Offset.Zero, Offset(5f, 1f), 0, true)) // velocity when not moved
        assertFalse(SwipeToQueue.shouldBegin(100f, Offset(2f, 10f), Offset.Zero, 0, true))
    }

    @Test fun offlineRule() {
        assertTrue(SwipeToQueue.canQueue(offline = false, downloaded = false))
        assertTrue(SwipeToQueue.canQueue(offline = true, downloaded = true))
        assertFalse(SwipeToQueue.canQueue(offline = true, downloaded = false))
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class DesignToastTest {
    @Test fun showReplacesAndExpires() = runTest {
        val c = ToastCenter(backgroundScope)
        c.show("one")
        val first = c.toast.value
        testScheduler.advanceTimeBy(1000)
        c.show("two", seconds = 5.0)
        assertEquals("two", c.toast.value?.text)
        testScheduler.advanceTimeBy(2000) // the first timer was cancelled
        assertEquals("two", c.toast.value?.text)
        testScheduler.advanceTimeBy(3100)
        assertNull(c.toast.value)
        assertTrue(first != null)
        c.show("three"); c.hide()
        assertNull(c.toast.value)
    }

    @Test fun lyricJobWords() {
        assertEquals("Waiting · 2 ahead", ToastCenter.stageText(LyricJobStage.Waiting(2)))
        assertEquals("Starting", ToastCenter.stageText(LyricJobStage.Starting))
        assertEquals("Aligning", ToastCenter.stageText(LyricJobStage.Step("Aligning")))
        assertEquals("Song t1: Synced" to 5.0, ToastCenter.eventText(LyricJobEvent.Finished("t1", "Song t1", "Synced", false)))
        assertEquals("This song: Couldn't sync" to 5.0, ToastCenter.eventText(LyricJobEvent.Finished("t1", null, null, true)))
        assertEquals("X: Done", ToastCenter.eventText(LyricJobEvent.Finished("t1", "X", "", false)).first)
        assertEquals("Already syncing \"Tt2\"", ToastCenter.eventText(LyricJobEvent.AlreadySyncing("Tt2")).first)
        assertEquals("Couldn't sync lyrics: boom", ToastCenter.eventText(LyricJobEvent.StartFailed("boom")).first)
    }

    @Test fun layoutClearance() {
        assertEquals(121.dp, ToastLayout.Shell(miniPlayer = true).clearance)
        assertEquals(65.dp, ToastLayout.Shell(miniPlayer = false).clearance)
        assertEquals(112.dp, ToastLayout.NowPlaying.clearance)
    }
}

/** Image requests ask for WebP, share one request while in flight, and land in the memory cache. */
class DesignImageLoaderTest {
    @Test fun acceptHeaderDedupeAndMemoryCache() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(Buffer().write(ByteArray(16) { 7 })).setBodyDelay(200, TimeUnit.MILLISECONDS))
            server.start()
            val decoded = mutableListOf<Int>()
            val loader = ImageLoader(decode = { decoded += it.size; DesignFakeBitmap() })
            val url = server.url("/api/art/abc/160.webp").toString()
            val (a, b) = listOf(async { loader.image(url) }, async { loader.image(url) }).awaitAll()
            assertNotNull(a)
            assertSame(a, b)
            assertEquals(1, server.requestCount)
            assertEquals("image/webp,image/jpeg", server.takeRequest().getHeader("Accept"))
            assertSame(a, loader.cached(url))
            assertSame(a, loader.image(url))
            assertEquals(listOf(16), decoded)
            loader.evict(url)
            assertNull(loader.cached(url))
        }
    }

    @Test fun failuresAreNull() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(404))
            server.enqueue(MockResponse().setBody(""))
            server.start()
            val loader = ImageLoader(decode = { DesignFakeBitmap() })
            assertNull(loader.image(server.url("/a").toString()))
            assertNull(loader.image(server.url("/b").toString()))
            assertNull(loader.image("not a url"))
        }
    }

    @Test fun coverSourceUrls() {
        val api = com.lukasbaxter.slopify.android.core.api.ApiClient("https://music.example.com", "T")
        assertEquals("https://music.example.com/api/art/h1/160.webp", CoverSource.AlbumArt("al", "h1").url(api, 150))
        assertEquals("https://music.example.com/api/image/al?size=900", CoverSource.AlbumArt("al", "h1").url(api, 900))
        assertEquals("https://music.example.com/api/image/alb?size=900", CoverSource.TrackArt("t", "alb", "h").url(api, 900))
        assertEquals("https://music.example.com/api/image/pl_1?c=abcdefghij&size=96", CoverSource.PlaylistArt("pl_1", "abcdefghijk").url(api, 96))
        assertEquals("https://music.example.com/api/image/ar?kind=banner&size=600&w=600", CoverSource.Banner("ar").url(api, 600))
        assertEquals("https://music.example.com/api/users/u1/avatar", CoverSource.User("u1").url(api, 96))
        assertEquals("https://x.example.com/a.jpg", CoverSource.Url("https://x.example.com/a.jpg").url(null, 10))
        assertNull(CoverSource.Folder("fd_1").url(null, 10))
    }
}
