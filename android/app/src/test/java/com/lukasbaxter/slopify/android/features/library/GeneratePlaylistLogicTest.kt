package com.lukasbaxter.slopify.android.features.library

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import com.lukasbaxter.slopify.android.core.model.GenerateInfo
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.stores.GenerateAvailability
import com.lukasbaxter.slopify.android.core.stores.GenerateBusy
import com.lukasbaxter.slopify.android.core.stores.GenerateRegenerate
import com.lukasbaxter.slopify.android.design.icons.Icon
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The Generate dialog's words and numbers (GeneratePlaylist.jsx; UI.md 6.4). English: no locale is loaded. */
class GeneratePlaylistLogicTest {
    @Test fun timeLeftCountsDownInFiveSecondSteps() {
        assertNull(GenerateText.timeLeft(null, 0))
        // Under 5 s (also once the estimate has run out).
        assertEquals("Almost done", GenerateText.timeLeft(4999.0, 0))
        assertEquals("Almost done", GenerateText.timeLeft(0.0, 0))
        assertEquals("Almost done", GenerateText.timeLeft(30000.0, 60000))
        // Rounded up to 5 s.
        assertEquals("About 5 s left", GenerateText.timeLeft(5000.0, 0))
        assertEquals("About 10 s left", GenerateText.timeLeft(5001.0, 0))
        assertEquals("About 45 s left", GenerateText.timeLeft(42000.0, 0))
        assertEquals("About 55 s left", GenerateText.timeLeft(55000.0, 0))
        // The time since the update arrived comes off.
        assertEquals("About 40 s left", GenerateText.timeLeft(42000.0, 2500))
        assertEquals("About 35 s left", GenerateText.timeLeft(42000.0, 7000))
        // Minutes, with and without seconds.
        assertEquals("About 1 min left", GenerateText.timeLeft(55001.0, 0))
        assertEquals("About 1 min left", GenerateText.timeLeft(60000.0, 0))
        assertEquals("About 1 min 5 s left", GenerateText.timeLeft(60001.0, 0))
        assertEquals("About 2 min 30 s left", GenerateText.timeLeft(150000.0, 0))
        assertEquals("About 3 min left", GenerateText.timeLeft(180000.0, 0))
    }

    @Test fun leftLineIsTheStepUntilTheJobHasInfo() {
        assertEquals("Starting", GenerateText.leftLine(GenerateBusy(gotMs = 1000), 1000))
        assertEquals("Queued", GenerateText.leftLine(GenerateBusy(step = "Queued", gotMs = 1000), 1000))
        val busy = GenerateBusy("Finding songs", 0.5, GenerateInfo(leftMs = 42000.0), gotMs = 1000)
        assertEquals("About 45 s left", GenerateText.leftLine(busy, 1000))
        assertEquals("About 35 s left", GenerateText.leftLine(busy, 8000)) // ticks without a new poll
        assertEquals("Almost done", GenerateText.leftLine(busy, 40000))
        // Info without an estimate: an empty line, not the step.
        assertNull(GenerateText.leftLine(GenerateBusy("Finding songs", 0.5, GenerateInfo(), gotMs = 1000), 1000))
    }

    @Test fun barShowsAtLeastThreePercent() {
        assertEquals(0, GenerateText.percent(null))
        assertEquals(40, GenerateText.percent(0.4))
        assertEquals(0.03f, GenerateText.barFraction(null), 0f)
        assertEquals(0.03f, GenerateText.barFraction(0.01), 0f)
        assertEquals(0.4f, GenerateText.barFraction(0.4), 0f)
        assertEquals(1f, GenerateText.barFraction(1.0), 0f)
        assertEquals(1f, GenerateText.barFraction(1.7), 0f)
    }

    @Test fun stageDetails() {
        val info = GenerateInfo(found = 180, foundNew = 150)
        fun st(key: String, state: String, detail: String? = null) = GenerateInfo.Stage(key, "L", state, detail)
        assertEquals("180 songs, 150 you have not played", GenerateText.stageDetail(st("find", "done"), info))
        // Nothing found yet, or another stage: only an active stage's own detail.
        assertNull(GenerateText.stageDetail(st("find", "done"), GenerateInfo()))
        assertNull(GenerateText.stageDetail(st("plan", "done", "left over"), info))
        assertEquals("by sound", GenerateText.stageDetail(st("find", "active", "by sound"), info))
        assertNull(GenerateText.stageDetail(st("find", "active"), info))
        assertNull(GenerateText.stageDetail(st("pick", "pending", "later"), info))
    }

    @Test fun generateNeedsWordsAnIdleDialogAndAServerThatCan() {
        assertTrue(GenerateText.canSubmit("rainy day", false, GenerateAvailability.Ok))
        assertFalse(GenerateText.canSubmit("   ", false, GenerateAvailability.Ok))
        assertFalse(GenerateText.canSubmit("rainy day", true, GenerateAvailability.Ok))
        assertFalse(GenerateText.canSubmit("rainy day", false, GenerateAvailability.Loading))
        assertFalse(GenerateText.canSubmit("rainy day", false, GenerateAvailability.Unreachable))
    }

    @Test fun unavailableWords() {
        assertNull(GenerateText.unavailable(GenerateAvailability.Loading))
        assertNull(GenerateText.unavailable(GenerateAvailability.Ok))
        assertEquals("The brain is off", GenerateText.unavailable(GenerateAvailability.Off("The brain is off")))
        assertEquals("Generated playlists are not available on this server.", GenerateText.unavailable(GenerateAvailability.Off(null)))
        assertEquals("Could not reach the server.", GenerateText.unavailable(GenerateAvailability.Unreachable))
    }

    @Test fun titlesAndNotes() {
        assertEquals("Generated playlist", GenerateText.title(false))
        assertEquals("Regenerate playlist", GenerateText.title(true))
        assertTrue(GenerateText.note(false).startsWith("Describe what you want."))
        assertTrue(GenerateText.note(true).startsWith("Change the request or keep it."))
    }

    @Test fun promptIsCutAtAThousandCharacters() {
        val ok = TextFieldValue("a".repeat(1000), TextRange(1000))
        assertEquals(ok, GenerateText.clamp(ok))
        val long = GenerateText.clamp(TextFieldValue("a".repeat(1200), TextRange(1200)))
        assertEquals(1000, long.text.length)
        assertEquals(TextRange(1000), long.selection)
    }

    @Test fun everyWordOfTheDialogIsInEveryLocale() {
        // The web's keys, verbatim: a typo here would show English in every language.
        val keys = GenerateText.ideas + listOf(
            "Generated playlist (AI)", "Regenerate", "Generated playlist", "Regenerate playlist", "Generate", "Cancel", "Hide", "Starting",
            "Could not reach the server.", "Generated playlists are not available on this server.",
            "Describe what you want. The brain finds 25 songs in your library that sound like it: 20 you have not played yet, 5 you know.",
            "Change the request or keep it. The songs in this playlist are replaced; a name or cover you gave it stays.",
            "e.g. rainy day indie, a bit melancholy",
            "Almost done", "About {s} s left", "About {m} min {s} s left", "About {m} min left", "{n} songs, {fresh} you have not played",
            "Could not generate the playlist: {error}", "1 more song is downloading and will be added.", "{n} more songs are downloading and will be added.",
            "{name} regenerated. {more}", "{name} regenerated", "{name} is ready in Your Library. {more}", "{name} is ready in Your Library.",
        )
        assertEquals(5, GenerateText.ideas.size)
        val raw = listOf(File("src/main/res/raw"), File("app/src/main/res/raw")).first { it.isDirectory }
        val locales = raw.listFiles { f -> f.name.startsWith("locale_") && f.name.endsWith(".json") }!!
        assertTrue(locales.size >= 21)
        for (f in locales) {
            val words = com.lukasbaxter.slopify.android.design.i18n.Localizer.parse(f.readText())
            for (k in keys) assertTrue("${f.name} lacks \"$k\"", !words[k].isNullOrEmpty())
        }
    }

    // Menus

    @Test fun createSheetOffersPlaylistGeneratedPlaylistAndFolder() {
        val tapped = mutableListOf<String>()
        val items = LibraryMenus.create({ tapped += "playlist" }, { tapped += "generate" }, { tapped += "folder" })
        // Sidebar.jsx `createItems`: this order.
        assertEquals(listOf("Playlist", "Generated playlist (AI)", "Folder"), items.map { it.label })
        assertEquals(listOf(Icon.Playlist, Icon.Sparkle, Icon.Folder), items.map { it.icon })
        items[1].action!!.invoke()
        assertEquals(listOf("generate"), tapped)
        items.forEach { it.action!!.invoke() }
        assertEquals(listOf("generate", "playlist", "generate", "folder"), tapped)
    }

    @Test fun regenerateOnlyForAPlaylistWithAPrompt() {
        var opened: GenerateRegenerate? = null
        assertNull(LibraryMenus.regenerate(null) { opened = it })
        assertNull(LibraryMenus.regenerate(Playlist("pl_1", "Mine")) { opened = it })
        assertNull(LibraryMenus.regenerate(Playlist("pl_1", "Mine", aiPrompt = "")) { opened = it })
        val item = LibraryMenus.regenerate(Playlist("pl_2", "Rainy day", aiPrompt = "rainy day indie"), Icon.Sparkle) { opened = it }!!
        assertEquals("Regenerate", item.label)
        assertEquals(Icon.Sparkle, item.icon)
        assertNull(opened)
        item.action!!.invoke()
        // The dialog opens on that playlist with what was asked last time.
        assertEquals(GenerateRegenerate("pl_2", "rainy day indie"), opened)
    }
}
