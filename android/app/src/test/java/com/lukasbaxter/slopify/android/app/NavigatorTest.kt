package com.lukasbaxter.slopify.android.app

import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigatorTest {
    @Test fun perTabStacks() {
        val n = Navigator()
        n.push(Route.Album("a"))
        n.select(Tab.Library)
        n.push(Route.Playlist("p"))
        assertEquals(listOf(StackEntry(Route.Album("a"))), n.state.value.stack(Tab.Home))
        assertEquals(Route.Playlist("p"), n.state.value.top?.route)
        n.select(Tab.Search)
        assertNull(n.state.value.top)
        n.select(Tab.Library)
        assertEquals("other tabs keep their place", Route.Playlist("p"), n.state.value.top?.route)
    }

    @Test fun homeAlwaysLandsOnItsRoot() {
        val n = Navigator()
        n.push(Route.Album("a"))
        n.select(Tab.Search)
        n.select(Tab.Home)
        assertTrue(n.state.value.stack(Tab.Home).isEmpty())
    }

    @Test fun litTabPopsToRootThenScrollsToTop() {
        val n = Navigator()
        n.select(Tab.Library)
        n.push(Route.LikedSongs); n.push(Route.Album("a"))
        n.select(Tab.Library)
        assertTrue(n.state.value.stack(Tab.Library).isEmpty())
        assertNull(n.state.value.scrollToTop[Tab.Library])
        n.select(Tab.Library)
        assertEquals(1, n.state.value.scrollToTop[Tab.Library])
    }

    @Test fun pushFromHomeMarksTheEntry() {
        val n = Navigator()
        n.select(Tab.Search)
        n.pushFromHome(Route.ReleaseRadar)
        assertEquals(listOf(StackEntry(Route.ReleaseRadar, fromHome = true)), n.state.value.stack(Tab.Home))
        assertTrue(n.state.value.stack(Tab.Search).isEmpty())
    }

    @Test fun openClosesTheLayers() {
        val n = Navigator()
        n.setNowPlayingOpen(true); n.setQueueOpen(true); n.setDrawerOpen(true)
        n.open(Route.Artist("x"))
        val s = n.state.value
        assertFalse(s.nowPlayingOpen || s.queueOpen || s.drawerOpen)
        assertEquals(Route.Artist("x"), s.top?.route)
    }

    @Test fun backClosesTopLayerFirst() {
        val n = Navigator()
        n.push(Route.Album("a"))
        n.setNowPlayingOpen(true); n.setQueueOpen(true); n.setDeviceSheetOpen(true)
        assertTrue(n.back()); assertFalse(n.state.value.queueOpen); assertTrue(n.state.value.nowPlayingOpen)
        assertTrue(n.back()); assertFalse(n.state.value.nowPlayingOpen)
        assertTrue(n.back()); assertFalse(n.state.value.deviceSheetOpen)
        assertTrue(n.back()); assertNull(n.state.value.top)
        assertFalse("nothing left: the system handles back", n.back())
        // Closing now playing also closes the queue above it.
        n.setNowPlayingOpen(true); n.setQueueOpen(true); n.setNowPlayingOpen(false)
        assertFalse(n.state.value.queueOpen)
    }

    @Test fun resetAndRouteSerialization() {
        val n = Navigator()
        n.select(Tab.Library); n.push(Route.Folder("fd_1")); n.setDrawerOpen(true)
        n.reset()
        assertEquals(NavState(), n.state.value)
        val routes = listOf<Route>(Route.DailyMix("a", 2, "Band"), Route.TopSongs(2025, 1), Route.SeeAll(SeeAllKind.TopArtists), Route.Charts, Route.Genre("R&B/Soul"))
        for (r in routes) assertEquals(r, SlopifyJson.decodeFromString(Route.serializer(), SlopifyJson.encodeToString(Route.serializer(), r)))
    }
}
