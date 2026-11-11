package com.lukasbaxter.slopify.android.features.library

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live drag shared by Your Library and playlist songs, all in content coordinates: a still
 * hold is the menu, a move lands in a slot (the playlist sends it as `{from, to}`).
 */
class LibraryDragControllerTest {
    private fun songs(n: Int) = (0 until n).map { LibraryDrag.Row("s$it", false, Rect(0f, it * 64f, 393f, it * 64f + 64f)) }

    @Test fun stillHoldIsTheMenu() {
        val c = LibraryDragController()
        c.begin("s1", songs(4), Offset(100f, 100f))
        c.move(Offset(103f, 104f))
        assertEquals(LibraryDragController.Outcome.Hold("s1"), c.end())
        assertFalse(c.isLifted)
    }

    @Test fun dragDownLandsInFinalSlot() {
        val c = LibraryDragController()
        c.begin("s0", songs(4), Offset(100f, 30f))
        c.move(Offset(100f, 30f + 64 * 2 + 40))
        assertEquals(64f * 2 + 40, c.offset("s0").y, 0.001f) // under the finger
        assertEquals(-64f, c.offset("s1").y, 0.001f)          // slid up out of the way
        assertEquals(LibraryDragController.Outcome.Drop("s0", 2, null, listOf("s0", "s1", "s2", "s3")), c.end())
    }

    @Test fun movedBackIsNoDrop() {
        val c = LibraryDragController()
        c.begin("s2", songs(4), Offset(100f, 150f))
        c.move(Offset(100f, 60f))  // aims at slot 1
        // Back over the lower half of s1 (now slid down into slot 2): its own slot again.
        c.move(Offset(100f, 170f))
        assertNull(c.end())
    }

    @Test fun listScrollingUnderStillFingerRetargets() {
        // Auto-scroll: the finger stays put on screen but its content point moves 3 rows down.
        val c = LibraryDragController()
        c.begin("s0", songs(8), Offset(100f, 30f))
        c.move(Offset(100f, 40f))
        c.move(Offset(100f, 40f + 64 * 3))
        assertEquals(3, c.lift?.target?.to)
        assertEquals(LibraryDragController.Outcome.Drop("s0", 3, null, (0 until 8).map { "s$it" }), c.end())
    }

    @Test fun cancelPutsBack() {
        val c = LibraryDragController()
        c.begin("s0", songs(4), Offset(100f, 30f))
        c.move(Offset(100f, 200f))
        c.cancel()
        assertFalse(c.isLifted)
        assertNull(c.end())
        assertEquals(Offset.Zero, c.offset("s0"))
    }

    @Test fun recognizerOnlyBeginsOverADragRow() {
        // Flat mode / Liked Songs / hero: no row under the finger, so the list keeps the touch.
        val c = LibraryDragController()
        assertNull(c.rowId(Offset(100f, 30f)))
        c.rows = { listOf(LibraryDrag.Row("a", false, Rect(16f, 80f, 377f, 160f))) }
        assertNull(c.rowId(Offset(100f, 40f)))   // the Liked row above
        assertEquals("a", c.rowId(Offset(100f, 120f)))
    }

    @Test fun ghostFollowsFingerAndLineMarksSlot() {
        val c = LibraryDragController()
        c.begin("s0", songs(4), Offset(100f, 30f))
        assertNull(c.dropLine) // its own slot
        c.move(Offset(100f, 30f + 64 * 2 + 40))
        assertEquals(Rect(0f, 168f, 393f, 232f), c.ghost)
        assertEquals(Rect(4f, 64f * 2 + 31f, 389f, 64f * 2 + 33f), c.dropLine)
        assertTrue(c.isLifted)
    }

    @Test fun finishClearsHolding() {
        val c = LibraryDragController()
        var got: LibraryDragController.Outcome? = LibraryDragController.Outcome.Hold("none")
        c.onFinish = { got = it }
        c.holding = true
        c.begin("s1", songs(3), Offset(10f, 70f))
        c.finish(c.end())
        assertFalse(c.holding)
        assertEquals(LibraryDragController.Outcome.Hold("s1"), got)
    }

    @Test fun beginOnUnknownRowDoesNothing() {
        val c = LibraryDragController()
        c.begin("nope", songs(3), Offset(10f, 10f))
        assertFalse(c.isLifted)
        c.move(Offset(10f, 100f))
        assertNull(c.end())
    }
}
