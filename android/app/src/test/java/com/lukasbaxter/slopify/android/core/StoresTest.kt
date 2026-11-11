@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.model.ItemKind
import com.lukasbaxter.slopify.android.core.stores.Connectivity
import com.lukasbaxter.slopify.android.core.stores.Likes
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

class LikesTest {
    @Test fun setRollsBackAndThrows() = runTest {
        StubServer().use { s ->
            s.answers["/api/likes/t1"] = 500 to """{"error":"disk full"}"""
            val likes = Likes(); likes.attach(s.client())
            try { likes.set("t1", liked = true); fail("should throw") } catch (e: Exception) { assertEquals("disk full", e.message) }
            assertFalse(likes.isLiked("t1"))
            likes.toggle("t1") // swallows
            assertFalse(likes.isLiked("t1"))
        }
    }

    @Test fun toggleThrowingAndLoaded() = runTest {
        StubServer().use { s ->
            s.answers["/api/likes/t1"] = 200 to """{"ok":true,"at":42}"""
            s.answers["/api/likes/albums"] = 200 to """{"items":[{"id":"al","name":"A","artist":"B"}]}"""
            s.answers["/api/likes/artists"] = 200 to """{"items":[]}"""
            s.answers["/api/likes"] = 200 to """{"at":{"t9":1}}"""
            val likes = Likes(); likes.attach(s.client())
            assertFalse(likes.state.value.loaded)
            likes.toggleThrowing("t1")
            assertEquals(42.0, likes.state.value.tracks["t1"])
            likes.refresh()
            assertTrue(likes.state.value.loaded)
            assertTrue(likes.isLiked("al")); assertTrue(likes.isLiked("t9"))
            likes.reset()
            assertFalse(likes.state.value.loaded); assertTrue(likes.state.value.tracks.isEmpty())
        }
    }

    @Test fun albumsArtistsAndRemote() = runTest {
        StubServer().use { s ->
            s.answers["/api/likes/al"] = 200 to """{"ok":true,"album":true}"""
            s.answers["/api/likes/ar"] = 200 to """{"ok":true,"artist":true}"""
            val likes = Likes(now = { 7.0 }); likes.attach(s.client())
            likes.set("al", ItemKind.Album, true)
            likes.set("ar", ItemKind.Artist, true)
            likes.set("al", ItemKind.Album, true) // no-op
            assertEquals(2, s.seen.size)
            likes.set("ar", ItemKind.Artist, false)
            assertEquals("DELETE", s.seen.last().method)
            assertEquals(setOf("al"), likes.state.value.albums); assertTrue(likes.state.value.artists.isEmpty())
            likes.remote("t2", true)
            assertEquals(7.0, likes.state.value.tracks["t2"])
            likes.remote("t2", false)
            assertNull(likes.state.value.tracks["t2"])
        }
    }

    @Test fun noApiIsOffline() = runTest {
        try { Likes().set("x", liked = true); fail() } catch (_: com.lukasbaxter.slopify.android.core.api.ApiError.Offline) {}
    }
}

class FindServerTest {
    @Test fun bothSchemesInParallelFirstGuessWins() = runTest {
        val start = testScheduler.currentTime
        val found = Account.findServer("music.example.com", 6.0) { _, _ -> delay(200); true }
        assertEquals("https://music.example.com", found)
        assertEquals("probes run in parallel", 200L, testScheduler.currentTime - start)
        assertEquals("http://music.example.com", Account.findServer("music.example.com", 6.0) { url, _ -> url.startsWith("http:") })
        assertNull(Account.findServer("music.example.com", 6.0) { _, _ -> false })
        assertNull(Account.findServer("ftp://x", 6.0) { _, _ -> true })
        assertEquals(6.0, Account.MAIN_PROBE_TIMEOUT, 0.0)
        assertEquals(3.0, Account.HOME_PROBE_TIMEOUT, 0.0)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectivityTest {
    @Test fun failureIsConfirmedBeforeGoingOffline() = runTest {
        val c = Connectivity(backgroundScope)
        c.retryInterval = 60.seconds
        var healthy = true
        val changes = mutableListOf<Boolean>()
        c.healthCheck = { healthy }
        c.onChange = { changes += it }
        c.note(false)
        runCurrent()
        assertFalse("the health check answered", c.offline.value)
        healthy = false
        c.note(false)
        runCurrent()
        assertTrue(c.offline.value)
        c.note(true)
        assertFalse(c.offline.value)
        assertEquals(listOf(true, false), changes)
    }

    @Test fun noPathIsOfflineAtOnceAndRetries() = runTest {
        val c = Connectivity(backgroundScope)
        c.retryInterval = 20.milliseconds
        var healthy = false
        var checks = 0
        c.healthCheck = { checks++; healthy }
        c.pathChanged(false)
        assertTrue(c.offline.value)
        advanceTimeBy(50); runCurrent()
        assertTrue(checks >= 2)
        assertTrue(c.offline.value)
        healthy = true
        advanceTimeBy(25); runCurrent()
        assertFalse("the 15 s retry (shortened here) ends it", c.offline.value)
    }

    @Test fun pathBackIsCheckedFirst() = runTest {
        val c = Connectivity(backgroundScope)
        c.retryInterval = 60.seconds
        c.healthCheck = { false }
        c.pathChanged(false)
        c.pathChanged(true)
        runCurrent()
        assertTrue("no answer yet: still offline", c.offline.value)
        c.healthCheck = { true }
        c.pathChanged(true)
        runCurrent()
        assertFalse(c.offline.value)
        c.reset()
        assertFalse(c.offline.value)
    }
}
