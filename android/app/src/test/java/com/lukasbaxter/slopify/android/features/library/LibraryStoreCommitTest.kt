package com.lukasbaxter.slopify.android.features.library

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.stores.LibraryStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Layout saves are optimistic and roll back when the server refuses (Sidebar.jsx `commit`). */
class LibraryStoreCommitTest {
    private val server = MockWebServer()
    private val revs = CopyOnWriteArrayList<String>()
    @Volatile private var putStatus = 200

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath ?: ""
                var status = 200
                var body = "{}"
                when {
                    path.endsWith("/api/library/layout") && request.method == "PUT" -> {
                        revs += request.getHeader("X-Slopify-Rev") ?: ""
                        status = putStatus
                        body = if (status == 200) """{"order":["p2","p1"],"folders":[]}""" else """{"error":"nope"}"""
                    }
                    path.endsWith("/api/library/layout") -> body = """{"order":["p1","p2"],"folders":[]}"""
                    path.endsWith("/api/playlists") -> body = """{"items":[
                        {"id":"p1","name":"One","userId":"u","created":1,"updated":1,"trackCount":0,"cover":null,"aiPrompt":null},
                        {"id":"p2","name":"Two","userId":"u","created":1,"updated":1,"trackCount":0,"cover":null,"aiPrompt":null}]}"""
                    path.endsWith("/api/likes/albums") || path.endsWith("/api/likes/artists") -> body = """{"items":[]}"""
                }
                return MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun CoroutineScope.makeStore(): LibraryStore {
        val api = ApiClient(server.url("/").toString().trimEnd('/'), "T")
        return LibraryStore(this).also { it.attach(api, "u") }
    }

    private suspend fun waitFor(cond: () -> Boolean) = withTimeout(5000) { while (!cond()) delay(10) }

    @Test fun refreshThenSavedLayoutWins() = runBlocking {
        putStatus = 200
        val store = makeStore()
        store.refresh()
        waitFor { store.state.value.layout != null }
        assertEquals(listOf("p1", "p2"), store.state.value.playlists.map { it.id })
        assertFalse(store.state.value.loading)
        val d = store.state.value.arrangement(emptyList()).draft(store.state.value.layout).copy(order = listOf("p2", "p1"))
        store.saveArrangement(d)
        assertEquals(listOf("p2", "p1"), store.state.value.layout?.order) // shown at once
        waitFor { revs.isNotEmpty() }
        assertTrue(revs[0].startsWith("r"))
        delay(50)
        assertEquals(listOf("p2", "p1"), store.state.value.layout?.order)
    }

    @Test fun refusedSaveRollsBack() = runBlocking {
        putStatus = 500
        val store = makeStore()
        store.refresh()
        waitFor { store.state.value.layout != null }
        val before = store.state.value.layout?.order
        val d = store.state.value.arrangement(emptyList()).draft(store.state.value.layout).copy(order = listOf("p2", "p1"))
        store.saveArrangement(d)
        assertEquals(listOf("p2", "p1"), store.state.value.layout?.order)
        waitFor { store.state.value.layout?.order == before }
        assertEquals(before, store.state.value.layout?.order)
        assertEquals(1, revs.size)
    }

    @Test fun createFolderShowsAtTopThenRenameAndDelete() = runBlocking {
        val store = makeStore()
        store.refresh()
        waitFor { store.state.value.layout != null }
        store.createFolder("Gym", store.state.value.arrangement(emptyList()), now = 36L)
        val made = store.state.value.layout!!
        assertEquals("fd_new10", made.order.first())
        assertEquals(listOf("Gym"), made.folders.map { it.name })
        val a = store.state.value.arrangement(emptyList())
        store.renameFolder("fd_new10", "Run", a)
        assertEquals("Run", store.state.value.layout?.folders?.first()?.name)
        store.deleteFolder("fd_new10", store.state.value.arrangement(emptyList()))
        assertTrue(store.state.value.layout?.folders.orEmpty().isEmpty())
    }
}
