package com.lukasbaxter.slopify.android.features.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** The kept widget state: a new process (a new store on the same folder) draws what the last one showed. */
class WidgetStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    private val snapshot = WidgetSnapshot(
        track = WidgetTrack("t1", "One Dance", "Drake", cover = "c.png"), playing = true, color = listOf(1, 2, 3),
        tiles = listOf(WidgetTile("artist", "ar1", "Valley", art = "h", cover = "a.png")),
    )

    @Test fun startsEmpty() {
        val s = WidgetStore(File(tmp.root, "widget"))
        assertEquals(WidgetSnapshot(), s.snapshot.value)
        assertNull(s.progress.value)
    }

    @Test fun survivesProcessDeath() {
        val dir = File(tmp.root, "widget")
        val a = WidgetStore(dir)
        a.update { snapshot }
        a.setProgress(0.42f)
        a.flush()
        val b = WidgetStore(dir)
        assertEquals(snapshot, b.snapshot.value)
        assertEquals(0.42f, b.progress.value!!, 0.0001f)
    }

    @Test fun aBrokenFileIsAnEmptyWidget() {
        val dir = File(tmp.root, "widget").apply { mkdirs() }
        File(dir, "state.json").writeText("{ nope")
        assertEquals(WidgetSnapshot(), WidgetStore(dir).snapshot.value)
    }

    @Test fun clearForgetsEverything() {
        val dir = File(tmp.root, "widget")
        val a = WidgetStore(dir)
        a.update { snapshot }
        a.flush()
        File(dir, "c.png").writeText("x")
        a.clear()
        a.flush()
        assertEquals(WidgetSnapshot(), a.snapshot.value)
        assertFalse(dir.exists())
        assertEquals(WidgetSnapshot(), WidgetStore(dir).snapshot.value)
    }

    @Test fun pruneKeepsWhatIsShownAndWhatWasJustSaved() {
        val dir = File(tmp.root, "widget")
        val a = WidgetStore(dir)
        a.update { snapshot }
        a.flush()
        val old = System.currentTimeMillis() - 600_000
        for (n in listOf("c.png", "a.png", "gone.png")) File(dir, n).apply { writeText("x"); setLastModified(old) }
        File(dir, "fresh.png").writeText("x")
        a.prune()
        a.flush()
        assertTrue(File(dir, "c.png").exists()); assertTrue(File(dir, "a.png").exists())
        assertTrue(File(dir, "fresh.png").exists()); assertTrue(File(dir, "state.json").exists())
        assertFalse(File(dir, "gone.png").exists())
    }
}
