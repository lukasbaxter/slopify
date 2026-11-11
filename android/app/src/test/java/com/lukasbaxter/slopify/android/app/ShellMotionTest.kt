package com.lukasbaxter.slopify.android.app

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Velocity
import com.lukasbaxter.slopify.android.core.stores.LibraryAction
import com.lukasbaxter.slopify.android.core.stores.LibraryEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellMotionTest {
    @Test fun stackChanges() {
        val a = StackEntry(Route.Album("a")); val b = StackEntry(Route.Artist("b")); val c = StackEntry(Route.Album("a"))
        assertEquals(StackChange.None, StackChange.of(listOf(a), listOf(a)))
        assertEquals(StackChange.Push(b), StackChange.of(listOf(a), listOf(a, b)))
        assertEquals(StackChange.Pop(b), StackChange.of(listOf(a, b), listOf(a)))
        assertEquals("pop to root animates the top page", StackChange.Pop(b), StackChange.of(listOf(a, b), emptyList()))
        assertEquals(StackChange.Replace, StackChange.of(listOf(a), listOf(b)))
        // Same route pushed twice: different pages (ids), equal as values.
        assertEquals(a, c); assertNotEquals(a.id, c.id)
        assertEquals(StackChange.Replace, StackChange.of(listOf(a), listOf(c)))
    }

    private fun mayBegin(
        tab: Boolean = true, count: Int = 1, x: Float = 100f, y: Float = 200f, dir: Offset = Offset(10f, 2f),
        top: Boolean = true, consumed: Boolean = false,
    ) = ShellMotion.swipeBackMayBegin(tab, count, x, y, 800f, dir, top, consumed)

    @Test fun librarySwipeBackRules() {
        assertTrue(mayBegin())
        assertFalse("other tabs", mayBegin(tab = false))
        assertFalse("library root", mayBegin(count = 0))
        assertFalse("system edge", mayBegin(x = 10f))
        assertFalse("bottom half", mayBegin(y = 500f))
        assertFalse("leftward", mayBegin(dir = Offset(-10f, 0f)))
        assertFalse("vertical", mayBegin(dir = Offset(5f, 9f)))
        assertFalse("scrolled down", mayBegin(top = false))
        assertFalse("track row took it (swipe to queue)", mayBegin(consumed = true))
        assertTrue(ShellMotion.swipeBackCommits(150f, 400f, 0f))
        assertFalse(ShellMotion.swipeBackCommits(100f, 400f, 0f))
        assertTrue("flick", ShellMotion.swipeBackCommits(30f, 400f, 1200f))
        assertFalse(ShellMotion.swipeBackCommits(0f, 400f, 1200f))
    }

    @Test fun dismissThresholds() {
        assertTrue(ShellMotion.dismissCommits(141f, 1000))
        assertFalse(ShellMotion.dismissCommits(100f, 1000))
        assertTrue("flick", ShellMotion.dismissCommits(61f, 200))
        assertFalse(ShellMotion.dismissCommits(50f, 200))
    }

    @Test fun zoomGeometry() {
        val full = Rect(0f, 0f, 400f, 800f)
        val tile = Rect(16f, 300f, 166f, 450f)
        assertEquals(tile, ShellMotion.lerp(tile, full, 0f))
        assertEquals(full, ShellMotion.lerp(tile, full, 1f))
        assertEquals(full, ShellMotion.pulledRect(full, 0f))
        val pulled = ShellMotion.pulledRect(full, 200f)
        assertEquals(200f, pulled.top, 0.01f)
        assertTrue(pulled.width < full.width)
        assertEquals(full.center.x, pulled.center.x, 0.01f)
        assertEquals("never smaller than the floor", full.width * ShellMotion.PULL_MIN_SCALE, ShellMotion.pulledRect(full, 5000f).width, 0.01f)
        assertEquals(full.center, ShellMotion.backRect(full, 1f).center)
        assertEquals(0f, ShellMotion.slideX(1f, 400f)); assertEquals(400f, ShellMotion.slideX(0f, 400f))
        assertEquals(-100f, ShellMotion.belowX(1f, 400f), 0.01f)
    }

    private class FakeTarget(var allow: Boolean = true) : ShellDragDismiss.Target {
        var moved = 0f; var released: Boolean? = null; var begun = 0
        override fun begin(): Boolean { begun++; return allow }
        override fun moved(dyPx: Float) { moved = dyPx }
        override fun released(commit: Boolean) { released = commit }
    }

    @Test fun dragDismissFromTheListTop() {
        var now = 0L
        val t = FakeTarget()
        val d = ShellDragDismiss(Density(1f), t) { now }
        val user = NestedScrollSource.UserInput
        assertNull("nothing until the list hands over", d.preScroll(Offset(0f, 20f), user))
        assertNull("a fling never starts a pull", d.postScroll(Offset(0f, 30f), NestedScrollSource.SideEffect))
        assertEquals(Offset(0f, 30f), d.postScroll(Offset(0f, 30f), user))
        assertEquals(30f, t.moved)
        assertEquals("pushing up takes the pull back first", Offset(0f, -10f), d.preScroll(Offset(0f, -10f), user))
        assertEquals(20f, t.moved)
        now = 1000
        assertEquals(Velocity(0f, 5f), d.preFling(Velocity(0f, 5f)))
        assertEquals(false, t.released)
        // Far enough: closes.
        d.postScroll(Offset(0f, 150f), user); d.release()
        assertEquals(true, t.released)
        // Refused while leaving.
        val r = FakeTarget(allow = false)
        val d2 = ShellDragDismiss(Density(1f), r) { 0L }
        assertNull(d2.postScroll(Offset(0f, 30f), user))
        assertNull(d2.preFling(Velocity.Zero))
    }

    @Test fun libraryEventWords() {
        assertEquals("Added to Mix", LibraryEvent.Added("Mix").toastText())
        assertEquals("Could not save Your Library: nope", LibraryEvent.Failed(LibraryAction.SaveLibrary, "nope").toastText())
        assertEquals("Playlist updated", LibraryEvent.PlaylistUpdated.toastText())
    }
}
