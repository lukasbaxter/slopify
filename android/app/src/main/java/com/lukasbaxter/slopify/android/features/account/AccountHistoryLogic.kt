package com.lukasbaxter.slopify.android.features.account

import com.lukasbaxter.slopify.android.core.model.HistoryStats
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/** The pure parts of the Listening history page (web components/History.jsx, UI.md 7.5). */
internal object AccountHistoryLogic {
    /** History.jsx `RANGES`: wire key, chip label key, description suffix key (null for lifetime). */
    enum class Range(val wire: String) {
        Today("today"), Week("week"), FourWeeks("4w"), SixMonths("6m"), Year("year"), All("all");

        /** The chip label. The year chip is the current year number, not translated. */
        fun label(today: LocalDate = LocalDate.now()): String = when (this) {
            Today -> L("today")
            Week -> L("this week")
            FourWeeks -> L("4 weeks")
            SixMonths -> L("6 months")
            Year -> today.year.toString()
            All -> L("lifetime")
        }

        val suffix: String? get() = when (this) {
            Today -> "from today"
            Week -> "from this week"
            FourWeeks -> "from the past 4 weeks"
            SixMonths -> "from the past 6 months"
            Year -> "from this year"
            All -> null
        }

        companion object {
            const val STORAGE_KEY = "conduit.histRange2"
            val Default = FourWeeks
            fun of(wire: String?): Range? = entries.firstOrNull { it.wire == wire }
        }
    }

    /** `t(withRange, {range: t(suffix)})`, or the bare sentence for lifetime. */
    fun description(withRange: String, bare: String, range: Range): String {
        val s = range.suffix ?: return L(bare)
        return L(withRange, "range" to L(s))
    }

    /** Locale number grouping (`toLocaleString(language)`). */
    fun number(n: Double, locale: Locale): String =
        NumberFormat.getNumberInstance(locale).apply { maximumFractionDigits = 2 }.format(n)

    fun number(n: Int, locale: Locale): String = number(n.toDouble(), locale)

    fun streams(n: Int, locale: Locale): String =
        if (n == 1) L("1 stream") else L("{n} streams", "n" to number(n, locale))

    /** `t('{n} minutes', {n: floor(secs / 60)})`. */
    fun minutes(seconds: Double, locale: Locale): String = L("{n} minutes", "n" to number(floor(seconds / 60).toInt(), locale))

    /** History.jsx `hm`: "1h 5m" / "42m". */
    fun hm(secs: Double): String {
        val h = (secs / 3600).toInt()
        val m = ((secs % 3600) / 60).roundToInt()
        return if (h > 0) "${h}h ${m}m" else "${m}m"
    }

    // stat cards

    /** History.jsx `Delta`: null = hidden; else the rounded percentage change. */
    fun delta(now: Int?, before: Int?): Int? {
        if (before == null) return null
        val n = now ?: 0
        if (before == 0 && n == 0) return null
        if (before == 0) return 100
        return ((n - before).toDouble() / before * 100).roundToInt()
    }

    /** `label` is the i18n key. */
    data class StatCard(val label: String, val value: Int, val before: Int?)

    /** The seven cards, in order (History.jsx:377-394). */
    fun cards(s: HistoryStats): List<StatCard> {
        val n = s.numbers
        val p = s.prev
        fun hours(m: Int?) = ((m ?: 0) / 60.0).roundToInt()
        return listOf(
            StatCard("streams", n.streams ?: 0, p?.streams),
            StatCard("minutes streamed", n.minutes ?: 0, p?.minutes),
            StatCard("hours streamed", hours(n.minutes), p?.let { hours(it.minutes) }),
            StatCard("days streamed", n.daysStreamed ?: 0, p?.daysStreamed),
            StatCard("different tracks", n.uniqueTracks ?: 0, p?.uniqueTracks),
            StatCard("different artists", n.uniqueArtists ?: 0, p?.uniqueArtists),
            StatCard("different albums", n.uniqueAlbums ?: 0, p?.uniqueAlbums),
        )
    }

    /** Averages per day with any stream (at least 1 day). */
    fun averages(s: HistoryStats): Pair<Int, Int> {
        val days = max(1, s.perDay.count { it.count > 0 })
        return ((s.numbers.streams ?: 0).toDouble() / days).roundToInt() to ((s.numbers.minutes ?: 0).toDouble() / days).roundToInt()
    }

    // charts

    data class Point(val label: String, val streams: Double, val minutes: Double)

    enum class Bucket { Day, Week, Month }

    /** Days up to 60, weeks up to 200, else months. */
    fun bucketMode(count: Int): Bucket = if (count > 200) Bucket.Month else if (count > 60) Bucket.Week else Bucket.Day

    private fun parseDay(iso: String): LocalDate? {
        val parts = iso.split("-").mapNotNull { it.toIntOrNull() }
        if (parts.size != 3) return null
        return runCatching { LocalDate.of(parts[0], parts[1], parts[2]) }.getOrNull()
    }

    /** History.jsx `bucket`: per day, per week (Monday, "MMM d") or per month ("MMM yy"). */
    fun buckets(days: List<HistoryStats.Day>, locale: Locale): List<Point> {
        val mode = bucketMode(days.size)
        val short = AccountDateFormat.formatter("MMMd", locale)
        val month = AccountDateFormat.formatter("MMMyy", locale)
        if (mode == Bucket.Day) {
            return days.map { d -> Point(parseDay(d.day)?.let { short.format(it) } ?: d.day, d.count.toDouble(), d.minutes.toDouble()) }
        }
        val order = ArrayList<String>()
        val acc = HashMap<String, Point>()
        for (d in days) {
            val dt = parseDay(d.day) ?: continue
            val key: String
            val label: String
            if (mode == Bucket.Month) {
                key = String.format(Locale.ROOT, "%04d-%02d", dt.year, dt.monthValue)
                label = month.format(dt)
            } else {
                // JS: (getDay() + 6) % 7 days back = the Monday of that week.
                val monday = dt.minusDays((dt.dayOfWeek.value - 1).toLong())
                key = monday.toString()
                label = short.format(monday)
            }
            val cur = acc[key] ?: Point(label, 0.0, 0.0).also { order += key }
            acc[key] = cur.copy(streams = cur.streams + d.count, minutes = cur.minutes + d.minutes)
        }
        return order.map { acc.getValue(it) }
    }

    /** Running sums ("Cumulative"). */
    fun cumulative(pts: List<Point>): List<Point> {
        var a = 0.0
        var b = 0.0
        return pts.map { p -> a += p.streams; b += p.minutes; Point(p.label, a, b) }
    }

    /** History.jsx `ticksFor`: 0 to a rounded max in about 3 steps of 1/2/2.5/5/10 x 10^k. */
    fun ticks(max: Double): List<Double> {
        if (max <= 0) return listOf(0.0, 1.0)
        val raw = max / 3
        val mag = 10.0.pow(floor(log10(raw)))
        val step = listOf(1.0, 2.0, 2.5, 5.0, 10.0).map { it * mag }.firstOrNull { it >= raw } ?: (mag * 10)
        val out = ArrayList<Double>()
        var v = 0.0
        while (v <= max + step * 0.999) {
            out += Math.round(v * 100) / 100.0
            v += step
        }
        return out
    }

    /** Indices with an x label: every `ceil(n/8)`-th, plus the last; none for a single point. */
    fun xLabelIndices(n: Int): List<Int> {
        if (n <= 1) return emptyList()
        val every = max(1, kotlin.math.ceil(n / 8.0).toInt())
        return (0 until n).filter { it % every == 0 || it == n - 1 }
    }

    /** The point under a finger at `x` in a plot running `plotMinX..plotMaxX` (clamped). */
    fun scrubIndex(x: Double, plotMinX: Double, plotMaxX: Double, count: Int): Int? {
        if (count <= 0) return null
        if (count == 1 || plotMaxX <= plotMinX) return 0
        val i = ((x - plotMinX) / (plotMaxX - plotMinX) * (count - 1)).roundToInt()
        return min(count - 1, max(0, i))
    }

    // clocks

    /** Wedge radius fraction (0..1) per hour: value / max. */
    fun clockFractions(values: List<Double>): List<Double> {
        val m = max(1.0, values.maxOrNull() ?: 0.0)
        return values.map { max(0.0, it / m) }
    }

    /** "13:00 - 14:00". */
    fun hourLabel(i: Int): String = String.format(Locale.ROOT, "%02d:00 - %02d:00", i, (i + 1) % 24)

    // recent streams

    /** History.jsx `fromNow`, seconds ago. */
    fun fromNow(seconds: Double): String {
        val s = max(0.0, floor(seconds))
        return when {
            s < 45 -> L("a few seconds ago")
            s < 90 -> L("a minute ago")
            s < 2700 -> L("{n} minutes ago", "n" to (s / 60).roundToInt())
            s < 5400 -> L("an hour ago")
            s < 79200 -> L("{n} hours ago", "n" to (s / 3600).roundToInt())
            s < 129600 -> L("a day ago")
            s < 2246400 -> L("{n} days ago", "n" to (s / 86400).roundToInt())
            s < 3888000 -> L("a month ago")
            s < 27993600 -> L("{n} months ago", "n" to (s / 2592000).roundToInt())
            s < 47260800 -> L("a year ago")
            else -> {
                val y = (s / 31536000).roundToInt()
                if (y == 1) L("1 year ago") else L("{n} years ago", "n" to y)
            }
        }
    }

    data class DayGroup<Row>(val day: String, val rows: List<Row>)

    /** Consecutive rows on the same calendar day ("MMMM d, yyyy" in the locale), in the given order. */
    fun <Row> groupByDay(rows: List<Row>, atMs: (Row) -> Double, locale: Locale, zone: ZoneId = ZoneId.systemDefault()): List<DayGroup<Row>> {
        val f = AccountDateFormat.formatter("MMMMdyyyy", locale)
        val out = ArrayList<DayGroup<Row>>()
        for (r in rows) {
            val day = f.format(Instant.ofEpochMilli(atMs(r).toLong()).atZone(zone).toLocalDate())
            val last = out.lastOrNull()
            if (last?.day == day) out[out.size - 1] = last.copy(rows = last.rows + r) else out += DayGroup(day, listOf(r))
        }
        return out
    }

    /** Second line of a recent row: artist • album. */
    fun recentSubtitle(t: Track): String = listOf(t.artist, t.album).filter { it.isNotEmpty() }.joinToString(" • ")
}

/** Localised date patterns from a skeleton (Android's best pattern; a fixed English one on the JVM). */
internal object AccountDateFormat {
    private val fallback = mapOf("MMMd" to "MMM d", "MMMyy" to "MMM yy", "MMMMdyyyy" to "MMMM d, yyyy")

    fun pattern(skeleton: String, locale: Locale): String =
        runCatching { android.text.format.DateFormat.getBestDateTimePattern(locale, skeleton) }.getOrNull()
            ?.takeIf { it.isNotEmpty() } ?: fallback[skeleton] ?: skeleton

    fun formatter(skeleton: String, locale: Locale): DateTimeFormatter =
        runCatching { DateTimeFormatter.ofPattern(pattern(skeleton, locale), locale) }.getOrNull()
            ?: DateTimeFormatter.ofPattern(fallback[skeleton] ?: "yyyy-MM-dd", locale)
}
