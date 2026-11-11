package com.lukasbaxter.slopify.android.features.account

import com.lukasbaxter.slopify.android.core.model.HistoryStats
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale

class AccountHistoryTest {
    private val en = Locale.US
    private val utc: ZoneId = ZoneOffset.UTC

    // Shape from docs/API.md §15.2 / server social.ts (all-time: prev null).
    @Test fun decodesStats() {
        val json = """
        {"connected":true,"total":15234,"sources":{},"streams":120,"minutes":410,"daysStreamed":6,"uniqueTracks":88,"uniqueArtists":40,"uniqueAlbums":52,
         "topTracks":[{"id":"t","name":"Song","artist":"A","artistId":null,"albumId":"al","count":3,"seconds":383.5}],
         "topArtists":[{"artistId":"a","name":"A","count":3,"seconds":900}],
         "topAlbums":[{"albumId":"al","name":"Al","artist":"A","count":2,"seconds":10}],
         "topGenres":[{"id":"Rock","name":"Rock"}],"prev":null,
         "byHour":[0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,2],"byHourSeconds":[0,0,0,0,0,0,0,0,0,0,0,0,200,0,0,0,0,0,0,0,0,0,0,400],
         "perDay":[{"day":"2026-11-01","count":12,"minutes":40}]}
        """
        val s = SlopifyJson.decodeFromString(HistoryStats.reader, json)
        assertTrue(s.connected)
        assertEquals(15234, s.total)
        assertEquals(410, s.numbers.minutes)
        assertNull(s.prev)
        assertEquals(383.5, s.topTracks.first().seconds, 0.0)
        assertNull(s.topTracks.first().artistId)
        assertEquals(12, s.perDay.first().count)
        assertEquals(400.0, s.byHourSeconds!![23], 0.0)
        val spotify = SlopifyJson.decodeFromString(HistoryStats.reader, """{"connected":false,"sources":{"spotify":7}}""")
        assertEquals(7, spotify.spotify)
        assertEquals(24, spotify.byHour.size)
        assertTrue(spotify.topTracks.isEmpty())
    }

    @Test fun delta() {
        assertNull(AccountHistoryLogic.delta(5, null))
        assertNull(AccountHistoryLogic.delta(0, 0))
        assertEquals(100, AccountHistoryLogic.delta(3, 0))
        assertEquals(18, AccountHistoryLogic.delta(118, 100))
        assertEquals(-3, AccountHistoryLogic.delta(97, 100))
        assertEquals(0, AccountHistoryLogic.delta(100, 100))
    }

    @Test fun cardsAndAverages() {
        val s = HistoryStats(
            connected = true, numbers = HistoryStats.Numbers(streams = 10, minutes = 150, daysStreamed = 2),
            prev = HistoryStats.Numbers(streams = 5, minutes = 30),
            perDay = listOf(HistoryStats.Day("2026-11-01", 6, 100), HistoryStats.Day("2026-11-02", 0, 0), HistoryStats.Day("2026-11-03", 4, 50)),
        )
        val cards = AccountHistoryLogic.cards(s)
        assertEquals(
            listOf("streams", "minutes streamed", "hours streamed", "days streamed", "different tracks", "different artists", "different albums"),
            cards.map { it.label },
        )
        assertEquals(3, cards[2].value) // round(150 / 60)
        assertEquals(1, cards[2].before) // round(30 / 60) = round(.5) = 1, as Math.round
        assertEquals(5 to 75, AccountHistoryLogic.averages(s))
    }

    @Test fun ticksMatchJS() {
        // Values computed with History.jsx ticksFor.
        assertEquals(listOf(0.0, 1.0), AccountHistoryLogic.ticks(0.0))
        assertEquals(listOf(0.0, 0.5, 1.0), AccountHistoryLogic.ticks(1.0))
        assertEquals(listOf(0.0, 2.5, 5.0, 7.5), AccountHistoryLogic.ticks(7.0))
        assertEquals(listOf(0.0, 20.0, 40.0), AccountHistoryLogic.ticks(40.0))
        assertEquals(listOf(0.0, 200.0, 400.0, 600.0), AccountHistoryLogic.ticks(410.0))
    }

    @Test fun xLabelsAndScrub() {
        assertEquals(emptyList<Int>(), AccountHistoryLogic.xLabelIndices(1))
        assertEquals(listOf(0, 1, 2, 3, 4), AccountHistoryLogic.xLabelIndices(5))
        assertEquals(listOf(0, 4, 8, 12, 16, 20, 24, 27), AccountHistoryLogic.xLabelIndices(28))
        assertEquals(0, AccountHistoryLogic.scrubIndex(0.0, 44.0, 344.0, 11))
        assertEquals(5, AccountHistoryLogic.scrubIndex(194.0, 44.0, 344.0, 11))
        assertEquals(10, AccountHistoryLogic.scrubIndex(999.0, 44.0, 344.0, 11))
        assertEquals(0, AccountHistoryLogic.scrubIndex(10.0, 44.0, 344.0, 1))
        assertNull(AccountHistoryLogic.scrubIndex(10.0, 44.0, 344.0, 0))
    }

    @Test fun bucketsByDayWeekMonth() {
        fun days(n: Int) = (0 until n).map { i -> HistoryStats.Day(LocalDate.of(2026, 1, 5).plusDays(i.toLong()).toString(), 1, 2) } // Jan 5 is a Monday
        val d = AccountHistoryLogic.buckets(days(3), en)
        assertEquals(listOf("Jan 5", "Jan 6", "Jan 7"), d.map { it.label })
        val w = AccountHistoryLogic.buckets(days(70), en)
        assertEquals(10, w.size)
        assertEquals("Jan 5", w.first().label)
        assertEquals(7.0, w.first().streams, 0.0)
        assertEquals(14.0, w.first().minutes, 0.0)
        val m = AccountHistoryLogic.buckets(days(201), en)
        assertEquals("Jan 26", m.first().label)
        assertEquals(27.0, m.first().streams, 0.0)
        assertEquals(listOf(1.0, 2.0, 3.0), AccountHistoryLogic.cumulative(d).map { it.streams })
    }

    @Test fun fromNow() {
        assertEquals("a few seconds ago", AccountHistoryLogic.fromNow(10.0))
        assertEquals("a minute ago", AccountHistoryLogic.fromNow(60.0))
        assertEquals("10 minutes ago", AccountHistoryLogic.fromNow(600.0))
        assertEquals("an hour ago", AccountHistoryLogic.fromNow(4000.0))
        assertEquals("2 hours ago", AccountHistoryLogic.fromNow(7200.0))
        assertEquals("a day ago", AccountHistoryLogic.fromNow(100_000.0))
        assertEquals("3 days ago", AccountHistoryLogic.fromNow(3 * 86400.0))
        assertEquals("a month ago", AccountHistoryLogic.fromNow(30 * 86400.0))
        assertEquals("3 months ago", AccountHistoryLogic.fromNow(90 * 86400.0))
        assertEquals("a year ago", AccountHistoryLogic.fromNow(400 * 86400.0))
        assertEquals("2 years ago", AccountHistoryLogic.fromNow(600 * 86400.0))
        assertEquals("a few seconds ago", AccountHistoryLogic.fromNow(-5.0))
    }

    @Test fun formattingAndRanges() {
        assertEquals("15,234", AccountHistoryLogic.number(15234, en))
        assertEquals("1 stream", AccountHistoryLogic.streams(1, en))
        assertEquals("1,200 streams", AccountHistoryLogic.streams(1200, en))
        assertEquals("1 minutes", AccountHistoryLogic.minutes(119.0, en))
        assertEquals("1h 5m", AccountHistoryLogic.hm(3900.0))
        assertEquals("25m", AccountHistoryLogic.hm(1500.0))
        assertEquals("23:00 - 00:00", AccountHistoryLogic.hourLabel(23))
        assertEquals(listOf(0.0, 0.5, 1.0), AccountHistoryLogic.clockFractions(listOf(0.0, 2.0, 4.0)))
        assertEquals(listOf(0.0, 0.0), AccountHistoryLogic.clockFractions(listOf(0.0, 0.0)))
        assertEquals("2026", AccountHistoryLogic.Range.Year.label(LocalDate.of(2026, 3, 1)))
        assertEquals(listOf("today", "week", "4w", "6m", "year", "all"), AccountHistoryLogic.Range.entries.map { it.wire })
        assertEquals(AccountHistoryLogic.Range.FourWeeks, AccountHistoryLogic.Range.of(null) ?: AccountHistoryLogic.Range.Default)
        assertEquals(AccountHistoryLogic.Range.SixMonths, AccountHistoryLogic.Range.of("6m"))
        assertEquals(
            "Your top tracks from the past 4 weeks",
            AccountHistoryLogic.description("Your top tracks {range}", "Your top tracks", AccountHistoryLogic.Range.FourWeeks),
        )
        assertEquals("Your top tracks", AccountHistoryLogic.description("Your top tracks {range}", "Your top tracks", AccountHistoryLogic.Range.All))
    }

    @Test fun groupByDay() {
        fun ms(d: Int, h: Int) = LocalDate.of(2026, 11, d).atTime(h, 0).toInstant(ZoneOffset.UTC).toEpochMilli().toDouble()
        val ts = listOf(ms(9, 22), ms(9, 1), ms(8, 5))
        val g = AccountHistoryLogic.groupByDay(ts, { it }, en, utc)
        assertEquals(listOf("November 9, 2026", "November 8, 2026"), g.map { it.day })
        assertEquals(listOf(2, 1), g.map { it.rows.size })
    }
}
