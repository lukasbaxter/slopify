package com.lukasbaxter.slopify.android.features.account

import androidx.compose.ui.graphics.Color
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.theme.ThemeColors
import com.lukasbaxter.slopify.android.design.theme.ThemePreset
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountSettingsLogicTest {
    private val phone = AccountSettingsLogic.QualityKey.PhoneQuality
    private val other = AccountSettingsLogic.QualityKey.Quality

    @Test fun qualityDefaultsAndFallback() {
        assertEquals("high", AccountSettingsLogic.quality(phone, emptyMap()).id)
        assertEquals("original", AccountSettingsLogic.quality(other, emptyMap()).id)
        assertEquals("low", AccountSettingsLogic.quality(other, mapOf("quality" to JsonPrimitive("low"))).id)
        assertEquals("high", AccountSettingsLogic.quality(phone, mapOf("phoneQuality" to JsonPrimitive("bogus"))).id)
    }

    @Test fun togglesFollowWeb() {
        assertTrue(AccountSettingsLogic.normalizeOn(emptyMap()))
        assertFalse(AccountSettingsLogic.normalizeOn(mapOf("normalize" to JsonPrimitive(false))))
        assertTrue(AccountSettingsLogic.gaplessOn(mapOf("gapless" to JsonPrimitive("x"))))
        // A string "false" is not the boolean false.
        assertTrue(AccountSettingsLogic.gaplessOn(mapOf("gapless" to JsonPrimitive("false"))))
        // `{ key: prefs.key === false }`
        assertEquals(mapOf("normalize" to JsonPrimitive(false)), AccountSettingsLogic.togglePatch("normalize", emptyMap()))
        assertEquals(mapOf("normalize" to JsonPrimitive(true)), AccountSettingsLogic.togglePatch("normalize", mapOf("normalize" to JsonPrimitive(false))))
        assertEquals(mapOf("gapless" to JsonPrimitive(false)), AccountSettingsLogic.togglePatch("gapless", mapOf("gapless" to JsonPrimitive(true))))
    }

    @Test fun crossfade() {
        assertEquals(0, AccountSettingsLogic.crossfade(emptyMap()))
        assertEquals(5, AccountSettingsLogic.crossfade(mapOf("crossfade" to JsonPrimitive(5))))
        assertEquals(8, AccountSettingsLogic.crossfade(mapOf("crossfade" to JsonPrimitive("8"))))
        assertEquals(0, AccountSettingsLogic.crossfade(mapOf("crossfade" to JsonPrimitive(true))))
        assertEquals("Off", AccountSettingsLogic.crossfadeLabel(0))
        assertEquals("1 second", AccountSettingsLogic.crossfadeLabel(1))
        assertEquals("12 seconds", AccountSettingsLogic.crossfadeLabel(12))
    }

    @Test fun scrobbling() {
        val off = AccountSettingsLogic.ListenBrainz.of(emptyMap())
        assertFalse(off.connected)
        assertEquals("Off", AccountSettingsLogic.scrobblingSubtitle(off))
        assertEquals("Scrobbling is off until a token is saved.", AccountSettingsLogic.scrobblingStatus(off))
        val on = AccountSettingsLogic.ListenBrainz.of(mapOf("listenbrainz" to JsonObject(mapOf("user" to JsonPrimitive("ava"), "token" to JsonPrimitive("t")))))
        assertEquals("On, as ava", AccountSettingsLogic.scrobblingSubtitle(on))
        assertEquals("Scrobbling as ava.", AccountSettingsLogic.scrobblingStatus(on))
        val anon = AccountSettingsLogic.ListenBrainz(token = "t")
        assertEquals("On, as your account", AccountSettingsLogic.scrobblingSubtitle(anon))
        assertFalse(AccountSettingsLogic.scrobblingDirty(on, on))
        assertTrue(AccountSettingsLogic.scrobblingDirty(anon, on))
        assertEquals(AccountSettingsLogic.ListenBrainz("a", "x"), AccountSettingsLogic.scrobblingSubmit(AccountSettingsLogic.ListenBrainz(" a ", "\tx\n")))
        assertEquals(JsonObject(mapOf("user" to JsonPrimitive(""), "token" to JsonPrimitive(""))), AccountSettingsLogic.ListenBrainz().prefValue)
    }

    @Test fun languageAndTheme() {
        assertEquals("Automatic", AccountSettingsLogic.languageLabel(""))
        assertEquals("Deutsch", AccountSettingsLogic.languageLabel("de"))
        assertEquals("Classic", AccountSettingsLogic.themeLabel(ThemeColors.Default))
        assertEquals("Custom", AccountSettingsLogic.themeLabel(ThemeColors("#123456", "#000000", "#111111", "#ffffff")))
        assertFalse(AccountSettingsLogic.canReset(ThemeColors("#1ED760", "#121212", "#1f1f1f", "#FFFFFF")))
        assertTrue(AccountSettingsLogic.canReset(ThemePreset.all[1].colors))
    }

    @Test fun aboutLinks() {
        val a = AccountAboutText.paragraph("1.2", null, Color.White)
        assertTrue(a.text.startsWith("Slopify 1.2 is free software under the GNU AGPL v3."))
        assertFalse(a.text.contains("<a>"))
        val links = a.getLinkAnnotations(0, a.length).map { (it.item as androidx.compose.ui.text.LinkAnnotation.Url).url }
        assertEquals(
            listOf("https://www.gnu.org/licenses/agpl-3.0.html", "https://github.com/lukasbaxter/slopify", "https://github.com/lukasbaxter/slopify/blob/main/docs/PRIVACY.md"),
            links,
        )
        val custom = AccountAboutText.paragraph(null, "https://example.com/src", Color.White)
        assertTrue(custom.text.startsWith("Slopify is free software"))
        assertEquals("https://example.com/src/blob/main/docs/PRIVACY.md", (custom.getLinkAnnotations(0, custom.length).last().item as androidx.compose.ui.text.LinkAnnotation.Url).url)
    }

    @Test fun drawerSwipe() {
        assertTrue(AccountDrawerLogic.isCloseSwipe(-60f, 10f))
        assertFalse(AccountDrawerLogic.isCloseSwipe(-40f, 0f))
        assertFalse(AccountDrawerLogic.isCloseSwipe(-60f, 50f))
        assertFalse(AccountDrawerLogic.isCloseSwipe(80f, 0f))
    }
}

class AccountProfileLogicTest {
    private fun track(id: String, artists: List<Pair<String, String>>, plays: Int?) = Track(
        id = id, title = id, artist = artists.firstOrNull()?.first.orEmpty(), artists = artists.map { it.first }, artistIds = artists.map { it.second },
        albumId = "al", album = "Al", albumArtist = "", durationMs = 1000, plays = plays,
    )

    @Test fun topArtistsScoring() {
        val top = AccountProfileLogic.topArtists(
            listOf(
                track("1", listOf("A" to "a"), 2), // a 3
                track("2", listOf("B" to "b", "A" to "a"), 0), // b 1, a 4
                track("3", listOf("C" to "c"), null), // c 1
                track("4", listOf("B" to "b"), 0), // b 2
            ),
        )
        assertEquals(listOf("a", "b", "c"), top.map { it.id })
        assertEquals(listOf(4, 2, 1), top.map { it.score })
        assertEquals(16, AccountProfileLogic.topArtists((0 until 30).map { track("$it", listOf("x$it" to "x$it"), 0) }).size)
        // Ties keep first-seen order.
        assertEquals(listOf("p", "q"), AccountProfileLogic.topArtists(listOf(track("1", listOf("P" to "p"), 0), track("2", listOf("Q" to "q"), 0))).map { it.id })
    }

    @Test fun texts() {
        assertEquals("1 public playlist", AccountProfileLogic.playlistCount(1))
        assertEquals("3 public playlists", AccountProfileLogic.playlistCount(3))
        assertEquals("L", AccountProfileLogic.initial("lukas"))
        assertEquals("?", AccountProfileLogic.initial(null))
        assertEquals("?", AccountProfileLogic.initial(""))
    }

    @Test fun photoTargetSize() {
        // The bitmap re-encode needs the Android runtime; the size maths is checked here.
        assertEquals(1024 to 512, AccountProfilePhoto.target(2000, 1000))
        assertEquals(512 to 1024, AccountProfilePhoto.target(1000, 2000))
        assertEquals(800 to 600, AccountProfilePhoto.target(800, 600))
        assertEquals(1024 to 1, AccountProfilePhoto.target(4000, 1))
        assertEquals(0 to 0, AccountProfilePhoto.target(0, 10))
    }
}
