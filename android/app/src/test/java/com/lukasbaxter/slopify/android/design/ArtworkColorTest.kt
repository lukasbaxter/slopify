package com.lukasbaxter.slopify.android.design

import com.lukasbaxter.slopify.android.design.color.ArtworkColor
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.image.ImageLoader
import com.lukasbaxter.slopify.android.design.theme.RGB
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The colour maths must give the same numbers as web/src/api/colors.js and the JSX helpers. */
@OptIn(ExperimentalCoroutinesApi::class)
class ArtworkColorTest {
    private val fx = DesignFixtures

    @Test fun vibrantMatchesJS() {
        val vibrant = fx.root["vibrant"]!!.jsonObject
        assertEquals(6, vibrant.size)
        for ((name, expected) in vibrant) {
            assertEquals(name, fx.ints(expected), ColorMath.vibrant(fx.sets[name]!!)?.ints)
        }
    }

    @Test fun paletteMatchesJS() {
        for ((name, expected) in fx.root["palette"]!!.jsonObject) {
            val px40 = fx.sets[name]!!
            val px48 = IntArray(48 * 48 * 4) { px40[it % px40.size] }
            val got = ColorMath.palette(px48)?.map { "rgb(${it.ints.joinToString(",")})" }
            val want = if (expected is JsonNull) null else expected.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(name, want, got)
        }
    }

    @Test fun clampLightnessMatchesPlayerJSX() {
        for (c in fx.list("clamp")) {
            val i = fx.doubles(c.jsonObject["in"]!!)
            assertEquals("$i", fx.ints(c.jsonObject["out"]), ColorMath.clampLightness(RGB(i[0], i[1], i[2])).ints)
        }
    }

    @Test fun heroTintMatchesLibraryJSX() {
        for (h in fx.list("hero")) {
            val i = fx.doubles(h.jsonObject["in"]!!)
            assertEquals(fx.str(h.jsonObject["css"]), fx.str(h.jsonObject["hex"]), ColorMath.heroTint(RGB(i[0], i[1], i[2])).hex)
        }
    }

    @Test fun phoneHeroMatchesUITable() {
        val list = fx.list("phoneHero")
        assertEquals(10, list.size)
        for (p in list) assertEquals(fx.str(p.jsonObject["in"]), fx.str(p.jsonObject["hex"]), ColorMath.phoneHero(fx.str(p.jsonObject["in"]))?.hex)
        assertNull(ColorMath.phoneHero("nope"))
    }

    @Test fun blurhashAverage() {
        for (b in fx.list("blurhash")) {
            val input = fx.str(b.jsonObject["in"])
            assertEquals(input, fx.ints(b.jsonObject["out"]), ColorMath.blurhashAverage(input)?.ints)
        }
    }

    @Test fun detailHeroPrecedence() {
        val sampled = RGB(200.0, 30.0, 40.0)
        assertEquals("#601b33", ColorMath.detailHero(mixColor = "#e8115b", sampled = sampled).hex)
        assertEquals("#601b1f", ColorMath.detailHero(sampled = sampled).hex)
        assertEquals("#302457", ColorMath.detailHero(isLiked = true).hex)
        assertEquals("#601b1f", ColorMath.detailHero(sampled = sampled, isArtist = true).hex)
        assertEquals("#3d3c3c", ColorMath.detailHero().hex)
    }

    /** Sampling goes through the image bytes once, is remembered, and survives a relaunch on disk. */
    @Test fun vibrantIsCachedInMemoryAndOnDisk() = runTest {
        MockWebServer().use { server ->
            repeat(3) { server.enqueue(MockResponse().setBody(Buffer().write(byteArrayOf(1, 2, 3)))) }
            server.start()
            val url = server.url("/api/art/abc/64.webp").toString()
            val file = File.createTempFile("artwork-colors", ".json").apply { delete() }
            val loader = ImageLoader()
            val red = IntArray(40 * 40 * 4) { if (it % 4 == 0) 200 else if (it % 4 == 1) 30 else if (it % 4 == 2) 40 else 255 }
            var decodes = 0
            val colors = ArtworkColor({ loader }, file, pixels = { _, _ -> decodes++; red }, scope = backgroundScope)
            assertEquals("#c81e28", colors.vibrant(url)?.hex)
            assertEquals("#c81e28", colors.vibrant(url)?.hex)
            assertEquals(1, server.requestCount)
            assertEquals(1, decodes)
            assertEquals(ColorMath.clampLightness(RGB.hex(0xc81e28)), colors.mini(url))
            assertEquals(ColorMath.heroTint(RGB.hex(0xc81e28)), colors.hero(url))
            testScheduler.advanceTimeBy(2500)
            testScheduler.runCurrent()
            assertTrue("saved", file.exists())
            val again = ArtworkColor({ loader }, file, pixels = { _, _ -> error("no decode after a relaunch") }, scope = backgroundScope)
            assertEquals("#c81e28", again.vibrant(url)?.hex)
            assertEquals(1, server.requestCount)
            file.delete()
        }
    }
}
