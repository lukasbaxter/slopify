package com.lukasbaxter.slopify.android.design

import androidx.compose.ui.text.font.FontWeight
import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.storage.MemoryStore
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LocalizerTest {
    /** The bundled tables, read from the resource files the app ships (res/raw). */
    private val raw = File("src/main/res/raw")
    private fun table(code: String): Map<String, String> =
        File(raw, "locale_" + code.lowercase().replace('-', '_') + ".json").takeIf { it.exists() }?.let { Localizer.parse(it.readText()) } ?: emptyMap()

    @Test fun placeholders() {
        assertEquals("Added to Road trip", Localizer.fill("Added to {name}", mapOf("name" to "Road trip")))
        assertEquals("3 of {total}", Localizer.fill("{n} of {total}", mapOf("n" to 3))) // missing stays literal
        assertEquals("a {not a var} b", Localizer.fill("a {not a var} b", mapOf("not" to 1)))
        assertEquals("no vars", Localizer.fill("no vars", emptyMap()))
        assertEquals("{} {x", Localizer.fill("{} {x", mapOf("x" to 1)))
    }

    @Test fun matchMirrorsI18nJS() {
        assertEquals("de", Localizer.match("de-AT"))
        assertEquals("pt-BR", Localizer.match("pt"))
        assertEquals("pt-BR", Localizer.match("pt_PT"))
        assertEquals("zh-TW", Localizer.match("zh-Hant-TW"))
        assertEquals("zh-TW", Localizer.match("zh-HK"))
        assertEquals("zh-CN", Localizer.match("zh"))
        assertEquals("nb", Localizer.match("no"))
        assertEquals("nb", Localizer.match("nn-NO"))
        assertEquals("en", Localizer.match("EN-us"))
        assertNull(Localizer.match("auto"))
        assertNull(Localizer.match("xx"))
        assertNull(Localizer.match(""))
    }

    @Test fun resolveOrder() {
        assertEquals("fr", Localizer.resolve("fr", "de", listOf("ja")))
        assertEquals("de", Localizer.resolve("", "de", listOf("ja")))
        assertEquals("ja", Localizer.resolve(null, "auto", listOf("xx", "ja-JP")))
        assertEquals("en", Localizer.resolve(null, null, listOf("xx")))
    }

    @Test fun bundledLocalesLoadAndSwitchLive() {
        assertEquals(22, Localizer.languages.size)
        assertEquals(Localizer.languages.map { it.first }.filter { it != "en" }.toSet(), Localizer.RAW.keys)
        for ((code, _) in Localizer.languages) if (code != "en") assertFalse("$code missing from res/raw", table(code).isEmpty())
        val store = MemoryStore()
        val l = Localizer(store, ::table) { listOf("en") }
        assertEquals("Add to queue", l.t("Add to queue"))
        l.setUserPick("de")
        assertEquals("de", l.language)
        assertEquals("de", store.getString(Localizer.USER_KEY))
        assertNotEquals("Add to queue", l.t("Add to queue"))
        assertEquals("A key nobody has", l.t("A key nobody has"))
        l.setUserPick("")
        assertEquals("en", l.language)
        assertNull(store.getString(Localizer.USER_KEY))
    }

    @Test fun translationsKeepPlaceholders() {
        val s = table("de")["Added to {name}"]
        assertTrue("missing key", s != null && s.contains("{name}"))
    }

    @Test fun emptyTranslationFallsBackToEnglish() {
        val l = Localizer(MemoryStore(), { mapOf("Play" to "") }) { listOf("fr") }
        assertEquals("fr", l.language)
        assertEquals("Play", l.t("Play"))
    }

    @Test fun followsPrefsLanguageLive() = runTest {
        val prefs = MutableStateFlow<Prefs>(emptyMap())
        val l = Localizer(MemoryStore(), ::table) { listOf("en") }
        l.follow(prefs, backgroundScope)
        testScheduler.runCurrent()
        assertEquals("en", l.language)
        prefs.value = mapOf("language" to JsonPrimitive("fr"))
        testScheduler.runCurrent()
        assertEquals("fr", l.language)
        prefs.value = mapOf("language" to JsonPrimitive("auto"))
        testScheduler.runCurrent()
        assertEquals("en", l.language)
    }

    @Test fun serverDefault() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"language":"ja"}"""))
            server.start()
            val l = Localizer(MemoryStore(), ::table) { listOf("en") }
            l.refreshServerDefault(ApiClient(server.url("/").toString().trimEnd('/')))
            assertEquals("ja", l.language)
            assertEquals("/api/i18n", server.takeRequest().path)
            l.setUserPick("es")
            assertEquals("es", l.language) // the person's pick wins
        }
    }

    @Test fun boldMarkup() {
        val a = boldMarkup("<b>Tap along to the beat</b> for 8 seconds.")
        assertEquals("Tap along to the beat for 8 seconds.", a.text)
        assertEquals(FontWeight.Bold, a.spanStyles.single().item.fontWeight)
        assertEquals(0 until 21, a.spanStyles.single().let { it.start until it.end })
        assertEquals("plain", boldMarkup("plain").text)
    }

    @Test fun lUsesTheSharedLocalizer() {
        assertEquals("Added to Mix", L("Added to {name}", "name" to "Mix"))
    }
}
