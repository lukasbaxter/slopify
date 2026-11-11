package com.lukasbaxter.slopify.android.features.account

import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.model.DownloadScope
import com.lukasbaxter.slopify.android.core.model.DownloadsPage
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.Track
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

internal class AccountDownloadsFakeSource : AccountDownloadsSource {
    val answers = HashMap<DownloadScope, DownloadsPage>()
    var failRetry: Exception? = null
    val retried = ArrayList<Int>()
    val calls = ArrayList<DownloadScope>()
    /** When set, the next `downloads` waits for it before answering. */
    var gate: CompletableDeferred<Unit>? = null

    override suspend fun downloads(scope: DownloadScope): DownloadsPage {
        calls += scope
        gate?.let { gate = null; it.await() }
        return answers[scope] ?: throw ApiError.Http(503, "lidarr is not configured")
    }

    override suspend fun retry(id: Int) {
        failRetry?.let { throw it }
        retried += id
    }

    override suspend fun albumTracks(albumId: String): List<Track> = emptyList()
}

private fun item(id: Int, title: String = "T", state: String) = DownloadsPage.Item(id = id, title = title, state = state)

class AccountDownloadsLogicTest {
    private val now = 1_762_800_000_000.0

    // JSON from docs/API.md §18.2.
    @Test fun decodes() {
        val json = """
        {"scope":"mine","items":[{"id":123,"albumId":"mbid","artist":"A","title":"T","type":"Album","year":"2020","image":null,
        "state":"downloading","total":12,"done":4,"queuePos":null,"requested":1762800000000,"started":null,"progressAt":1762800000000,"finished":null,
        "reason":null,"via":"soulseek","detail":null,"libraryAlbumId":null,"source":"request","note":null,"mine":true,
        "search":{"at":1762800000000,"results":3,"outcome":"nomatch"},"failedImport":false}],
        "counts":{"downloading":1},"stuckAfterMs":86400000,"watcher":null,"now":1762800000000}
        """
        val d = SlopifyJson.decodeFromString(DownloadsPage.reader, json)
        assertEquals(1, d.items.size)
        assertEquals(4, d.items[0].done)
        assertEquals("nomatch", d.items[0].search?.outcome)
        assertNull(d.watcher)
        assertEquals(86_400_000.0, d.stuckAfterMs!!, 0.0)
        val y = SlopifyJson.decodeFromString(DownloadsPage.reader, """{"items":[{"id":1,"title":"x","state":"done","year":1999}]}""")
        assertEquals("1999", y.items[0].year)
    }

    @Test fun timeWords() {
        assertEquals("", AccountDownloadsLogic.ago(null, now))
        assertEquals("just now", AccountDownloadsLogic.ago(now - 30_000, now))
        assertEquals("5 min ago", AccountDownloadsLogic.ago(now - 5 * 60_000, now))
        assertEquals("3 h ago", AccountDownloadsLogic.ago(now - 3 * 3_600_000, now))
        assertEquals("1 day ago", AccountDownloadsLogic.ago(now - 26 * 3_600_000, now))
        assertEquals("3 days ago", AccountDownloadsLogic.ago(now - 72 * 3_600_000, now))
        assertEquals("1 min", AccountDownloadsLogic.duration(10_000.0))
        assertEquals("24 h", AccountDownloadsLogic.duration(86_400_000.0))
        assertEquals("any moment now", AccountDownloadsLogic.inTime(now + 3000, now))
        assertEquals("in 40 s", AccountDownloadsLogic.inTime(now + 40_000, now))
        assertEquals("in 10 min", AccountDownloadsLogic.inTime(now + 600_000, now))
        assertEquals("lidarr is not configured", AccountDownloadsLogic.cleanError("503: lidarr is not configured"))
    }

    @Test fun summaryAndSections() {
        val items = listOf(item(1, "a", "done"), item(2, "b", "downloading"), item(3, "c", "done"), item(4, "d", "weird"))
        assertEquals(listOf("1 downloading", "2 done"), AccountDownloadsLogic.summary(items).map { it.second })
        assertEquals(30, AccountDownloadsLogic.shown((0 until 40).map { item(it, state = "failed") }, "failed").size)
        assertEquals(40, AccountDownloadsLogic.shown((0 until 40).map { item(it, state = "queued") }, "queued").size)
    }

    @Test fun statusLines() {
        val w = DownloadsPage.Watcher(lastCheck = now - 120_000, next = now + 40_000, checking = false, perCheck = 5, wanted = 12)
        assertEquals(
            "Soulseek downloader: last checked 2 min ago • next check in 40 s • 12 albums wanted, 5 searched per check",
            AccountDownloadsLogic.watcherLine(w, now),
        )
        assertNull(AccountDownloadsLogic.watcherLine(null, now))

        val dl = DownloadsPage.Item(id = 1, title = "T", state = "downloading", total = 12, done = 4, started = now - 300_000)
        assertEquals("4 of 12 songs • started 5 min ago", AccountDownloadsLogic.statusLine(dl, null, now).text)
        assertEquals(0.33, AccountDownloadsLogic.progress(dl)!!, 0.001)
        val torrent = DownloadsPage.Item(id = 1, title = "T", state = "downloading", total = 0, via = "torrent", detail = "40%")
        assertEquals("Torrent • 40%", AccountDownloadsLogic.statusLine(torrent, null, now).text)
        assertEquals(0.03, AccountDownloadsLogic.progress(torrent)!!, 1e-9)

        val queued = DownloadsPage.Item(id = 2, title = "T", state = "queued", search = DownloadsPage.Search(at = now - 60_000, results = 1, outcome = "nomatch"))
        assertEquals(
            "Searched Soulseek 1 min ago: 1 result, none a complete match for this release • next try in 40 s",
            AccountDownloadsLogic.statusLine(queued, w, now).text,
        )
        val matched = DownloadsPage.Item(id = 2, title = "T", state = "queued", search = DownloadsPage.Search(at = now, outcome = "matched"))
        assertEquals("Found on Soulseek just now, the download is starting", AccountDownloadsLogic.statusLine(matched, w, now).text)
        val fresh = DownloadsPage.Item(id = 3, title = "T", state = "queued", requested = now - 120_000)
        assertEquals("Waiting for the downloader to pick it up • requested 2 min ago", AccountDownloadsLogic.statusLine(fresh, null, now).text)
        assertEquals(
            "Not searched yet • first search at the next check, in 40 s (12 albums wait, 5 are searched per check, so it can take a few)",
            AccountDownloadsLogic.statusLine(fresh, w, now).text,
        )
        assertNull(AccountDownloadsLogic.progress(fresh))

        val stuck = DownloadsPage.Item(id = 4, title = "T", state = "stuck", total = 10, done = 2, progressAt = now - 2 * 3_600_000)
        val st = AccountDownloadsLogic.statusLine(stuck, null, now)
        assertEquals("No progress for 2 h • 2 of 10 songs", st.text)
        assertTrue(st.warn)
        assertEquals(AccountDownloadsLogic.Action.Retry, AccountDownloadsLogic.action(stuck))

        val failed = DownloadsPage.Item(id = 5, title = "T", state = "failed", finished = now - 600_000)
        assertEquals("Failed • 10 min ago", AccountDownloadsLogic.statusLine(failed, null, now).text)

        val done = DownloadsPage.Item(id = 6, title = "T", state = "done", done = 1, libraryAlbumId = "al")
        assertEquals("1 song added", AccountDownloadsLogic.statusLine(done, null, now).text)
        assertEquals(AccountDownloadsLogic.Action.Play, AccountDownloadsLogic.action(done))
        assertEquals(1.0, AccountDownloadsLogic.progress(done)!!, 0.0)
        val lost = DownloadsPage.Item(id = 7, title = "T", state = "done", done = 3)
        assertTrue(AccountDownloadsLogic.statusLine(lost, null, now).warn)
        assertNull(AccountDownloadsLogic.action(lost))
        assertEquals("A • Album • 2020", AccountDownloadsLogic.meta(DownloadsPage.Item(id = 8, title = "T", artist = "A", type = "Album", year = "2020", state = "done")))
    }
}

class AccountDownloadsModelTest {
    @Before fun reset() = AccountDownloadsModel.resetKept()

    @Test fun loadsKeepsAndReportsErrors() = runTest {
        val src = AccountDownloadsFakeSource()
        src.answers[DownloadScope.Mine] = DownloadsPage(listOf(item(1, "A", "queued")))
        val m = AccountDownloadsModel(src)
        assertNull(m.state.value.data)
        m.load()
        assertEquals(1, m.state.value.data?.items?.size)
        m.setScope(DownloadScope.All)
        assertNull(m.state.value.data)
        m.load()
        assertEquals("lidarr is not configured", m.state.value.error)
        m.setScope(DownloadScope.Mine)
        assertEquals("the last answer for a scope shows at once", 1, m.state.value.data?.items?.size)
        assertNull(m.state.value.error)
    }

    @Test fun answerForALeftScopeIsDropped() = runTest {
        val src = AccountDownloadsFakeSource()
        src.answers[DownloadScope.Mine] = DownloadsPage(listOf(item(1, "mine", "queued")))
        src.answers[DownloadScope.All] = DownloadsPage(listOf(item(2, "all", "queued"), item(3, "b", "done")))
        val m = AccountDownloadsModel(src)
        val gate = CompletableDeferred<Unit>()
        src.gate = gate
        val slow = launch { m.load() }
        while (src.calls.isEmpty()) yield()
        assertEquals(listOf(DownloadScope.Mine), src.calls)
        m.setScope(DownloadScope.All)
        m.load()
        assertEquals(2, m.state.value.data?.items?.size)
        gate.complete(Unit)
        slow.join()
        assertEquals("the slow `mine` answer must not render under `all`", 2, m.state.value.data?.items?.size)
        assertFalse(m.state.value.data?.items?.any { it.title == "mine" } ?: true)
    }

    @Test fun retry() = runTest {
        val src = AccountDownloadsFakeSource()
        src.answers[DownloadScope.Mine] = DownloadsPage(emptyList())
        val m = AccountDownloadsModel(src)
        val it = item(9, "Kid A", "failed")
        assertEquals("Kid A is back in line", m.retry(it))
        assertEquals(listOf(9), src.retried)
        assertEquals("reloads after a retry", listOf(DownloadScope.Mine), src.calls)
        assertNull(m.state.value.retrying)
        src.failRetry = ApiError.Http(409, "not failed")
        assertEquals("Could not retry: not failed", m.retry(it))
    }
}
