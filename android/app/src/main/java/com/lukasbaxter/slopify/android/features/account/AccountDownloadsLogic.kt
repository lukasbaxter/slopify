package com.lukasbaxter.slopify.android.features.account

import com.lukasbaxter.slopify.android.core.model.DownloadsPage
import com.lukasbaxter.slopify.android.design.L
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Words and grouping of the Downloads page (web components/Downloads.jsx, UI.md 5.9; ios
 * AccountDownloadsLogic.swift). Times are server milliseconds; everything takes `now` (ms).
 */
internal object AccountDownloadsLogic {
    /** Downloads.jsx `SECTIONS`: state, heading key, summary key. */
    data class Section(val state: String, val heading: String, val count: String)

    val sections = listOf(
        Section("downloading", "Downloading", "{n} downloading"),
        Section("adding", "Adding to library", "{n} adding to library"),
        Section("stuck", "Stuck", "{n} stuck"),
        Section("queued", "Waiting in line", "{n} waiting in line"),
        Section("failed", "Failed", "{n} failed"),
        Section("done", "Done", "{n} done"),
    )

    /** `Done` and `Failed` show at most 30 rows. */
    fun shown(items: List<DownloadsPage.Item>, state: String): List<DownloadsPage.Item> {
        val list = items.filter { it.state == state }
        return if (state == "done" || state == "failed") list.take(30) else list
    }

    /** Summary entries for non-empty states: (state, text). */
    fun summary(items: List<DownloadsPage.Item>): List<Pair<String, String>> = sections.mapNotNull { s ->
        val n = items.count { it.state == s.state }
        if (n > 0) s.state to L(s.count, "n" to n) else null
    }

    private val leadingCode = Regex("^\\d+: ")

    /** Drop a leading `NNN: ` from an error message. */
    fun cleanError(s: String): String = s.replaceFirst(leadingCode, "")

    // time words

    fun ago(at: Double?, now: Double): String {
        if (at == null || at <= 0) return ""
        val s = max(0, ((now - at) / 1000).roundToInt())
        if (s < 60) return L("just now")
        val m = (s / 60.0).roundToInt()
        if (m < 60) return L("{n} min ago", "n" to m)
        val h = (m / 60.0).roundToInt()
        if (h < 24) return L("{n} h ago", "n" to h)
        val d = (h / 24.0).roundToInt()
        return if (d == 1) L("1 day ago") else L("{n} days ago", "n" to d)
    }

    fun duration(ms: Double): String {
        val m = max(1, (ms / 60000).roundToInt())
        return if (m < 60) L("{n} min", "n" to m) else L("{n} h", "n" to (m / 60.0).roundToInt())
    }

    fun inTime(at: Double, now: Double): String {
        val s = ((at - now) / 1000).roundToInt()
        if (s <= 5) return L("any moment now")
        if (s < 90) return L("in {n} s", "n" to s)
        return L("in {time}", "time" to duration(s * 1000.0))
    }

    // lines

    fun watcherLine(w: DownloadsPage.Watcher?, now: Double): String? {
        if (w == null) return null
        val whenText = if (w.checking == true) L("checking the wanted list now") else {
            val parts = ArrayList<String>()
            w.lastCheck?.takeIf { it > 0 }?.let { parts += L("last checked {when}", "when" to ago(it, now)) }
            w.next?.takeIf { it > 0 }?.let { parts += L("next check {when}", "when" to inTime(it, now)) }
            parts.joinToString(" • ")
        }
        var load = ""
        val wanted = w.wanted
        if (wanted != null) {
            val per = w.perCheck
            load = when {
                per != null && per > 0 && wanted > per -> L("{n} albums wanted, {per} searched per check", "n" to wanted, "per" to per)
                wanted == 1 -> L("1 album wanted")
                else -> L("{n} albums wanted", "n" to wanted)
            }
        }
        return L("Soulseek downloader: {status}", "status" to listOf(whenText, load).filter { it.isNotEmpty() }.joinToString(" • "))
    }

    /** Downloads.jsx `waitingText`. */
    fun waitingText(d: DownloadsPage.Item, watcher: DownloadsPage.Watcher?, now: Double): String {
        var next = ""
        if (watcher != null) {
            val n = watcher.next
            if (watcher.checking == true) next = L("checking now")
            else if (n != null && n > 0) next = L("next try {when}", "when" to inTime(n, now))
        }
        val s = d.search
        if (s != null) {
            if (s.outcome == "searching") return L("Searching Soulseek for it now…")
            val w = ago(s.at, now)
            val what = when (s.outcome) {
                "noresults" -> L("Searched Soulseek {when}: nobody is sharing it", "when" to w)
                "nomatch" -> if (s.results == 1) L("Searched Soulseek {when}: 1 result, none a complete match for this release", "when" to w)
                    else L("Searched Soulseek {when}: {n} results, none a complete match for this release", "when" to w, "n" to (s.results ?: 0))
                "refused" -> L("Found on Soulseek {when}, but nobody sharing it would send it (offline or their queue is full)", "when" to w)
                "matched" -> L("Found on Soulseek {when}, the download is starting", "when" to w)
                else -> L("Searched Soulseek {when}", "when" to w)
            }
            return if (s.outcome == "matched") what else listOf(what, next).filter { it.isNotEmpty() }.joinToString(" • ")
        }
        if (watcher == null) {
            val req = d.requested?.let { " • " + L("requested {when}", "when" to ago(it, now)) } ?: ""
            return L("Waiting for the downloader to pick it up") + req
        }
        val n = watcher.next
        val whenText = when {
            watcher.checking == true -> L("running now")
            n != null && n > 0 -> inTime(n, now)
            else -> L("soon")
        }
        val per = watcher.perCheck
        val wanted = watcher.wanted
        if (per != null && per > 0 && wanted != null && wanted > per) {
            return L(
                "Not searched yet • first search at the next check, {when} ({n} albums wait, {per} are searched per check, so it can take a few)",
                "when" to whenText, "n" to wanted, "per" to per,
            )
        }
        return L("Not searched yet • first search at the next check, {when}", "when" to whenText)
    }

    /** `{done} of {total} songs` / `{done} of 1 song`. */
    fun ofSongs(d: DownloadsPage.Item): String =
        if (d.total == 1) L("{done} of 1 song", "done" to d.done) else L("{done} of {total} songs", "done" to d.done, "total" to d.total)

    data class Status(val text: String, val warn: Boolean)

    /** The status line text and whether it is a warning (red). */
    fun statusLine(d: DownloadsPage.Item, watcher: DownloadsPage.Watcher?, now: Double): Status = when (d.state) {
        "downloading" -> if (d.via == "torrent") Status(L("Torrent") + " • " + (d.detail ?: ""), false) else {
            val started = d.started?.let { " • " + L("started {when}", "when" to ago(it, now)) } ?: ""
            Status(ofSongs(d) + started, false)
        }
        "stuck" -> {
            val head = when {
                d.search != null -> waitingText(d, watcher, now)
                !d.reason.isNullOrEmpty() -> d.reason
                else -> L("No progress for {time}", "time" to duration(now - (d.progressAt ?: d.started ?: now)))
            }
            Status(head + " • " + ofSongs(d), true)
        }
        "queued" -> Status(waitingText(d, watcher, now), false)
        "failed" -> {
            val r = d.reason?.takeIf { it.isNotEmpty() } ?: L("Failed")
            Status(r + (d.finished?.let { " • " + ago(it, now) } ?: ""), true)
        }
        "adding" -> Status(L("Downloaded • adding to your library…"), false)
        "done" -> {
            val fin = d.finished?.let { " • " + ago(it, now) } ?: ""
            if (d.libraryAlbumId != null) Status((if (d.done == 1) L("1 song added") else L("{n} songs added", "n" to d.done)) + fin, false)
            else Status(L("Downloaded, but not found in your library") + fin, true)
        }
        else -> Status("", false)
    }

    /** Progress bar fill (0..1), or null when the state has no bar. */
    fun progress(d: DownloadsPage.Item): Double? = when (d.state) {
        "done", "adding" -> 1.0
        "downloading", "stuck" -> {
            val pct = if (d.total > 0) min(100.0, Math.round(d.done.toDouble() / d.total * 100).toDouble()) else 0.0
            max(pct, if (d.state == "downloading") 3.0 else 0.0) / 100
        }
        else -> null
    }

    enum class Action { Play, Retry }

    fun action(d: DownloadsPage.Item): Action? = when {
        d.state == "done" && d.libraryAlbumId != null -> Action.Play
        d.state == "failed" || d.state == "stuck" -> Action.Retry
        else -> null
    }

    /** `{artist} • {type} • {year}`. */
    fun meta(d: DownloadsPage.Item): String = listOfNotNull(d.artist, d.type, d.year).filter { it.isNotEmpty() }.joinToString(" • ")
}
