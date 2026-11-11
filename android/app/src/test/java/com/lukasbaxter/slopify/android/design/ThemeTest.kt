package com.lukasbaxter.slopify.android.design

import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Theme
import com.lukasbaxter.slopify.android.design.theme.ThemeColors
import com.lukasbaxter.slopify.android.design.theme.ThemePreset
import com.lukasbaxter.slopify.android.design.theme.ThemeStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every derived token must equal what prefs.js `applyTheme()` writes, for every preset plus a
 * pale-accent light theme and a theme with bad keys.
 */
class ThemeTest {
    private fun token(t: Theme, v: String): RGB? {
        val r = t.rgb
        return mapOf(
            "--accent" to r.accent, "--accent-ink" to r.accentInk, "--accent-on-dark" to r.accentOnDark, "--accent-hover" to r.accentHover,
            "--accent-press" to r.accentPress, "--seek-accent" to r.seekAccent, "--on-accent" to r.onAccent, "--on-fg" to r.onFg,
            "--bg-base" to r.bgBase, "--bg-highlight" to r.bgHighlight, "--bg-elevated" to r.bgElevated, "--bg-elevated-hi" to r.bgElevatedHi,
            "--card" to r.card, "--card-hover" to r.cardHover, "--tint" to r.tint, "--tint-hi" to r.tintHi, "--tint-press" to r.tintPress,
            "--fg" to r.fg, "--fg-dim" to r.fgDim, "--fg-chrome" to r.fgChrome, "--theme-fg" to r.themeFg, "--theme-fg-dim" to r.themeFgDim,
            "--theme-on-fg" to r.themeOnFg, "--fg-sub" to r.fgSub, "--fg-faint" to r.fgFaint, "--black" to r.black, "--page" to r.page,
            "--chip" to r.chip, "--field" to r.field, "--sheet" to r.sheet, "--green" to r.green, "--danger" to r.danger, "--danger-bg" to r.dangerBg,
        )[v]
    }

    @Test fun allThemesMatchApplyTheme() {
        val cases = DesignFixtures.list("themes")
        assertEquals(8, cases.size)
        for (c0 in cases) {
            val c = c0.jsonObject
            val name = DesignFixtures.str(c["name"])
            val th = c["theme"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
            val t = Theme(ThemeColors(th["accent"]!!, th["bg"]!!, th["surface"]!!, th["fg"]!!))
            assertEquals(name, c["light"]!!.jsonPrimitive.content.toBoolean(), t.isLight)
            assertEquals(name, DesignFixtures.str(c["colorScheme"]), if (t.isLight) "light" else "dark")
            val vars = c["vars"]!!.jsonObject
            var checked = 0
            for ((v, e) in vars) {
                val expected = e.jsonPrimitive.content
                if (v.endsWith("-rgb")) {
                    val src = when (v) { "--accent-rgb" -> t.rgb.accent; "--page-rgb" -> t.rgb.page; else -> t.rgb.fg }
                    assertEquals("$name $v", expected, src.ints.joinToString(","))
                    checked++; continue
                }
                val tok = requireNotNull(token(t, v)) { "$name: unmapped $v" }
                val want = RGB.parse(expected)!!
                assertEquals("$name $v", want.hex, tok.hex)
                assertEquals("$name $v alpha", want.alpha, tok.alpha, 0.002)
                checked++
            }
            assertEquals(name, vars.size, checked)
        }
    }

    @Test fun presetsAndEquality() {
        assertEquals(listOf("Classic", "Midnight", "Ember", "Orchid", "Mono", "Paper"), ThemePreset.all.map { it.name })
        assertEquals("Classic", ThemePreset.matching(ThemeColors("#1ED760", "#121212", "#1F1F1F", "#FFFFFF"))?.name)
        assertNull(ThemePreset.matching(ThemeColors("#123456", "#121212", "#1f1f1f", "#ffffff")))
    }

    @Test fun prefParsingFallsBackPerKey() {
        val c = ThemeColors.fromPref(JsonObject(mapOf("accent" to JsonPrimitive("#4c8dff"), "bg" to JsonPrimitive("bad"), "fg" to JsonPrimitive(3))))
        assertEquals(ThemeColors("#4c8dff", "#121212", "#1f1f1f", "#ffffff"), c)
        assertEquals(ThemeColors.Default, ThemeColors.fromPref(null))
    }

    @Test fun darkIslandsOnLightTheme() {
        val paper = Theme(ThemePreset.all.last().colors)
        assertTrue(paper.isLight)
        assertEquals("#ffffff", paper.darkIsland.rgb.fg.hex)
        assertEquals("#a7a7a7", paper.darkIsland.rgb.fgSub.hex)
        assertEquals("#d0d0d0", paper.heroIsland.rgb.fgSub.hex)
        assertEquals(paper.rgb.accentOnDark.hex, paper.darkIsland.rgb.accentInk.hex)
        assertEquals("#282828", paper.darkIsland.rgb.sheet.hex)
        assertFalse(paper.darkIsland.isLight)
        // dark themes are unchanged
        assertSame(Theme.Default, Theme.Default.darkIsland)
        assertEquals(Theme.Default, Theme())
    }

    @Test fun rgbParsing() {
        assertEquals("#aabbcc", RGB.parse("abc")?.hex)
        assertEquals(0x1a / 255.0, RGB.parse("#ffffff1a")!!.alpha, 1e-9)
        assertNull(RGB.parse("#12"))
        assertNull(RGB.strictHex("#fff"))
        assertEquals("#000000", RGB.hex(0x1ed760).inkOn.hex)
    }

    @Test fun themeStoreFollowsAccountPrefs() = runTest {
        val prefs = MutableStateFlow<Prefs>(emptyMap())
        val patches = mutableListOf<Prefs>()
        val store = ThemeStore(prefs, backgroundScope) { patches += it; prefs.value = prefs.value + it }
        testScheduler.runCurrent()
        assertEquals("#1ed760", store.theme.value.rgb.accent.hex)
        store.fallback.value = ThemePreset.all[1].colors
        testScheduler.runCurrent()
        assertEquals("#4c8dff", store.theme.value.rgb.accent.hex)
        assertEquals("Midnight", store.preset?.name)
        // A patch from another device applies live.
        prefs.value = mapOf("theme" to ThemePreset.all[5].colors.prefValue)
        testScheduler.runCurrent()
        assertTrue(store.theme.value.isLight)
        assertEquals("Paper", store.preset?.name)
        // Saving goes to the account prefs.
        store.set(ThemePreset.all[2].colors)
        testScheduler.runCurrent()
        assertEquals(ThemePreset.all[2].colors.prefValue, patches.single()["theme"])
        assertEquals("Ember", store.preset?.name)
    }
}
