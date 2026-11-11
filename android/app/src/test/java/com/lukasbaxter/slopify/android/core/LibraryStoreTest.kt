package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.model.LibraryLayout
import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.stores.LibraryAction
import com.lukasbaxter.slopify.android.core.stores.LibraryEvent
import com.lukasbaxter.slopify.android.core.stores.LibraryStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class LibraryStoreTest {
    private val playlists = """{"items":[{"id":"p1","name":"Mix","trackCount":2}]}"""
    private val albums = """{"items":[{"id":"al","name":"A","artist":"B"}]}"""
    private val artists = """{"items":[{"id":"ar","name":"Band"}]}"""
    private val layout = """{"order":["p1","fd_1"],"folders":[{"id":"fd_1","name":"F","items":["al"]}]}"""

    private fun StubServer.library() {
        answers["/api/playlists"] = 200 to playlists
        answers["/api/likes/albums"] = 200 to albums
        answers["/api/likes/artists"] = 200 to artists
        answers["/api/library/layout"] = 200 to layout
    }

    private fun <T> withStore(dir: File? = null, block: suspend (LibraryStore, StubServer) -> T) = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            StubServer().use { s -> block(LibraryStore(scope, dir), s) }
        } finally {
            scope.cancel()
        }
    }

    private suspend fun waitFor(what: () -> Boolean) = withTimeout(5000) { while (!what()) delay(10) }

    @Test fun refreshFillsEverythingAndLayout() = withStore { store, s ->
        s.library()
        store.attach(s.client(), "u1")
        assertTrue(store.state.value.loading)
        store.refresh()
        val st = store.state.value
        assertFalse(st.loading)
        assertEquals(listOf("p1"), st.playlists.map { it.id })
        assertEquals("al", st.albums.single().id)
        assertEquals("ar", st.artists.single().id)
        waitFor { store.state.value.layout != null }
        assertEquals(listOf("p1", "fd_1"), store.state.value.layout?.order)
    }

    @Test fun commitSendsRevAndRollsBackWithAnEvent() = withStore { store, s ->
        s.library()
        store.attach(s.client(), "u1")
        store.refresh()
        waitFor { store.state.value.layout != null }
        val before = store.state.value.layout
        s.answers.remove("/api/library/layout")
        s.answers["/api/library/layout"] = 409 to """{"error":"stale"}"""
        val next = LibraryLayout(listOf("fd_1", "p1"), before!!.folders)
        val events = mutableListOf<LibraryEvent>()
        val job = collect(store, events)
        store.saveLayout(next, next.order, mapOf("fd_1" to listOf("al")))
        assertEquals("shown at once", next, store.state.value.layout)
        waitFor { synchronized(events) { events.isNotEmpty() } }
        assertEquals(LibraryEvent.Failed(LibraryAction.SaveLibrary, "stale"), events.first())
        job.cancel()
        waitFor { store.state.value.layout == before }
        val put = s.seen.last { it.method == "PUT" }
        assertTrue(put.getHeader("X-Slopify-Rev")!!.startsWith("r"))
    }

    @Test fun ownRevIsSkippedOthersRefresh() = withStore { store, s ->
        s.library()
        store.attach(s.client(), "u1")
        store.remoteChange(null)
        waitFor { !store.state.value.loading }
        val n = s.seen.count { it.path!!.endsWith("/api/playlists") }
        store.remoteChange("r-not-ours")
        waitFor { s.seen.count { it.path!!.endsWith("/api/playlists") } > n }
    }

    @Test fun addBumpsRevisionAndCreateReports() = withStore { store, s ->
        s.library()
        s.answers["/api/playlists/p1/tracks"] = 200 to "{}"
        store.attach(s.client(), "u1")
        var changed = 0
        store.onLibraryChanged = { changed++ }
        val events = mutableListOf<LibraryEvent>()
        val job = collect(store, events)
        store.add(listOf("t1"), Playlist("p1", "Mix"))
        assertEquals(1, store.state.value.revision["p1"])
        s.answers.remove("/api/playlists")
        s.answers["/api/playlists"] = 200 to """{"id":"p2","name":"New"}"""
        val c = store.createPlaylist("New")
        assertEquals("p2", c?.id)
        assertEquals(1, changed)
        waitFor { synchronized(events) { events.size >= 2 } }
        assertEquals(listOf(LibraryEvent.Added("Mix"), LibraryEvent.Created("New")), events.take(2))
        job.cancel()
    }

    @Test fun localCopyPerUserAndSignOutClears() {
        val dir = Files.createTempDirectory("lib").toFile()
        try {
            withStore(dir) { store, s ->
                s.library()
                store.attach(s.client(), "u1")
                store.refresh()
                waitFor { File(dir, "library-u1.json").exists() }
                store.attach(s.client(), null)
                assertTrue(store.state.value.playlists.isEmpty())
                assertNull(store.state.value.layout)
            }
            withStore(dir) { store, s ->
                // Nothing fetched yet: the copy paints the list.
                store.attach(s.client(), "u1")
                waitFor { store.state.value.playlists.isNotEmpty() }
                assertEquals("p1", store.state.value.playlists.single().id)
                store.attach(s.client(), "u2")
                assertTrue("another user starts empty", store.state.value.playlists.isEmpty())
            }
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun newRevShape() {
        val r = LibraryStore.newRev(36L * 36)
        assertTrue(r.startsWith("r100"))
        assertEquals(10, r.length)
    }
}

/** Subscribed before it returns, so no event is missed. */
private fun collect(store: LibraryStore, into: MutableList<LibraryEvent>) =
    CoroutineScope(Dispatchers.Default).launch(start = CoroutineStart.UNDISPATCHED) { store.events.collect { synchronized(into) { into += it } } }
