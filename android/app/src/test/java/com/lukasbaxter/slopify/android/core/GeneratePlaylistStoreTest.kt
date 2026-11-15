package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.api.generatePlaylist
import com.lukasbaxter.slopify.android.core.api.job
import com.lukasbaxter.slopify.android.core.model.GenerateInfo
import com.lukasbaxter.slopify.android.core.model.GenerateResult
import com.lukasbaxter.slopify.android.core.model.ServerJob
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.stores.GenerateAvailability
import com.lukasbaxter.slopify.android.core.stores.GenerateEvent
import com.lukasbaxter.slopify.android.core.stores.GeneratePlaylistStore
import com.lukasbaxter.slopify.android.core.stores.GenerateRegenerate
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import kotlin.time.Duration.Companion.milliseconds

// Shapes from API.md §14.2 / §18.4 and server ai.ts (`job.info`).
private const val INFO = """{"stages":[{"key":"plan","label":"Reading the request","state":"done","detail":null},{"key":"find","label":"Finding songs","state":"active","detail":"by sound"},{"key":"pick","label":"Picking","state":"pending","detail":null}],"leftMs":42000,"at":1762800000000,"title":"Rainy day","vibe":"Soft and slow","found":180,"foundNew":150}"""
private const val RESULT = """{"playlistId":"pl_9","name":"Rainy day","regenerated":false,"count":25,"poolSize":180,"requested":2,"missing":0,"known":5,"tracks":[{"id":"t1","known":true}],"by":"brain"}"""
private fun jobJson(state: String, extra: String = "") = """{"id":"a1b2c3d4e5f60718","kind":"ai-playlist","state":"$state","step":"Starting","progress":0.4,"info":null,"result":null,"error":null,"created":1762800000000,"finished":null$extra}"""
private val QUEUED = jobJson("queued")
private val RUNNING = """{"id":"a1b2c3d4e5f60718","kind":"ai-playlist","state":"running","step":"Finding songs","progress":0.5,"info":$INFO,"result":null,"error":null}"""
private val DONE = """{"id":"a1b2c3d4e5f60718","kind":"ai-playlist","state":"done","step":"Done","progress":1,"info":$INFO,"result":$RESULT,"error":null}"""
private val FAILED = """{"id":"a1b2c3d4e5f60718","kind":"ai-playlist","state":"error","step":"Finding songs","progress":0.5,"info":null,"result":null,"error":"the brain is busy"}"""

@OptIn(ExperimentalCoroutinesApi::class)
class GeneratePlaylistStoreTest {
    private fun decode(s: String) = SlopifyJson.decodeFromString(ServerJob.serializer(), s)

    @Test fun jobAndItsShapesDecode() {
        val j = decode(RUNNING)
        assertEquals("a1b2c3d4e5f60718", j.id)
        assertTrue(j.active); assertTrue(decode(QUEUED).active)
        assertFalse(decode(DONE).active); assertFalse(decode(FAILED).active)
        val i = GenerateInfo.read(j.info)!!
        assertEquals(listOf("plan", "find", "pick"), i.stages!!.map { it.key })
        assertEquals(listOf("done", "active", "pending"), i.stages!!.map { it.state })
        assertEquals("by sound", i.stages!![1].detail)
        assertNull(i.stages!![0].detail)
        assertEquals(42000.0, i.leftMs!!, 0.0)
        assertEquals("Rainy day", i.title); assertEquals("Soft and slow", i.vibe)
        assertEquals(180, i.found); assertEquals(150, i.foundNew)
        assertNull(GenerateInfo.read(decode(QUEUED).info))
        assertEquals(GenerateResult("pl_9", "Rainy day", false, 25, 2), GenerateResult.read(decode(DONE).result))
        assertNull(GenerateResult.read(decode(QUEUED).result))
        assertNull(GenerateResult.read(SlopifyJson.parseToJsonElement("""{"name":"no id"}""")))
    }

    @Test fun generateSendsThePromptAndThePlaylistOnlyWhenRegenerating() = runTest {
        StubServer().use { s ->
            s.answers["/api/ai/playlists"] = 200 to QUEUED
            val api = s.client()
            assertEquals("queued", api.generatePlaylist("rainy day").state)
            api.generatePlaylist("rainy day", "pl_9")
            assertEquals(listOf("POST", "POST"), s.seen.map { it.method })
            assertEquals("/api/ai/playlists", s.seen[0].requestUrl!!.encodedPath)
            assertEquals(mapOf("prompt" to JsonPrimitive("rainy day")), SlopifyJson.parseToJsonElement(s.seen[0].body.readUtf8()).jsonObject)
            assertEquals(
                mapOf("prompt" to JsonPrimitive("rainy day"), "playlistId" to JsonPrimitive("pl_9")),
                SlopifyJson.parseToJsonElement(s.seen[1].body.readUtf8()).jsonObject,
            )
        }
    }

    @Test fun waitJobPollsUntilTheJobEndsAndReportsEveryState() = runTest {
        StubServer().use { s ->
            val path = "/api/jobs/a1b2c3d4e5f60718"
            s.answers[path] = 200 to RUNNING
            val states = mutableListOf<String>()
            val result = GeneratePlaylistStore.waitJob(s.client(), decode(QUEUED), 10.milliseconds) { j ->
                states += j.state
                // Two polls say running, the third says done.
                if (states.size == 3) synchronized(s.answers) { s.answers[path] = 200 to DONE }
            }
            assertEquals(listOf("queued", "running", "running", "done"), states)
            assertEquals(3, s.seen.size)
            assertTrue(s.seen.all { it.method == "GET" && it.requestUrl!!.encodedPath == path })
            assertEquals("pl_9", GenerateResult.read(result)?.playlistId)
        }
    }

    @Test fun waitJobDoesNotPollAFinishedJobAndThrowsItsError() = runTest {
        StubServer().use { s ->
            val seen = mutableListOf<String>()
            try {
                GeneratePlaylistStore.waitJob(s.client(), decode(FAILED), 10.milliseconds) { seen += it.state }
                fail("an errored job must throw")
            } catch (e: IllegalStateException) {
                assertEquals("the brain is busy", e.message)
            }
            assertEquals(listOf("error"), seen)
            assertTrue(s.seen.isEmpty())
        }
    }

    @Test fun jobRetriesAServerErrorButNotAMissingJob() = runTest {
        StubServer().use { s ->
            s.answers["/api/jobs/x"] = 502 to """{"error":"bad gateway"}"""
            try { s.client().job("x", retries = 2, retryDelayMs = 1); fail("must throw") } catch (e: ApiError.Http) { assertEquals(502, e.status) }
            assertEquals(3, s.seen.size)
            s.answers["/api/jobs/gone"] = 404 to """{"error":"no such job"}"""
            try { s.client().job("gone", retries = 2, retryDelayMs = 1); fail("must throw") } catch (e: ApiError.Http) { assertEquals("no such job", e.message) }
            assertEquals(4, s.seen.size)
        }
    }

    @Test fun availabilityFollowsTheStatusAnswer() = runTest {
        StubServer().use { s ->
            s.answers["/api/ai/status"] = 200 to """{"ok":true,"by":"brain"}"""
            assertEquals(GenerateAvailability.Ok, GeneratePlaylistStore.availability(s.client()))
            s.answers["/api/ai/status"] = 200 to """{"ok":false,"reason":"The brain is off"}"""
            assertEquals(GenerateAvailability.Off("The brain is off"), GeneratePlaylistStore.availability(s.client()))
            s.answers["/api/ai/status"] = 200 to """{"ok":false}"""
            assertEquals(GenerateAvailability.Off(null), GeneratePlaylistStore.availability(s.client()))
            s.answers["/api/ai/status"] = 500 to """{"error":"boom"}"""
            assertEquals(GenerateAvailability.Unreachable, GeneratePlaylistStore.availability(s.client()))
        }
    }

    @Test fun doneWhileOpenClosesTheDialogAndReports() = runTest {
        StubServer().use { s ->
            s.answers["/api/ai/status"] = 200 to """{"ok":true,"by":"brain"}"""
            s.answers["/api/ai/playlists"] = 200 to QUEUED
            s.answers["/api/jobs/a1b2c3d4e5f60718"] = 200 to RUNNING
            val store = GeneratePlaylistStore(backgroundScope, interval = 10.milliseconds, now = { 777L })
            val events = mutableListOf<GenerateEvent>()
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { store.events.collect { events += it } }
            val session = store.open(s.client(), GenerateRegenerate("pl_9", "old request"))
            assertSame(session, store.session.value)
            assertEquals(GenerateAvailability.Loading, session.availability.value)
            eventually("status") { session.availability.value == GenerateAvailability.Ok }
            store.submit(session, "   ", s.client()) // blank: nothing starts
            assertNull(session.busy.value)
            store.submit(session, "  rainy day ", s.client())
            assertEquals(777L, session.busy.value?.gotMs) // busy at once, "Starting"
            assertNull(session.busy.value?.step)
            eventually("progress shown") { session.busy.value?.info != null }
            assertEquals("Finding songs", session.busy.value?.step)
            assertEquals(0.5, session.busy.value?.progress!!, 0.0)
            assertEquals(42000.0, session.busy.value?.info?.leftMs!!, 0.0)
            store.submit(session, "again", s.client()) // busy: ignored
            s.answers["/api/jobs/a1b2c3d4e5f60718"] = 200 to DONE
            eventually("done") { events.isNotEmpty() }
            assertEquals(GenerateEvent.Done(GenerateResult("pl_9", "Rainy day", false, 25, 2), hidden = false), events.single())
            assertNull(store.session.value)
            val posts = s.seen.filter { it.method == "POST" }
            assertEquals(1, posts.size)
            assertEquals(
                mapOf("prompt" to JsonPrimitive("rainy day"), "playlistId" to JsonPrimitive("pl_9")),
                SlopifyJson.parseToJsonElement(posts[0].body.readUtf8()).jsonObject,
            )
        }
    }

    @Test fun hideKeepsTheJobRunningAndAnnouncesItHidden() = runTest {
        StubServer().use { s ->
            s.answers["/api/ai/playlists"] = 200 to QUEUED
            s.answers["/api/jobs/a1b2c3d4e5f60718"] = 200 to RUNNING
            val store = GeneratePlaylistStore(backgroundScope, interval = 10.milliseconds)
            val events = mutableListOf<GenerateEvent>()
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { store.events.collect { events += it } }
            val session = store.open(s.client())
            store.submit(session, "rainy day", s.client())
            eventually("running") { session.busy.value?.info != null }
            store.close() // Hide
            assertNull(store.session.value)
            val pollsAtHide = s.seen.count { it.method == "GET" && it.requestUrl!!.encodedPath.startsWith("/api/jobs/") }
            eventually("still polled after Hide") { s.seen.count { it.method == "GET" && it.requestUrl!!.encodedPath.startsWith("/api/jobs/") } > pollsAtHide + 1 }
            assertTrue(events.isEmpty())
            // A dialog opened meanwhile is not closed by the hidden job's end.
            val second = store.open(s.client())
            s.answers["/api/jobs/a1b2c3d4e5f60718"] = 200 to DONE
            eventually("done") { events.isNotEmpty() }
            assertEquals(GenerateEvent.Done(GenerateResult("pl_9", "Rainy day", false, 25, 2), hidden = true), events.single())
            assertSame(second, store.session.value)
        }
    }

    @Test fun failureShowsInTheOpenDialogAndCanBeRetried() = runTest {
        StubServer().use { s ->
            s.answers["/api/ai/playlists"] = 503 to """{"error":"the brain is off"}"""
            val store = GeneratePlaylistStore(backgroundScope, interval = 10.milliseconds)
            val events = mutableListOf<GenerateEvent>()
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { store.events.collect { events += it } }
            val session = store.open(s.client())
            store.submit(session, "rainy day", s.client())
            eventually("error") { session.error.value != null }
            assertEquals("the brain is off", session.error.value)
            assertNull(session.busy.value)
            assertSame(session, store.session.value)
            assertTrue(events.isEmpty())
            // Retry: the error clears, the job's own failure shows the same way.
            s.answers["/api/ai/playlists"] = 200 to QUEUED
            s.answers["/api/jobs/a1b2c3d4e5f60718"] = 200 to FAILED
            store.submit(session, "rainy day", s.client())
            assertNull(session.error.value)
            eventually("job error") { session.error.value != null }
            assertEquals("the brain is busy", session.error.value)
            assertTrue(events.isEmpty())
        }
    }

    @Test fun failureAfterHideIsReported() = runTest {
        StubServer().use { s ->
            s.answers["/api/ai/playlists"] = 200 to QUEUED
            s.answers["/api/jobs/a1b2c3d4e5f60718"] = 200 to RUNNING
            val store = GeneratePlaylistStore(backgroundScope, interval = 10.milliseconds)
            val events = mutableListOf<GenerateEvent>()
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { store.events.collect { events += it } }
            val session = store.open(s.client())
            store.submit(session, "rainy day", s.client())
            eventually("running") { session.busy.value?.info != null }
            store.close()
            s.answers["/api/jobs/a1b2c3d4e5f60718"] = 200 to FAILED
            eventually("failed") { events.isNotEmpty() }
            assertEquals(GenerateEvent.Failed("the brain is busy"), events.single())
        }
    }
}
