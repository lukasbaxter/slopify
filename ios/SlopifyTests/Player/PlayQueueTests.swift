import XCTest
@testable import Slopify

final class PlayQueueTests: XCTestCase {
    private var rng = SplitMix64(seed: 7)

    private func ids(_ q: PlayQueue) -> [String] { q.entries.map(\.track.id) }

    func testStartUnshuffledKeepsOrderAndIndex() {
        var q = PlayQueue()
        q.start(tracks("a", "b", "c"), at: 1, context: "al1", using: &rng)
        XCTAssertEqual(ids(q), ["a", "b", "c"])
        XCTAssertEqual(q.index, 1)
        XCTAssertEqual(q.context, "al1")
    }

    func testStartShuffledPutsChosenFirst() {
        var q = PlayQueue(); q.shuffle = .on
        q.start(tracks("a", "b", "c", "d", "e"), at: 3, context: nil, using: &rng)
        XCTAssertEqual(q.index, 0)
        XCTAssertEqual(q.entries[0].track.id, "d")
        XCTAssertEqual(Set(ids(q)), ["a", "b", "c", "d", "e"])
        XCTAssertEqual(q.original.map(\.track.id), ["a", "b", "c", "d", "e"])
    }

    func testAddToQueueGoesAfterCurrentAndEarlierQueued() {
        var q = PlayQueue()
        q.start(tracks("a", "b", "c"), at: 0, context: nil, using: &rng)
        q.add(tracks("x"))
        q.add(tracks("y", "z"))
        XCTAssertEqual(ids(q), ["a", "x", "y", "z", "b", "c"])
        XCTAssertEqual(q.entries.map(\.queued), [false, true, true, true, false, false])
    }

    func testAddToEmptyQueueBecomesQueue() {
        var q = PlayQueue()
        XCTAssertTrue(q.add(tracks("x", "y")))
        XCTAssertEqual(ids(q), ["x", "y"])
        XCTAssertEqual(q.entries.map(\.queued), [false, false])
    }

    func testInsertNextGoesStraightAfterCurrent() {
        var q = PlayQueue()
        q.start(tracks("a", "b"), at: 0, context: nil, using: &rng)
        q.add(tracks("x"))
        q.insertNext(tracks("n"))
        XCTAssertEqual(ids(q), ["a", "n", "x", "b"])
    }

    func testRemoveNeverCurrentAndShiftsIndex() {
        var q = PlayQueue()
        q.start(tracks("a", "b", "c", "d"), at: 2, context: nil, using: &rng)
        XCTAssertFalse(q.remove(at: 2))
        XCTAssertTrue(q.remove(at: 0))
        XCTAssertEqual(ids(q), ["b", "c", "d"])
        XCTAssertEqual(q.index, 1)
        XCTAssertEqual(q.current?.track.id, "c")
    }

    func testMoveOnlyUpcoming() {
        var q = PlayQueue()
        q.start(tracks("a", "b", "c", "d"), at: 1, context: nil, using: &rng)
        XCTAssertFalse(q.move(from: 0, to: 3))
        XCTAssertFalse(q.move(from: 2, to: 1))
        XCTAssertTrue(q.move(from: 3, to: 2))
        XCTAssertEqual(ids(q), ["a", "b", "d", "c"])
    }

    func testClearQueuedOnlyAfterCurrent() {
        var q = PlayQueue()
        q.start(tracks("a", "b"), at: 0, context: nil, using: &rng)
        q.add(tracks("x", "y"))
        q.clearQueued()
        XCTAssertEqual(ids(q), ["a", "b"])
    }

    func testShuffleThenUnshuffleKeepsCurrent() {
        var q = PlayQueue()
        q.start(tracks("a", "b", "c", "d", "e"), at: 2, context: nil, using: &rng)
        q.setShuffle(.on, using: &rng)
        XCTAssertEqual(q.index, 0)
        XCTAssertEqual(q.current?.track.id, "c")
        q.index = 2
        let playing = q.current!.track.id
        q.setShuffle(.off, using: &rng)
        XCTAssertEqual(ids(q), ["a", "b", "c", "d", "e"])
        XCTAssertEqual(q.current?.track.id, playing)
    }

    func testUnshuffleDropsSmartPicks() {
        var q = PlayQueue()
        q.start(tracks("a", "b", "c", "d", "e", "f", "g"), at: 0, context: nil, using: &rng)
        q.setShuffle(.smart, using: &rng)
        XCTAssertEqual(q.blendSmart(tracks("r1", "r2")), 2)
        XCTAssertEqual(q.entries.filter(\.rec).count, 2)
        XCTAssertTrue(q.entries[4].rec)   // after every third upcoming song
        q.setShuffle(.off, using: &rng)
        XCTAssertFalse(q.entries.contains { $0.rec })
        XCTAssertEqual(q.entries.count, 7)
    }

    func testRestartShuffledNeverOpensOnLastSong() {
        for seed in 0..<30 {
            var r = SplitMix64(seed: UInt64(seed))
            var q = PlayQueue(); q.shuffle = .on
            q.start(tracks("a", "b", "c"), at: 0, context: nil, using: &r)
            q.index = 2
            let last = q.current!.track.id
            q.restartOrder(using: &r)
            XCTAssertEqual(q.index, 0)
            XCTAssertNotEqual(q.entries[0].track.id, last)
        }
    }

    func testAdvanceRules() {
        var q = PlayQueue()
        q.start(tracks("a", "b"), at: 0, context: "al1", using: &rng)
        XCTAssertEqual(q.advance(auto: true, sleepEndOfTrack: false), .skip(1))
        q.index = 1
        XCTAssertEqual(q.advance(auto: true, sleepEndOfTrack: false), .autoplay(orRestart: true))
        q.repeatMode = .all
        XCTAssertEqual(q.advance(auto: true, sleepEndOfTrack: false), .restart)
        q.repeatMode = .one
        XCTAssertEqual(q.advance(auto: true, sleepEndOfTrack: false), .replay)
        q.index = 0
        XCTAssertEqual(q.advance(auto: false, sleepEndOfTrack: false), .skip(1), "next skips even with repeat one")
        XCTAssertEqual(q.advance(auto: true, sleepEndOfTrack: false), .replay)
        q.repeatMode = .off; q.context = "artist:ar9"; q.index = 1
        XCTAssertEqual(q.advance(auto: true, sleepEndOfTrack: false), .moreOfArtist("ar9"))
        q.context = nil
        XCTAssertEqual(q.advance(auto: true, sleepEndOfTrack: false), .autoplay(orRestart: false))
    }

    func testSleepEndOfTrackParksOnNext() {
        var q = PlayQueue()
        q.start(tracks("a", "b"), at: 0, context: nil, using: &rng)
        XCTAssertEqual(q.advance(auto: true, sleepEndOfTrack: true), .sleepStop(index: 1))
        q.index = 1
        XCTAssertEqual(q.advance(auto: true, sleepEndOfTrack: true), .sleepStop(index: 1))
        q.repeatMode = .all
        XCTAssertEqual(q.advance(auto: true, sleepEndOfTrack: true), .sleepStop(index: 0))
        XCTAssertEqual(q.advance(auto: false, sleepEndOfTrack: true), .restart, "a manual next is not the timer")
    }

    func testPreviousRule() {
        var q = PlayQueue()
        q.start(tracks("a", "b"), at: 1, context: nil, using: &rng)
        XCTAssertEqual(q.previous(position: 3.5), .replay)
        XCTAssertEqual(q.previous(position: 2), .skip(0))
        q.index = 0
        XCTAssertEqual(q.previous(position: 1), .replay, "first song restarts")
    }

    func testAutoplayAppendDropsSeedAndKnown() {
        var q = PlayQueue()
        q.start(tracks("a", "b"), at: 1, context: nil, using: &rng)
        let n = q.appendAutoplay(tracks("b", "a", "c", "d"), seedId: "b", using: &rng)
        XCTAssertEqual(n, 2)
        XCTAssertEqual(ids(q), ["a", "b", "c", "d"], "mix order kept without smart shuffle")
    }

    func testAutoplayFallbackAllowsRepeatsButNotSeed() {
        var q = PlayQueue()
        q.start(tracks("a", "b"), at: 1, context: nil, using: &rng)
        XCTAssertEqual(q.appendAutoplay(tracks("b", "a"), seedId: "b", using: &rng), 0)
        XCTAssertEqual(q.appendAutoplay(tracks("b", "a"), seedId: "b", fallbackAllowNonSeed: true, using: &rng), 1)
        XCTAssertEqual(ids(q), ["a", "b", "a"])
    }

    func testEarlyExtensionWindow() {
        var q = PlayQueue()
        q.start(tracks("a", "b", "c", "d"), at: 0, context: nil, using: &rng)
        XCTAssertFalse(q.wantsEarlyExtension(remoteActive: false))
        q.index = 2
        XCTAssertTrue(q.wantsEarlyExtension(remoteActive: false))
        q.repeatMode = .all
        XCTAssertFalse(q.wantsEarlyExtension(remoteActive: false))
        q.repeatMode = .off; q.context = "artist:x"
        XCTAssertFalse(q.wantsEarlyExtension(remoteActive: false))
    }

    func testUpcoming() {
        var q = PlayQueue()
        q.start(tracks("a", "b"), at: 1, context: nil, using: &rng)
        XCTAssertNil(q.upcomingIndex)
        q.repeatMode = .all
        XCTAssertEqual(q.upcomingIndex, 0)
        q.shuffle = .on
        XCTAssertNil(q.upcomingIndex, "a shuffled restart reshuffles first")
        q.repeatMode = .one
        XCTAssertEqual(q.upcomingIndex, 1)
    }

    func testTransferPayload() {
        var q = PlayQueue()
        q.start(tracks("a", "b", "c"), at: 1, context: "pl_1", using: &rng)
        q.add(tracks("x"))
        let t = q.transfer(position: 12, playing: true, deviceId: "local")
        XCTAssertEqual(t.trackIds, ["a", "b", "x", "c"])
        XCTAssertEqual(t.queued, [false, false, true, false])
        XCTAssertEqual(t.index, 1)
        XCTAssertEqual(t.ctx, "pl_1")
        XCTAssertNil(t.original)
        q.setShuffle(.on, using: &rng)
        XCTAssertEqual(q.transfer(position: 0, playing: false, deviceId: "local").original, ["a", "b", "x", "c"])
    }

    func testMarkedCarriesFlagsOverSkippedIds() {
        let rows = [QueueEntry].marked(tracks("a", "c"), ids: ["a", "b", "c"], flags: [false, true, true])
        XCTAssertEqual(rows.map(\.queued), [false, true])
    }

    func testCodableRoundTrip() throws {
        var q = PlayQueue(); q.repeatMode = .all
        q.start(tracks("a", "b"), at: 1, context: "x", using: &rng)
        let back = try JSONDecoder().decode(PlayQueue.self, from: JSONEncoder().encode(q))
        XCTAssertEqual(back, q)
    }
}
