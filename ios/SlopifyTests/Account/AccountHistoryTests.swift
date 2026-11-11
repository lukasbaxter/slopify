import XCTest
@testable import Slopify

final class AccountHistoryTests: XCTestCase {
    private let utc: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }()
    private let en = Locale(identifier: "en_US")

    // Shape from docs/API.md §15.2 / server social.ts (all-time: prev null).
    func testDecodesStats() throws {
        let json = #"""
        {"connected":true,"total":15234,"sources":{},"streams":120,"minutes":410,"daysStreamed":6,"uniqueTracks":88,"uniqueArtists":40,"uniqueAlbums":52,
         "topTracks":[{"id":"t","name":"Song","artist":"A","artistId":null,"albumId":"al","count":3,"seconds":383.5}],
         "topArtists":[{"artistId":"a","name":"A","count":3,"seconds":900}],
         "topAlbums":[{"albumId":"al","name":"Al","artist":"A","count":2,"seconds":10}],
         "topGenres":[{"id":"Rock","name":"Rock"}],"prev":null,
         "byHour":[0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,2],"byHourSeconds":[0,0,0,0,0,0,0,0,0,0,0,0,200,0,0,0,0,0,0,0,0,0,0,400],
         "perDay":[{"day":"2026-11-01","count":12,"minutes":40}]}
        """#
        let s = try JSONDecoder().decode(HistoryStats.self, from: Data(json.utf8))
        XCTAssertTrue(s.connected)
        XCTAssertEqual(s.total, 15234)
        XCTAssertEqual(s.numbers.minutes, 410)
        XCTAssertNil(s.prev)
        XCTAssertEqual(s.topTracks.first?.seconds, 383.5)
        XCTAssertNil(s.topTracks.first?.artistId)
        XCTAssertEqual(s.perDay.first?.count, 12)
        XCTAssertEqual(s.byHourSeconds?[23], 400)
        let spotify = try JSONDecoder().decode(HistoryStats.self, from: Data(#"{"connected":false,"sources":{"spotify":7}}"#.utf8))
        XCTAssertEqual(spotify.spotify, 7)
        XCTAssertEqual(spotify.byHour.count, 24)
        XCTAssertTrue(spotify.topTracks.isEmpty)
    }

    func testDelta() {
        XCTAssertNil(AccountHistoryLogic.delta(now: 5, before: nil))
        XCTAssertNil(AccountHistoryLogic.delta(now: 0, before: 0))
        XCTAssertEqual(AccountHistoryLogic.delta(now: 3, before: 0), 100)
        XCTAssertEqual(AccountHistoryLogic.delta(now: 118, before: 100), 18)
        XCTAssertEqual(AccountHistoryLogic.delta(now: 97, before: 100), -3)
        XCTAssertEqual(AccountHistoryLogic.delta(now: 100, before: 100), 0)
    }

    func testCardsAndAverages() {
        let s = HistoryStats(connected: true, numbers: .init(streams: 10, minutes: 150, daysStreamed: 2),
                                    prev: .init(streams: 5, minutes: 30),
                                    perDay: [.init(day: "2026-11-01", count: 6, minutes: 100), .init(day: "2026-11-02", count: 0, minutes: 0),
                                             .init(day: "2026-11-03", count: 4, minutes: 50)])
        let cards = AccountHistoryLogic.cards(s)
        XCTAssertEqual(cards.map(\.label), ["streams", "minutes streamed", "hours streamed", "days streamed", "different tracks", "different artists", "different albums"])
        XCTAssertEqual(cards[2].value, 3)   // round(150 / 60)
        XCTAssertEqual(cards[2].before, 1)  // round(30 / 60) = round(.5) = 1, as Math.round
        let avg = AccountHistoryLogic.averages(s)
        XCTAssertEqual(avg.streams, 5)
        XCTAssertEqual(avg.minutes, 75)
    }

    func testTicksMatchJS() {
        // Values computed with History.jsx ticksFor.
        XCTAssertEqual(AccountHistoryLogic.ticks(max: 0), [0, 1])
        XCTAssertEqual(AccountHistoryLogic.ticks(max: 1), [0, 0.5, 1])
        XCTAssertEqual(AccountHistoryLogic.ticks(max: 7), [0, 2.5, 5, 7.5])
        XCTAssertEqual(AccountHistoryLogic.ticks(max: 40), [0, 20, 40])
        XCTAssertEqual(AccountHistoryLogic.ticks(max: 410), [0, 200, 400, 600])
    }

    func testXLabelsAndScrub() {
        XCTAssertEqual(AccountHistoryLogic.xLabelIndices(1), [])
        XCTAssertEqual(AccountHistoryLogic.xLabelIndices(5), [0, 1, 2, 3, 4])
        XCTAssertEqual(AccountHistoryLogic.xLabelIndices(28), [0, 4, 8, 12, 16, 20, 24, 27])
        XCTAssertEqual(AccountHistoryLogic.scrubIndex(x: 0, plotMinX: 44, plotMaxX: 344, count: 11), 0)
        XCTAssertEqual(AccountHistoryLogic.scrubIndex(x: 194, plotMinX: 44, plotMaxX: 344, count: 11), 5)
        XCTAssertEqual(AccountHistoryLogic.scrubIndex(x: 999, plotMinX: 44, plotMaxX: 344, count: 11), 10)
        XCTAssertEqual(AccountHistoryLogic.scrubIndex(x: 10, plotMinX: 44, plotMaxX: 344, count: 1), 0)
        XCTAssertNil(AccountHistoryLogic.scrubIndex(x: 10, plotMinX: 44, plotMaxX: 344, count: 0))
    }

    func testBucketsByDayWeekMonth() {
        func days(_ n: Int) -> [HistoryStats.Day] {
            (0..<n).map { i in
                let d = utc.date(byAdding: .day, value: i, to: utc.date(from: DateComponents(year: 2026, month: 1, day: 5))!)! // a Monday
                let c = utc.dateComponents([.year, .month, .day], from: d)
                return .init(day: String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!), count: 1, minutes: 2)
            }
        }
        let d = AccountHistoryLogic.buckets(days(3), locale: en, calendar: utc)
        XCTAssertEqual(d.map(\.label), ["Jan 5", "Jan 6", "Jan 7"])
        let w = AccountHistoryLogic.buckets(days(70), locale: en, calendar: utc)
        XCTAssertEqual(w.count, 10)
        XCTAssertEqual(w.first?.label, "Jan 5")
        XCTAssertEqual(w.first?.streams, 7)
        XCTAssertEqual(w.first?.minutes, 14)
        let m = AccountHistoryLogic.buckets(days(201), locale: en, calendar: utc)
        XCTAssertEqual(m.first?.label, "Jan 26")
        XCTAssertEqual(m.first?.streams, 27)
        XCTAssertEqual(AccountHistoryLogic.cumulative(d).map(\.streams), [1, 2, 3])
    }

    func testFromNow() {
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 10), "a few seconds ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 60), "a minute ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 600), "10 minutes ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 4000), "an hour ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 7200), "2 hours ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 100_000), "a day ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 3 * 86400), "3 days ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 30 * 86400), "a month ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 90 * 86400), "3 months ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 400 * 86400), "a year ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: 600 * 86400), "2 years ago")
        XCTAssertEqual(AccountHistoryLogic.fromNow(seconds: -5), "a few seconds ago")
    }

    func testFormattingAndRanges() {
        XCTAssertEqual(AccountHistoryLogic.number(15234, locale: en), "15,234")
        XCTAssertEqual(AccountHistoryLogic.streams(1, locale: en), "1 stream")
        XCTAssertEqual(AccountHistoryLogic.streams(1200, locale: en), "1,200 streams")
        XCTAssertEqual(AccountHistoryLogic.minutes(seconds: 119, locale: en), "1 minutes")
        XCTAssertEqual(AccountHistoryLogic.hm(3900), "1h 5m")
        XCTAssertEqual(AccountHistoryLogic.hm(1500), "25m")
        XCTAssertEqual(AccountHistoryLogic.hourLabel(23), "23:00 - 00:00")
        XCTAssertEqual(AccountHistoryLogic.clockFractions([0, 2, 4]), [0, 0.5, 1])
        XCTAssertEqual(AccountHistoryLogic.clockFractions([0, 0]), [0, 0])
        XCTAssertEqual(AccountHistoryLogic.Range.year.label(now: utc.date(from: DateComponents(year: 2026, month: 3))!, calendar: utc), "2026")
        XCTAssertEqual(AccountHistoryLogic.Range.allCases.map(\.rawValue), ["today", "week", "4w", "6m", "year", "all"])
        XCTAssertEqual(AccountHistoryLogic.description("Your top tracks {range}", bare: "Your top tracks", range: .fourWeeks), "Your top tracks from the past 4 weeks")
        XCTAssertEqual(AccountHistoryLogic.description("Your top tracks {range}", bare: "Your top tracks", range: .all), "Your top tracks")
    }

    func testGroupByDay() {
        let ts: [Double] = [utc.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 22))!, utc.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 1))!,
                            utc.date(from: DateComponents(year: 2026, month: 11, day: 8, hour: 5))!].map(\.timeIntervalSince1970)
        let g = AccountHistoryLogic.groupByDay(ts, at: { Date(timeIntervalSince1970: $0) }, locale: en, calendar: utc)
        XCTAssertEqual(g.map(\.day), ["November 9, 2026", "November 8, 2026"])
        XCTAssertEqual(g.map(\.rows.count), [2, 1])
    }
}
