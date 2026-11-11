package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.model.LyricJob
import com.lukasbaxter.slopify.android.core.stores.LyricJobEvent
import com.lukasbaxter.slopify.android.core.stores.LyricJobStage
import com.lukasbaxter.slopify.android.core.stores.LyricJobStore
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.milliseconds

@OptIn(ExperimentalCoroutinesApi::class)
class LyricJobStoreTest {
    private fun job(id: String, state: String, title: String? = "Song $id", ahead: Int? = null, step: String? = null, result: String? = null) =
        LyricJob(trackId = id, title = title, state = state, ahead = ahead, step = step, result = result)

    @Test fun stages() {
        assertEquals(LyricJobStage.Waiting(2), LyricJobStore.stage(job("a", "queued", ahead = 2)))
        assertEquals(LyricJobStage.Starting, LyricJobStore.stage(job("a", "queued", ahead = 0)))
        assertEquals(LyricJobStage.Step("align"), LyricJobStore.stage(job("a", "running", step = "align")))
        assertEquals(LyricJobStage.Starting, LyricJobStore.stage(job("a", "running")))
    }

    @Test fun absorbFinishesReportsAndBumpsRevision() = runTest {
        val store = LyricJobStore(backgroundScope)
        val events = mutableListOf<LyricJobEvent>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { store.events.collect { events += it } }
        store.absorb(listOf(job("a", "queued", ahead = 1), job("b", "running", step = "align")))
        assertEquals(listOf("a", "b"), store.order.value)
        // The running job leads the pill.
        assertEquals("Song b", store.pill.value?.title)
        assertEquals(LyricJobStage.Step("align"), store.pill.value?.stage)
        assertEquals(1, store.pill.value?.more)
        // A finished job we never saw is ignored; one we followed leaves and reports.
        store.absorb(listOf(job("zzz", "done"), job("b", "done", title = null, result = "Synced")))
        assertEquals(listOf("a"), store.order.value)
        assertEquals(LyricJobEvent.Finished("b", "Song b", "Synced", failed = false), events.single())
        assertEquals(1, store.revision.value["b"])
        assertTrue(store.isSyncing("a")); assertFalse(store.isSyncing("b"))
        store.absorb(listOf(job("a", "failed")))
        assertEquals(LyricJobEvent.Finished("a", "Song a", null, failed = true), events.last())
        assertNull(store.pill.value)
    }

    @Test fun syncStartsAndPollsUntilDone() = runTest {
        StubServer().use { s ->
            s.answers["/t1/sync"] = 200 to """{"trackId":"t1","title":"","state":"queued","ahead":0,"already":true}"""
            s.answers["/api/lyrics/sync"] = 200 to """{"jobs":[{"trackId":"t1","state":"done","result":"Synced"}]}"""
            val store = LyricJobStore(backgroundScope, interval = 10.milliseconds)
            val events = mutableListOf<LyricJobEvent>()
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { store.events.collect { events += it } }
            store.sync("t1", "Title", s.client())
            assertEquals("Title", store.job("t1")?.title)
            assertEquals(LyricJobEvent.AlreadySyncing("Title"), events.first())
            eventually("job finished") { !store.isSyncing("t1") }
            assertEquals(LyricJobEvent.Finished("t1", "Title", "Synced", failed = false), events.last())
            assertTrue(s.seen.any { it.requestUrl!!.queryParameter("ids") == "t1" })
        }
    }

    @Test fun syncFailureIsReported() = runTest {
        StubServer().use { s ->
            s.answers["/t1/sync"] = 429 to """{"error":"too many"}"""
            val store = LyricJobStore(backgroundScope)
            val events = mutableListOf<LyricJobEvent>()
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { store.events.collect { events += it } }
            store.sync("t1", "Title", s.client())
            assertEquals(LyricJobEvent.StartFailed("too many"), events.single())
            assertFalse(store.isSyncing("t1"))
        }
    }
}
